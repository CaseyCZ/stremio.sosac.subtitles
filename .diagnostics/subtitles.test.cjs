'use strict';

// Offline integration checks: real Express HTTP, synthetic Sosac / Streamuj
// responses, and a separate temporary subtitle cache for every test.
// Run from the project root: node --test .diagnostics/subtitles.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const entry = path.resolve(__dirname, '..', 'index.js');
const projectRequire = createRequire(entry);
const express = projectRequire('express');
const config = encodeURIComponent('offline-test:0123456789abcdef0123456789abcdef');
const videoA = 'a12345678901234567890';
const videoB = 'b12345678901234567890';
const videoWrong = 'c12345678901234567890';
const source = name => `https://s01.streamuj.tv/${name}.srt`;
const srt = text => `1\r\n00:00:01,250 --> 00:00:04,500\r\n${text}\r\n`;
const player = subtitles => ({ URL: { en: { subtitles } } });

async function startAddon(t, fixtures = {}, sharedCache) {
    const cache = sharedCache || fs.mkdtempSync(path.join(os.tmpdir(), 'sosac-subtitle-test-'));
    let server;
    t.after(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        if (!sharedCache) {
            const target = path.resolve(cache);
            const relative = path.relative(path.resolve(os.tmpdir()), target);
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
                'recursive cleanup must stay inside the temporary directory');
            assert.ok(path.basename(target).startsWith('sosac-subtitle-test-'));
            fs.rmSync(target, { recursive: true, force: true });
        }
    });
    const requests = [];
    const unexpected = [];
    const logs = [];

    const upstream = async (rawUrl, username, passMd5) => {
        const url = new URL(rawUrl);
        requests.push(url);
        let value;
        let known = false;
        if (url.hostname === 'kodi-api.sosac.to') {
            known = Object.hasOwn(fixtures.sosac || {}, url.pathname);
            value = fixtures.sosac?.[url.pathname];
        } else if (url.pathname === '/json_api_player.php') {
            assert.equal(url.searchParams.get('action'), 'get-video-links');
            assert.equal(url.searchParams.get('d'), '19');
            const id = url.searchParams.get('link');
            known = Object.hasOwn(fixtures.players || {}, id);
            value = fixtures.players?.[id];
        } else if (url.pathname.startsWith('/video/')) {
            const id = url.pathname.split('/').pop();
            known = Object.hasOwn(fixtures.html || {}, id);
            value = fixtures.html?.[id];
        } else {
            known = Object.hasOwn(fixtures.files || {}, url.href);
            value = fixtures.files?.[url.href];
        }
        if (!known) {
            unexpected.push(`${url.hostname}${url.pathname}`);
            throw new Error('Unconfigured offline upstream request');
        }
        if (typeof value === 'function') value = await value({ url, username, passMd5 });
        if (value instanceof Error) throw value;
        return typeof value === 'string' ? value : JSON.stringify(value);
    };

    let capturedApp;
    let listen;
    function offlineExpress() {
        capturedApp = express();
        listen = capturedApp.listen.bind(capturedApp);
        capturedApp.listen = () => { throw new Error('Production startup ran during module import'); };
        return capturedApp;
    }
    Object.assign(offlineExpress, express);
    const module = { exports: {} };
    const sandbox = {
        require: name => {
            if (name === 'express') return offlineExpress;
            if (name === 'https') return { get() { throw new Error('Real upstream HTTPS is disabled in offline tests'); } };
            return projectRequire(name);
        },
        module,
        exports: module.exports,
        __dirname: path.dirname(entry),
        __filename: entry,
        process: { ...process, env: { SUBTITLE_CACHE_DIR: cache, PUBLIC_BASE_URL: '', PORT: '0' } },
        console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push(args.join(' '))])),
        URL,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        __offlineHttpsGet: upstream
    };
    // This assignment affects only the isolated VM, never the production file.
    vm.runInNewContext(
        fs.readFileSync(entry, 'utf8') + '\nhttpsGet = __offlineHttpsGet;\n',
        sandbox,
        { filename: entry }
    );
    server = listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, cache, requests, unexpected, logs,
        request(type, id, suffix = '', accountConfig = config) {
            return fetch(`${base}/${accountConfig}/subtitles/${type}/${encodeURIComponent(id)}${suffix}.json`);
        },
        async subtitles(type, id, suffix = '', accountConfig = config) {
            const response = await this.request(type, id, suffix, accountConfig);
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type'), /^application\/json/);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(response.headers.get('access-control-allow-origin'), '*');
            assert.equal(response.headers.get('etag'), null);
            const json = await response.json();
            assert.ok(Array.isArray(json.subtitles));
            return json.subtitles;
        },
        assertFixturesUsed() {
            assert.deepEqual(unexpected, [], 'every upstream request must use an explicit offline fixture');
        }
    };
}

