const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { app: addonApp } = require('./index');
const { version } = require('./package.json');

const app = express();
const PORT = Number(process.env.PORT) || 7000;

function decodeBase64UrlConfig(value) {
    try {
        const normalized = String(value || '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const decoded = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
        const username = String(decoded.username || '').trim();
        const password = String(decoded.password || '');
        if (!username || !password || /[\r\n;]/.test(username)) return null;
        return { username, password };
    } catch {
        return null;
    }
}

function legacyConfigFromToken(token) {
    const config = decodeBase64UrlConfig(token);
    if (!config) return null;
    const passMd5 = crypto.createHash('md5').update(config.password, 'utf8').digest('hex');
    return `${encodeURIComponent(config.username)}:${passMd5}`;
}

app.disable('etag');

app.get(['/', '/configure'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.use((req, res, next) => {
    const match = /^\/([^/?]+)(\/.*)$/.exec(req.url);
    if (!match) return next();

    const legacyConfig = legacyConfigFromToken(match[1]);
    if (!legacyConfig) return next();

    req.url = `/${legacyConfig}${match[2]}`;
    return next();
});

app.use(addonApp);

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Sosáč + Streamuj CZ Titulky v${version} listening on port ${PORT}`);
    });
}

module.exports = { app };
