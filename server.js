const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_URL       = process.env.BOT_URL || 'https://cufflink-fall-outbid.ngrok-free.dev';
const SHARED_SECRET = process.env.SHARED_SECRET;
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI  = process.env.OAUTH_REDIRECT_URI || 'https://devour-routing.onrender.com/callback';

// ─── Step 1: Visitor clicks invite link ──────────────────────────────────────
// Capture IP, generate token, redirect to Discord OAuth

app.get('/invite', async (req, res) => {
    const ip    = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
                  || req.socket.remoteAddress;
    const token = uuidv4();

    // Send to bot instead of storing in-memory
    fetch(`${BOT_URL}/internal/correlation/init`, {
        method:  'POST',
        headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': SHARED_SECRET,
        },
        body: JSON.stringify({ token, ip }),
    }).catch(err => console.error('[invite] Failed to init correlation:', err.message));

    console.log(`[invite] Token ${token} → IP ${ip}`);

    const params = new URLSearchParams({
        client_id:     CLIENT_ID,
        scope:         'identify',
        response_type: 'code',
        redirect_uri:  REDIRECT_URI,
        state:         token,
        prompt:        'none',
    });

    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ─── Step 2: Discord sends user back here ────────────────────────────────────
// Exchange code → get Discord ID → save correlation → redirect to bot invite

app.get('/callback', async (req, res) => {
    const { code, state: token } = req.query;
    if (!code || !token) return res.status(400).send('Missing code or state');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id:     CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
                redirect_uri:  REDIRECT_URI,
            }),
        });
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error('[callback] Token exchange failed:', tokenData);
            return res.status(500).send('OAuth failed');
        }

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const { id: discordId } = await userRes.json();

        // Resolve token + discordId against the bot
        fetch(`${BOT_URL}/internal/correlation/resolve`, {
            method:  'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-internal-secret': SHARED_SECRET,
            },
            body: JSON.stringify({ token, discordId }),
        }).catch(err => console.error('[callback] Failed to resolve correlation:', err.message));

        console.log(`[callback] Resolved correlation: ${discordId} → token ${token}`);

        const botParams = new URLSearchParams({
            client_id:        CLIENT_ID,
            permissions:      '0',
            integration_type: '1',
            scope:            'applications.commands',
        });
        res.redirect(`https://discord.com/oauth2/authorize?${botParams}`);

    } catch (err) {
        console.error('[callback] Error:', err.message);
        res.status(500).send('Something went wrong');
    }
});

// ─── sobbi.ng "send me a message" ────────────────────────────────────────────
// Forwards notes from the sobbi.ng message form to a Discord webhook. The webhook
// URL stays in an env var so it never reaches the browser.

const WEBHOOK_URL     = process.env.DISCORD_WEBHOOK_URL;
const MESSAGE_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://sobbi.ng,https://www.sobbi.ng')
    .split(',').map(s => s.trim()).filter(Boolean);
const DAILY_LIMIT = 3;
const MAX_ALIAS   = 32;
const MAX_MESSAGE = 1000;
const IP_SALT     = crypto.randomBytes(16).toString('hex'); // IPs are only ever kept hashed, in memory

// Messages sent today per IP; cleared when the (UTC) date changes
const sentToday = new Map();
let countDay = '';

function bumpDailyCount(ip) {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== countDay) { sentToday.clear(); countDay = day; }
    const key = crypto.createHash('sha256').update(IP_SALT + ip).digest('hex');
    const n = (sentToday.get(key) || 0) + 1;
    sentToday.set(key, n);
    return n;
}

// Discord rejects webhook names containing these, so strip them out
function cleanAlias(raw) {
    let a = String(raw || '').replace(/[\r\n\t]/g, ' ').replace(/[@#:`]/g, '').replace(/discord|clyde/gi, '').trim();
    a = a.slice(0, MAX_ALIAS).trim();
    if (!a || /^(everyone|here)$/i.test(a)) a = 'anonymous';
    return a;
}

function messageCors(req, res) {
    const origin = req.headers.origin;
    if (!origin || !MESSAGE_ORIGINS.includes(origin)) return;
    res.set({
        'Access-Control-Allow-Origin':  origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary':                         'Origin',
    });
}

app.options('/api/message', (req, res) => {
    messageCors(req, res);
    res.sendStatus(204);
});

app.post('/api/message', async (req, res) => {
    messageCors(req, res);
    if (req.headers.origin && !MESSAGE_ORIGINS.includes(req.headers.origin)) return res.status(403).json({ error: 'not allowed' });
    if (!WEBHOOK_URL) return res.status(503).json({ error: 'messages are off right now' });

    const body = req.body || {};
    if (body.website) return res.json({ ok: true }); // honeypot: bots fill hidden fields

    const message = String(body.message || '').trim();
    if (!String(body.alias || '').trim()) return res.status(400).json({ error: 'add an alias' });
    if (!message) return res.status(400).json({ error: 'write a message' });
    if (message.length > MAX_MESSAGE) return res.status(400).json({ error: `keep it under ${MAX_MESSAGE} characters` });

    const ip = req.headers['cf-connecting-ip']
            || (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
            || req.socket.remoteAddress;
    const count = bumpDailyCount(ip);
    if (count > DAILY_LIMIT) return res.status(429).json({ error: `you've sent ${DAILY_LIMIT} messages today, try again tomorrow` });

    try {
        const r = await fetch(`${WEBHOOK_URL}?wait=true`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username:         cleanAlias(body.alias),
                content:          `${message}\n-# sent from sobbi.ng`,
                allowed_mentions: { parse: [] }, // never ping @everyone / roles / users
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
            console.error('[message] Webhook failed:', r.status, await r.text().catch(() => ''));
            return res.status(502).json({ error: "couldn't deliver it, try again later" });
        }
    } catch (err) {
        console.error('[message] Webhook error:', err.message);
        return res.status(502).json({ error: "couldn't deliver it, try again later" });
    }

    console.log(`[message] Delivered (${count}/${DAILY_LIMIT} today for this IP)`);
    res.json({ ok: true, remaining: Math.max(0, DAILY_LIMIT - count) });
});

// For UptimeRobot / waking the service early
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[devour-routing] listening on port ${PORT}`));
