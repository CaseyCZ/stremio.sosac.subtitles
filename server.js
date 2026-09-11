const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { app: addonApp } = require('./index');
const { version } = require('./package.json');

const app = express();
const PORT = Number(process.env.PORT) || 7000;
const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';
const SOSAC_HASH_SALT = 'EWs5yVD4QF2sshGm22EWVa';

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

function sosacPasswordHash(username, password) {
    const step1 = crypto.createHash('md5')
        .update(`${username}:${password}`)
        .digest('hex');
    return crypto.createHash('md5')
        .update(step1 + SOSAC_HASH_SALT)
        .digest('hex');
}

async function fetchSosacSeriesDetail(seriesId, config) {
    const url = new URL(`https://${SOSAC_API_DOMAIN}/serials/${encodeURIComponent(seriesId)}`);
    url.searchParams.set('username', config.username);
    url.searchParams.set('password', sosacPasswordHash(config.username, config.password));

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Stremio Sosac Subtitles)',
            'Accept': 'application/json,text/plain,*/*',
            'Referer': 'https://sosac.tv/'
        },
        signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
        throw new Error(`Sosáč serials/${seriesId}: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
}

function findEpisodeInSeriesDetail(detail, season, episode) {
    if (!detail || typeof detail !== 'object') return null;

    const seasonData = detail[String(season)];
    if (seasonData && typeof seasonData === 'object') {
        const direct = seasonData[String(episode)];
        if (direct && typeof direct === 'object') return direct;
    }

    for (const [seasonKey, seasonValue] of Object.entries(detail)) {
        if (seasonKey === 'info' || !seasonValue || typeof seasonValue !== 'object') continue;
        for (const candidate of Object.values(seasonValue)) {
            if (!candidate || typeof candidate !== 'object') continue;
            if (Number(candidate.s) === season && Number(candidate.ep) === episode) {
                return candidate;
            }
        }
    }

    return null;
}

async function rewriteSeriesRequestToEpisode(req) {
    const question = req.url.indexOf('?');
    const pathname = question >= 0 ? req.url.slice(0, question) : req.url;
    const query = question >= 0 ? req.url.slice(question) : '';
    const parts = pathname.split('/');

    if (parts.length < 5 || parts[2] !== 'subtitles' || parts[3] !== 'series') return;

    const config = decodeBase64UrlConfig(parts[1]);
    if (!config) return;

    let rawId = parts[4];
    const hadJsonSuffix = rawId.endsWith('.json');
    if (hadJsonSuffix) rawId = rawId.slice(0, -5);

    let decodedId;
    try {
        decodedId = decodeURIComponent(rawId);
    } catch {
        return;
    }

    const match = decodedId.match(/^(?:sosac_s_|sosac2_|sosac_)?(\d+):(\d+):(\d+)$/i);
    if (!match) return;

    const [, seriesId, seasonRaw, episodeRaw] = match;
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);

    try {
        console.log(`[Series] serials/${seriesId} → S${season}E${episode}`);
        const detail = await fetchSosacSeriesDetail(seriesId, config);
        const selected = findEpisodeInSeriesDetail(detail, season, episode);
        if (!selected || selected._id === undefined || selected._id === null) {
            console.warn(`[Series] Epizoda S${season}E${episode} nebyla v seriálu ${seriesId} nalezena.`);
            return;
        }

        const episodeId = String(selected._id);
        parts[4] = encodeURIComponent(episodeId) + (hadJsonSuffix ? '.json' : '');
        req.url = parts.join('/') + query;
        console.log(`[Series] ${seriesId}:${season}:${episode} → episodes/${episodeId}`);
    } catch (error) {
        console.warn(`[Series] Převod series → episode selhal: ${error.message}`);
    }
}

app.disable('etag');

app.get(['/', '/configure'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Kodi postup: series ID → /serials/<ID> → season/episode → episode _id.
// Potom původní addon načte /episodes/<episode_id> a z pole l získá Streamuj ID.
app.use(async (req, res, next) => {
    await rewriteSeriesRequestToEpisode(req);
    next();
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
