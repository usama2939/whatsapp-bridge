/**
 * WA Chat Bridge — WhatsApp gateway (Baileys).
 *
 * Responsibilities:
 *   - Hold a WhatsApp Web session (QR pairing, persisted auth).
 *   - Expose a small, token-protected HTTP API for the WordPress plugin:
 *       GET  /status  -> { status, qr, me }
 *       POST /send    -> { to, text }  (forwards a visitor message to your WhatsApp)
 *       POST /logout  -> unlink the session
 *   - Watch your WhatsApp replies and POST them back to WordPress, so a reply
 *     you send by *quoting* the forwarded message shows up in the visitor's widget.
 *
 * Requires Node.js >= 18 (uses global fetch).
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const pino = require('pino');
const QR = require('qrcode');
const { Boom } = require('@hapi/boom');
const {
	default: makeWASocket,
	useMultiFileAuthState,
	fetchLatestBaileysVersion,
	DisconnectReason,
	jidNormalizedUser,
} = require('@whiskeysockets/baileys');

/* ------------------------------------------------------------------ config */

const PORT = parseInt(process.env.PORT || '3001', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const WP_WEBHOOK_URL = process.env.WP_WEBHOOK_URL || ''; // e.g. https://site.com/wp-json/wacb/v1/incoming
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');

if (!AUTH_TOKEN) {
	console.error('FATAL: AUTH_TOKEN is required (must match the WordPress "Shared secret").');
	process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

/* ------------------------------------------------------------------- state */

let sock = null;
let status = 'connecting'; // connecting | qr | connected | disconnected
let latestQR = null; // data URL
let me = ''; // human phone number
let lastCode = ''; // most recent visitor code we forwarded (plain-reply fallback)
let reconnectAttempts = 0; // for exponential reconnect backoff
let reconnectTimer = null;  // exactly one pending reconnect at a time
let starting = false;       // guard against concurrent startSock() calls

const CODE_RE = /\[([A-Z0-9]{4,20})\]/; // matches the [ABC123] tag we embed

/* --------------------------------------------------------- WhatsApp socket */

/** Schedule a single reconnect (never stack them — that causes 440 storms). */
function scheduleReconnect(delay) {
	if (reconnectTimer) { return; }
	reconnectTimer = setTimeout(() => { reconnectTimer = null; startSock(); }, delay);
}

/** Fully tear down the current socket so two sockets never share the creds. */
function teardownSock() {
	if (!sock) { return; }
	try { sock.ev.removeAllListeners(); } catch (e) { /* noop */ }
	try { sock.end(undefined); } catch (e) { /* noop */ }
	sock = null;
}

async function startSock() {
	if (starting) { return; }
	starting = true;
	try {
		teardownSock(); // ensure only ONE live socket exists at any time

		const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
		const { version } = await fetchLatestBaileysVersion();

		sock = makeWASocket({
			version,
			auth: state,
			logger: pino({ level: 'silent' }),
			printQRInTerminal: false,
			browser: ['WA Chat Bridge', 'Chrome', '1.0.0'],
			markOnlineOnConnect: false,
			syncFullHistory: false,
		});

		sock.ev.on('creds.update', saveCreds);
		sock.ev.on('messages.upsert', onMessages);
		sock.ev.on('connection.update', onConnectionUpdate);
	} finally {
		starting = false;
	}
}

async function onConnectionUpdate(u) {
	const { connection, lastDisconnect, qr } = u;

	if (qr) {
		try {
			latestQR = await QR.toDataURL(qr, { margin: 1, width: 320 });
			status = 'qr';
			log.info('QR updated — scan to link.');
		} catch (e) {
			log.error(e, 'QR encode failed');
		}
	}

	if (connection === 'open') {
		status = 'connected';
		latestQR = null;
		reconnectAttempts = 0;
		me = sock && sock.user && sock.user.id ? jidToPhone(sock.user.id) : '';
		log.info({ me }, 'WhatsApp connected.');
		return;
	}

	if (connection !== 'close') { return; }

	status = 'disconnected';
	const code = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output)
		? lastDisconnect.error.output.statusCode
		: 0;

	// Retire the dead socket BEFORE any reconnect so the old and new sockets never
	// coexist (coexisting sockets on the same account cause 440/connectionReplaced).
	teardownSock();

	if (code === DisconnectReason.loggedOut) {
		// Real unlink (or expired/reused pairing) — clear creds, wait for a new QR.
		log.warn({ code }, 'Logged out — clearing auth, waiting for a new QR.');
		clearAuth();
		scheduleReconnect(3000);
		return;
	}

	if (code === DisconnectReason.connectionReplaced) {
		// Another WhatsApp Web session took over this number. Reconnecting immediately
		// just starts a tug-of-war (the 440 loop). Back off well so only one wins.
		log.warn({ code }, 'Connection replaced by another session — pausing before one reconnect. Make sure only ONE gateway instance runs and WhatsApp Web is not open elsewhere.');
		scheduleReconnect(20000);
		return;
	}

	if (code === DisconnectReason.restartRequired) {
		// Expected right after a successful QR scan — reconnect promptly, once.
		log.info({ code }, 'Restart required — reconnecting.');
		scheduleReconnect(1000);
		return;
	}

	// Everything else (408 timeouts, transient closes): single reconnect w/ backoff.
	reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
	const delay = Math.min(30000, 2000 * Math.pow(2, reconnectAttempts - 1));
	log.warn({ code, delay, attempt: reconnectAttempts }, 'Connection closed — reconnecting.');
	scheduleReconnect(delay);
}

/**
 * Handle inbound WhatsApp messages. We only care about *your* replies that quote
 * a forwarded visitor message (carrying a [CODE] tag) — those are routed back to
 * the matching website conversation.
 */
async function onMessages(ev) {
	// 'notify' = real-time messages; 'append' = messages you send from your own
	// phone (e.g. a reply in "Message yourself"). We want both.
	if (!ev || !Array.isArray(ev.messages)) return;
	if (ev.type !== 'notify' && ev.type !== 'append') return;

	const nowSec = Math.floor(Date.now() / 1000);

	for (const msg of ev.messages) {
		if (!msg.message || !msg.key) continue;

		// De-dupe: WhatsApp can surface the same message in more than one event.
		if (seenMessage(msg.key.id)) continue;

		// Ignore history replayed on reconnect so we don't re-forward old messages.
		const ts = typeof msg.messageTimestamp === 'number'
			? msg.messageTimestamp
			: (msg.messageTimestamp && Number(msg.messageTimestamp.low)) || 0;
		if (ts && nowSec - ts > 120) continue;

		const text = extractText(msg.message);
		if (!text) continue;

		// The quoted message (if you used WhatsApp's "reply") carries the [CODE].
		const ctx = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo;
		const quoted = ctx && ctx.quotedMessage ? extractText(ctx.quotedMessage) : '';

		let code = '';
		const mq = quoted && quoted.match(CODE_RE);
		if (mq) {
			code = mq[1];
		} else {
			// Fallback: a plain reply (no quote) routes to the most recent visitor,
			// but never treat our own forwarded notification as a reply.
			if (CODE_RE.test(text)) continue; // this IS a forwarded notification.
			if (!lastCode) {
				log.info('Reply without a [code] quote and no recent visitor — ignoring.');
				continue;
			}
			code = lastCode;
		}

		// The reply body is the admin's text with any leading [CODE] stripped.
		const body = text.replace(CODE_RE, '').trim();
		if (!body) continue;

		log.info({ code, fromMe: !!msg.key.fromMe, quoted: !!mq }, 'Routing WhatsApp reply to WordPress');
		await forwardToWP(code, body);
	}
}

/** Remember the last ~500 handled message IDs to avoid double-forwarding. */
const _seen = new Set();
function seenMessage(id) {
	if (!id) return false;
	if (_seen.has(id)) return true;
	_seen.add(id);
	if (_seen.size > 500) { _seen.delete(_seen.values().next().value); }
	return false;
}

/* ------------------------------------------------------------------ helpers */

function extractText(message) {
	if (!message) return '';
	return (
		message.conversation ||
		(message.extendedTextMessage && message.extendedTextMessage.text) ||
		(message.imageMessage && message.imageMessage.caption) ||
		(message.videoMessage && message.videoMessage.caption) ||
		''
	);
}

function jidToPhone(jid) {
	try {
		return '+' + jidNormalizedUser(jid).split('@')[0].split(':')[0];
	} catch (e) {
		return '';
	}
}

function clearAuth() {
	try {
		fs.rmSync(AUTH_DIR, { recursive: true, force: true });
	} catch (e) {
		log.error(e, 'Failed clearing auth dir');
	}
	me = '';
	latestQR = null;
}

async function forwardToWP(code, body) {
	if (!WP_WEBHOOK_URL) {
		log.warn('WP_WEBHOOK_URL not set — cannot deliver reply to WordPress.');
		return;
	}
	try {
		const res = await fetch(WP_WEBHOOK_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-WACB-Token': AUTH_TOKEN },
			body: JSON.stringify({ code, body }),
		});
		if (!res.ok) log.warn({ status: res.status, code }, 'WP webhook rejected reply.');
		else log.info({ code }, 'Reply delivered to WordPress.');
	} catch (e) {
		log.error(e, 'WP webhook call failed');
	}
}

