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

const CODE_RE = /\[([A-Z0-9]{4,20})\]/; // matches the [ABC123] tag we embed

/* --------------------------------------------------------- WhatsApp socket */

async function startSock() {
	const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
	const { version } = await fetchLatestBaileysVersion();

	sock = makeWASocket({
		version,
		auth: state,
		logger: pino({ level: 'silent' }),
		printQRInTerminal: false,
		browser: ['WA Chat Bridge', 'Chrome', '1.0.0'],
		markOnlineOnConnect: false,
	});

	sock.ev.on('creds.update', saveCreds);

	sock.ev.on('connection.update', async (u) => {
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
			me = sock.user && sock.user.id ? jidToPhone(sock.user.id) : '';
			log.info({ me }, 'WhatsApp connected.');
		}

		if (connection === 'close') {
			status = 'disconnected';
			const code = (lastDisconnect && lastDisconnect.error instanceof Boom)
				? lastDisconnect.error.output.statusCode
				: (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
					? lastDisconnect.error.output.statusCode
					: 0);

			if (code === DisconnectReason.loggedOut) {
				log.warn('Logged out — clearing auth, waiting for a new QR.');
				clearAuth();
				setTimeout(startSock, 1500);
			} else {
				log.warn({ code }, 'Connection closed — reconnecting.');
				setTimeout(startSock, 2500);
			}
		}
	});

	sock.ev.on('messages.upsert', onMessages);
}

/**
 * Handle inbound WhatsApp messages. We only care about *your* replies that quote
 * a forwarded visitor message (carrying a [CODE] tag) — those are routed back to
 * the matching website conversation.
 */
async function onMessages(ev) {
	if (ev.type !== 'notify' || !Array.isArray(ev.messages)) return;

	for (const msg of ev.messages) {
		if (!msg.message) continue;

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
			if (!lastCode) continue;
			code = lastCode;
		}

		// The reply body is the admin's text with any leading [CODE] stripped.
		const body = text.replace(CODE_RE, '').trim();
		if (!body) continue;

		await forwardToWP(code, body);
	}
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
		if (sock) {
			try { await sock.logout(); } catch (e) { /* ignore */ }
		}
		clearAuth();
		status = 'connecting';
		setTimeout(startSock, 800);
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