function movieFixtures(subtitles, files, extra = {}) {
    return {
        sosac: { '/movies/101': { item: { l: videoA } } },
        players: { [videoA]: player(subtitles) },
        files,
        ...extra
    };
}

function assertPreparedTrack(track, base) {
    const url = new URL(track.url);
    assert.equal(url.origin, base);
    assert.match(url.pathname, /^\/subtitle-file\/v1\/[a-f0-9]{64}\.vtt$/);
    assert.equal(url.search, '');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.ok(track.id);
    assert.ok(!JSON.stringify(track).includes('offline-test'));
    assert.ok(!JSON.stringify(track).includes('0123456789abcdef0123456789abcdef'));
}

test('movie retains multiple languages and serves complete prepared UTF-8 VTT via GET and HEAD', async t => {
    const cs = source('movie-cs');
    const en = source('movie-en');
    const sk = source('movie-sk');
    const app = await startAddon(t, movieFixtures(
        { cs, en, sk },
        { [cs]: srt('Příliš žluťoučký kůň.'), [en]: srt('English subtitle.'), [sk]: srt('Slovenské titulky.') }
    ));
    const tracks = await app.subtitles('movie', 'sosac_m_101');
    assert.deepEqual(tracks.map(track => track.lang), ['cze', 'slk', 'eng']);
    assert.equal(new Set(tracks.map(track => track.id)).size, 3);
    for (const track of tracks) assertPreparedTrack(track, app.base);
    const beforeFileRequests = app.requests.length;
    const get = await fetch(tracks[0].url);
    const body = Buffer.from(await get.arrayBuffer());
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.equal(get.headers.get('access-control-allow-origin'), '*');
    assert.equal(Number(get.headers.get('content-length')), body.length);
    assert.equal(body.toString('utf8'), 'WEBVTT\n\n00:00:01.250 --> 00:00:04.500\nPříliš žluťoučký kůň.\n');
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    assert.equal(new URL(tracks[0].url).pathname, `/subtitle-file/v1/${hash}.vtt`);
    const head = await fetch(tracks[0].url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(Number(head.headers.get('content-length')), body.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(app.requests.length, beforeFileRequests, 'GET/HEAD must not download upstream again');
    const again = await app.subtitles('movie', 'sosac_m_101');
    assert.deepEqual(again, tracks, 'repeated resource requests keep stable track IDs and file URLs');
    assert.equal(app.requests.length, beforeFileRequests, 'successful lookup reuses both upstream API responses');
    assert.equal(app.requests.filter(url => url.href === cs).length, 1, 'prepared source content is reused');
    app.assertFixturesUsed();
});

test('series uses the same prepared-file response, including a wrapped episode and Stremio extra arguments', async t => {
    const cs = source('series-cs');
    const app = await startAddon(t, {
        sosac: { '/episodes/101': { episode: { s: 3, ep: 7, l: videoA } } },
        players: { [videoA]: player({ cs }) },
        files: { [cs]: srt('Sedmá epizoda.') }
    });
    const tracks = await app.subtitles('series', 'sosac2_101:3:7', '/videoHash=abc&videoSize=42');
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].lang, 'cze');
    assertPreparedTrack(tracks[0], app.base);
    assert.match(await (await fetch(tracks[0].url)).text(), /Sedmá epizoda\./);
    app.assertFixturesUsed();
});

test('identical subtitle bytes in distinct languages retain distinct Stremio track IDs', async t => {
    const cs = source('same-bytes-cs');
    const sk = source('same-bytes-sk');
    const app = await startAddon(t, movieFixtures({ cs, sk }, { [cs]: srt('Ahoj.'), [sk]: srt('Ahoj.') }));
    const tracks = await app.subtitles('movie', '101');
    assert.equal(tracks.length, 2);
    assert.deepEqual(tracks.map(track => track.lang), ['cze', 'slk']);
    assert.notEqual(tracks[0].id, tracks[1].id);
    assert.equal(tracks[0].url, tracks[1].url, 'content-addressed files may share bytes across languages');
    app.assertFixturesUsed();
});