/* --------------------------------------------------------------- HTTP API */

const app = express();
app.use(express.json({ limit: '256kb' }));

// Public liveness probe (no token) — for Render health checks / uptime pingers.
app.get('/health', (req, res) => res.json({ ok: true, status }));

// Bearer auth for every route below.
app.use((req, res, next) => {
	const h = req.headers.authorization || '';
	const token = h.startsWith('Bearer ') ? h.slice(7) : '';
	if (token !== AUTH_TOKEN) return res.status(403).json({ error: 'Forbidden' });
	next();
});

app.get('/status', (req, res) => {
	res.json({ status, qr: latestQR, me });
});

app.post('/send', async (req, res) => {
	if (status !== 'connected' || !sock) {
		return res.status(503).json({ error: 'WhatsApp not connected' });
	}
	const to = (req.body && req.body.to ? String(req.body.to) : '').replace(/[^0-9]/g, '');
	const text = req.body && req.body.text ? String(req.body.text) : '';
	if (!text) return res.status(400).json({ error: 'Missing text' });

	const jid = to ? `${to}@s.whatsapp.net` : jidNormalizedUser(sock.user.id);

	try {
		const sent = await sock.sendMessage(jid, { text });
		const m = text.match(CODE_RE);
		if (m) lastCode = m[1]; // remember for plain-reply fallback
		res.json({ id: sent && sent.key ? sent.key.id : '' });
	} catch (e) {
		log.error(e, 'sendMessage failed');
		res.status(500).json({ error: 'send failed' });
	}
});

app.post('/logout', async (req, res) => {
	try {
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		if (sock) {
			try { await sock.logout(); } catch (e) { /* ignore */ }
		}
		teardownSock();
		clearAuth();
		status = 'connecting';
		scheduleReconnect(800);
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: 'logout failed' });
	}
});

app.listen(PORT, () => {
	log.info(`WA Chat Bridge gateway listening on :${PORT}`);
	startSock().catch((e) => log.error(e, 'startSock failed'));
});

process.on('unhandledRejection', (e) => log.error(e, 'unhandledRejection'));
