const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app: addonApp } = require('./index');
const { version } = require('./package.json');

const app = express();
const PORT = Number(process.env.PORT) || 7000;
const CONFIG_KEY_FILE = process.env.CONFIG_ENCRYPTION_KEY_FILE ||
    path.join(os.homedir(), '.stremio-sosac-subtitles-config-key');
const CONFIG_TOKEN_AAD = Buffer.from('stremio-sosac-subtitles:enc1', 'utf8');

function readConfigEncryptionKey() {
    const candidates = [String(process.env.CONFIG_ENCRYPTION_KEY || '').trim()];

    try {
        candidates.push(fs.readFileSync(CONFIG_KEY_FILE, 'utf8').trim());
    } catch (_) {}

    for (const raw of candidates) {
        if (/^[a-f0-9]{64}$/i.test(raw)) {
            return Buffer.from(raw, 'hex');
        }
    }

    return null;
}

const CONFIG_ENCRYPTION_KEY = readConfigEncryptionKey();

function normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const username = String(value.username || '').trim();
    const password = String(value.password || '');

    if (!username || !password) return null;
    if (username.length > 160 || password.length > 512) return null;
    if (/[\0\r\n;]/.test(username) || /[\0\r\n]/.test(password)) return null;

    return { username, password };
}

function decodeBase64UrlConfig(value) {
    try {
        const normalized = String(value || '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const decoded = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
        return normalizeConfig(decoded);
    } catch {
        return null;
    }
}

function encryptConfig(config) {
    if (!CONFIG_ENCRYPTION_KEY) {
        throw new Error('Config encryption key is not configured.');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, iv);
    cipher.setAAD(CONFIG_TOKEN_AAD);

    const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        'enc1',
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        tag.toString('base64url')
    ].join('.');
}

function decryptConfig(value) {
    if (!CONFIG_ENCRYPTION_KEY) return null;

    try {
        const parts = String(value || '').split('.');
        if (parts.length !== 4 || parts[0] !== 'enc1') return null;

        const iv = Buffer.from(parts[1], 'base64url');
        const ciphertext = Buffer.from(parts[2], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');

        if (iv.length !== 12 || !ciphertext.length || tag.length !== 16) return null;

        const decipher = crypto.createDecipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, iv);
        decipher.setAAD(CONFIG_TOKEN_AAD);
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]).toString('utf8');

        return normalizeConfig(JSON.parse(plaintext));
    } catch {
        return null;
    }
}

function decodeConfigToken(token) {
    const value = String(token || '');
    return value.startsWith('enc1.')
        ? decryptConfig(value)
        : decodeBase64UrlConfig(value);
}

function addonConfigFromToken(token) {
    const config = decodeConfigToken(token);
    if (!config) return null;

    const passMd5 = crypto.createHash('md5').update(config.password, 'utf8').digest('hex');
    return `${encodeURIComponent(config.username)}:${passMd5}`;
}

app.disable('etag');
app.use(express.json({ limit: '8kb' }));

app.get(['/', '/configure'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Stremio opens an add-on's configuration URL at the token root.
// Keep the public URL prefix when redirecting through Nginx.
app.get(['/:config', '/:config/configure'], (req, res, next) => {
    const token = String(req.params.config || '');
    if (!token.startsWith('enc1.') && !decodeConfigToken(token)) {
        return next();
    }

    const target = req.path.endsWith('/configure') ? '../configure' : 'configure';
    return res.redirect(302, target);
});

// The standalone DIRECT TEST manifest makes Stremio open /:config/direct-test
// when the user taps Configure. Redirect this path to the same settings page.
app.get(['/:config/direct-test', '/:config/direct-test/configure'], (req, res, next) => {
    const token = String(req.params.config || '');
    if (!token.startsWith('enc1.') && !decodeConfigToken(token)) {
        return next();
    }

    const target = req.path.endsWith('/configure') ? '../../configure' : '../configure';
    return res.redirect(302, target);
});

app.post('/api/config-token', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    const config = normalizeConfig(req.body);
    if (!config) {
        return res.status(400).json({ error: 'Invalid configuration' });
    }

    if (!CONFIG_ENCRYPTION_KEY) {
        return res.status(503).json({ error: 'Config encryption is not configured' });
    }

    try {
        return res.json({ format: 'enc1', token: encryptConfig(config) });
    } catch (error) {
        console.error('[config-token] encryption failed:', error && error.message ? error.message : error);
        return res.status(500).json({ error: 'Unable to create configuration token' });
    }
});

app.use((req, res, next) => {
    const match = /^\/([^/?]+)(\/.*)$/.exec(req.url);
    if (!match) return next();

    const addonConfig = addonConfigFromToken(match[1]);
    if (!addonConfig) return next();

    req.url = `/${addonConfig}${match[2]}`;
    return next();
});

app.use(addonApp);

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Sosáč + Streamuj CZ Titulky v${version} listening on port ${PORT}`);
    });
}

module.exports = { app };