test('HTML fallback reads all subX tracks and preserves Czech, Slovak and English language labels', async t => {
    const cs = 'https://s01.streamuj.tv/?streamuj=subtitles&id=cs';
    const en = source('html-en');
    const sk = source('html-sk');
    const unknown = source('html-unknown');
    const app = await startAddon(t, movieFixtures({}, {
        [cs]: srt('Čeština.'), [en]: srt('English.'), [sk]: srt('Slovenčina.')
    }, {
        html: { [videoA]: `sub0: "čeština>${cs.replace('&', '&amp;')}", sub1: "English>${en}", sub2: "slovenština>${sk}", sub3: "unknown>${unknown}"` }
    }));
    const tracks = await app.subtitles('movie', '101');
    assert.equal(tracks.length, 3);
    assert.deepEqual(tracks.map(track => track.lang).sort(), ['cze', 'eng', 'slk']);
    assert.ok(!app.requests.some(url => url.href === unknown));
    app.assertFixturesUsed();
});

for (const type of ['movie', 'series']) {
    test(`${type} falls back to HTML when a listed API subtitle cannot be downloaded`, async t => {
        const stale = source(`${type}-stale`);
        const working = source(`${type}-html-working`);
        const app = await startAddon(t, {
            sosac: { [`/${type === 'movie' ? 'movies' : 'episodes'}/101`]: { l: videoA } },
            players: { [videoA]: player({ cs: stale }) },
            html: { [videoA]: `sub0: "čeština>${working}"` },
            files: { [stale]: new Error('HTTP 403: expired fixture'), [working]: srt('Záloha funguje.') }
        });
        const tracks = await app.subtitles(type, '101');
        assert.equal(tracks.length, 1);
        assert.match(await (await fetch(tracks[0].url)).text(), /Záloha funguje\./);
        assert.ok(app.requests.some(url => url.pathname === `/video/${videoA}`));
        app.assertFixturesUsed();
    });

    test(`${type} tries the next Streamuj candidate when the first candidate has no usable file`, async t => {
        const broken = source(`${type}-broken`);
        const good = source(`${type}-next`);
        const app = await startAddon(t, {
            sosac: { [`/${type === 'movie' ? 'movies' : 'episodes'}/101`]: { l: videoA, alternatives: [videoB] } },
            players: { [videoA]: player({ cs: broken }), [videoB]: player({ cs: good }) },
            html: { [videoA]: '' },
            files: { [broken]: '<html>Login required</html>', [good]: srt('Druhý zdroj.') }
        });
        const tracks = await app.subtitles(type, '101');
        assert.equal(tracks.length, 1);
        assert.match(await (await fetch(tracks[0].url)).text(), /Druhý zdroj\./);
        assert.ok(app.requests.some(url => url.searchParams.get('link') === videoB));
        app.assertFixturesUsed();
    });
}

for (const direct of ['missing', 'wrong episode']) {
    test(`series resolves requested season/episode through serials when direct episode is ${direct}`, async t => {
        const good = source(`resolved-${direct.replace(' ', '-')}`);
        const app = await startAddon(t, {
            sosac: {
                '/episodes/101': direct === 'missing' ? new Error('HTTP 404') : { s: 1, ep: 1, l: videoWrong },
                '/serials/101': {
                    info: { title: 'Synthetic series' },
                    '3': { '6': { _id: 156566, l: videoWrong }, '7': { _id: 156567, l: videoA } }
                }
            },
            players: { [videoA]: player({ cs: good }) },
            files: { [good]: srt('Správná S03E07.') }
        });
        const tracks = await app.subtitles('series', 'sosac2_101:3:7');
        assert.equal(tracks.length, 1);
        assert.match(await (await fetch(tracks[0].url)).text(), /Správná S03E07\./);
        assert.ok(!app.requests.some(url => url.searchParams.get('link') === videoWrong));
        app.assertFixturesUsed();
    });
}

test('series does not return subtitles from an unrelated episode when the requested episode is absent', async t => {
    const app = await startAddon(t, {
        sosac: {
            '/episodes/101': { s: 1, ep: 1, l: videoWrong },
            '/serials/101': { info: {}, '3': { '6': { _id: 156566, l: videoWrong } } }
        }
    });
    assert.deepEqual(await app.subtitles('series', 'sosac2_101:3:7'), []);
    assert.ok(!app.requests.some(url => url.pathname === '/json_api_player.php'));
    app.assertFixturesUsed();
});

