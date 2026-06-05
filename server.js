const express = require('express');
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[devour-routing] listening on port ${PORT}`));