test('empty and failed subtitle responses are not cached', async t => {
    const app = await startAddon(t, {
        sosac: { '/movies/101': {}, '/episodes/101': new Error('Synthetic unavailable API') }
    });
    assert.deepEqual(await app.subtitles('movie', '101'), []);
    assert.deepEqual(await app.subtitles('series', '101'), []);
    assert.deepEqual(await app.subtitles('unsupported', '101'), []);
    const invalid = await fetch(`${app.base}/invalid-config/subtitles/movie/101.json`);
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await invalid.json(), { subtitles: [] });
    app.assertFixturesUsed();
});

test('prepared VTT supports byte ranges, suffix ranges, unsatisfiable ranges and full HEAD responses', async t => {
    const cs = source('range');
    const app = await startAddon(t, movieFixtures({ cs }, { [cs]: srt('Dlouhé české titulky.') }));
    const [track] = await app.subtitles('movie', '101');
    const full = await fetch(track.url);
    const bytes = Buffer.from(await full.arrayBuffer());
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    for (const [range, from, to] of [
        ['bytes=0-5', 0, 5],
        ['bytes=7-', 7, bytes.length - 1],
        ['bytes=-8', bytes.length - 8, bytes.length - 1]
    ]) {
        const response = await fetch(track.url, { headers: { Range: range } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), `bytes ${from}-${to}/${bytes.length}`);
        assert.equal(Number(response.headers.get('content-length')), to - from + 1);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(from, to + 1));
    }
    const beyond = await fetch(track.url, { headers: { Range: `bytes=${bytes.length}-` } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${bytes.length}`);
    for (const range of ['nonsense', 'bytes=0-1,4-5']) {
        const ignored = await fetch(track.url, { headers: { Range: range } });
        assert.equal(ignored.status, 200);
        assert.deepEqual(Buffer.from(await ignored.arrayBuffer()), bytes);
    }
    const head = await fetch(track.url, { method: 'HEAD', headers: { Range: 'bytes=0-5' } });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    app.assertFixturesUsed();
});

test('prepared VTT remains retrievable after application restart with the same cache directory', async t => {
    const cs = source('persistent');
    const app = await startAddon(t, movieFixtures({ cs }, { [cs]: srt('Soubor po restartu.') }));
    const [track] = await app.subtitles('movie', '101');
    const second = await startAddon(t, {}, app.cache);
    const restored = await fetch(new URL(new URL(track.url).pathname, second.base));
    assert.equal(restored.status, 200);
    assert.match(await restored.text(), /Soubor po restartu\./);
    assert.equal(second.requests.length, 0, 'existing files need no upstream access after restart');
    app.assertFixturesUsed();
    second.assertFixturesUsed();
});

test('missing or corrupt prepared files return 404 and resource refresh recreates the file', async t => {
    const cs = source('repair');
    const app = await startAddon(t, movieFixtures({ cs }, { [cs]: srt('Obnovený soubor.') }));
    const [track] = await app.subtitles('movie', '101');
    const filename = path.basename(new URL(track.url).pathname);
    fs.writeFileSync(path.join(app.cache, filename), 'corrupt', 'utf8');
    assert.equal((await fetch(track.url)).status, 404);
    const [repaired] = await app.subtitles('movie', '101');
    assert.equal(repaired.url, track.url);
    assert.equal((await fetch(track.url)).status, 200);
    const missing = await fetch(`${app.base}/subtitle-file/v1/${'f'.repeat(64)}.vtt`);
    assert.equal(missing.status, 404);
    assert.equal((await fetch(`${app.base}/subtitle-file/v1/invalid.vtt`)).status, 404);
    app.assertFixturesUsed();
});

test('simultaneous identical requests share one upstream lookup and one subtitle download', async t => {
    const cs = source('concurrent');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const app = await startAddon(t, movieFixtures({ cs }, { [cs]: srt('Jeden společný výsledek.') }, {
        sosac: { '/movies/101': async () => { await gate; return { l: videoA }; } }
    }));
    const simultaneous = Promise.all(Array.from({ length: 6 }, () => app.subtitles('movie', '101')));
    try {
        const deadline = Date.now() + 2000;
        const startedCount = () => app.logs.filter(line => line.startsWith('[SUBTITLE HTTP]') && line.includes('"event":"START"')).length;
        while (startedCount() < 6 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(startedCount(), 6, 'all client requests must arrive before the upstream response is released');
        assert.equal(app.requests.filter(url => url.pathname === '/movies/101').length, 1);
    } finally {
        release();
    }
    const results = await simultaneous;
    assert.equal(results[0].length, 1);
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(app.requests.filter(url => url.pathname === '/movies/101').length, 1);
    assert.equal(app.requests.filter(url => url.pathname === '/json_api_player.php').length, 1);
    assert.equal(app.requests.filter(url => url.href === cs).length, 1);
    app.assertFixturesUsed();
});

test('successful lookup cache remains isolated by both username and password hash', async t => {
    const cs = source('account-isolation');
    const accounts = [
        ['offline-test', '0123456789abcdef0123456789abcdef'],
        ['second-offline-test', '0123456789abcdef0123456789abcdef'],
        ['offline-test', 'fedcba9876543210fedcba9876543210']
    ];
    const app = await startAddon(t, movieFixtures({ cs }, {
        [cs]: ({ username, passMd5 }) => srt(`Výsledek pro ${username} ${passMd5.slice(0, 4)}.`)
    }));
    const tracks = [];
    for (const [username, passMd5] of accounts) {
        const accountConfig = encodeURIComponent(`${username}:${passMd5}`);
        const result = await app.subtitles('movie', '101', '', accountConfig);
        assert.equal(result.length, 1);
        tracks.push(result[0]);
        assert.deepEqual(await app.subtitles('movie', '101', '', accountConfig), result);
    }
    assert.equal(new Set(tracks.map(track => track.url)).size, 3);
    assert.equal(app.requests.filter(url => url.pathname === '/movies/101').length, 3);
    const playerRequests = app.requests.filter(url => url.pathname === '/json_api_player.php');
    assert.equal(playerRequests.length, 3);
    assert.deepEqual(playerRequests.map(url => [url.searchParams.get('login'), url.searchParams.get('password')]), accounts);
    assert.equal(app.requests.filter(url => url.href === cs).length, 3);
    app.assertFixturesUsed();
});

test('failed and empty lookups are retried so a recovered upstream becomes available immediately', async t => {
    const cs = source('retry');
    let attempt = 0;
    const app = await startAddon(t, movieFixtures({ cs }, { [cs]: srt('Titulky už jsou dostupné.') }, {
        sosac: {
            '/movies/101': () => {
                attempt += 1;
                if (attempt === 1) throw new Error('Temporary upstream outage');
                return attempt === 2 ? {} : { l: videoA };
            }
        }
    }));
    assert.deepEqual(await app.subtitles('movie', '101'), []);
    assert.deepEqual(await app.subtitles('movie', '101'), []);
    const tracks = await app.subtitles('movie', '101');
    assert.equal(tracks.length, 1);
    assert.equal(attempt, 3);
    assert.match(await (await fetch(tracks[0].url)).text(), /Titulky už jsou dostupné\./);
    assert.deepEqual(await app.subtitles('movie', '101'), tracks);
    assert.equal(attempt, 3, 'the recovered successful lookup is cached');
    app.assertFixturesUsed();
});

for (const type of ['movie', 'series']) {
    test(`${type} restores failed Czech API subtitles from HTML while keeping the working English API track`, async t => {
        const brokenCs = source(`${type}-partial-cs-broken`);
        const workingCs = source(`${type}-partial-cs-html`);
        const en = source(`${type}-partial-en`);
        const app = await startAddon(t, {
            sosac: { [`/${type === 'movie' ? 'movies' : 'episodes'}/101`]: { l: videoA } },
            players: { [videoA]: player({ cs: brokenCs, en }) },
            html: { [videoA]: `sub0: "čeština>${workingCs}"` },
            files: {
                [brokenCs]: new Error('Expired Czech track'),
                [workingCs]: srt('Obnovená česká stopa.'),
                [en]: srt('Existing English track.')
            }
        });
        const tracks = await app.subtitles(type, '101');
        assert.deepEqual(tracks.map(track => track.lang), ['cze', 'eng']);
        assert.match(await (await fetch(tracks[0].url)).text(), /Obnovená česká stopa\./);
        assert.match(await (await fetch(tracks[1].url)).text(), /Existing English track\./);
        app.assertFixturesUsed();
    });
}
