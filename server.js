const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app: addonApp } = require('./index');
const { version } = require('./package.json');

const app = express();
const PORT = Number(process.env.PORT) || 7000;
const CONFIG_STORE_DIR = process.env.SUBTITLES_CONFIG_STORE_DIR || path.join(os.homedir(), '.stremio-subtitles-configs');
const TOKEN_RE = /^cfg\.[a-f0-9]{64}$/;
const createBuckets = new Map();

function configFile(token) {
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    return path.join(CONFIG_STORE_DIR, `${hash}.json`);
}

function ensureStore() {
    fs.mkdirSync(CONFIG_STORE_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(CONFIG_STORE_DIR, 0o700); } catch {}
}

function normalizeCredentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const username = String(value.username || '').trim().slice(0, 512);
    const password = String(value.password || '').slice(0, 512);
    if (!username || !password || /[\r\n;]/.test(username)) return null;
    return { username, password };
}

function readStoredConfig(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    try {
        return normalizeCredentials(JSON.parse(fs.readFileSync(configFile(token), 'utf8')));
    } catch {
        return null;
    }
}

function createStoredConfig(value) {
    const config = normalizeCredentials(value);
    if (!config) return null;
    ensureStore();

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const token = `cfg.${crypto.randomBytes(32).toString('hex')}`;
        const target = configFile(token);
        try {
            fs.writeFileSync(target, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            try { fs.chmodSync(target, 0o600); } catch {}
            return token;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
    }
    throw new Error('Unable to allocate configuration token.');
}

function clientKey(req) {
    return String(
        req.headers['x-real-ip'] ||
        req.headers['x-forwarded-for'] ||
        req.socket?.remoteAddress ||
        'unknown'
    ).split(',')[0].trim();
}

function allowConfigCreate(req) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${clientKey(req)}:${minute}`;
    const used = (createBuckets.get(key) || 0) + 1;
    createBuckets.set(key, used);

    if (createBuckets.size > 2000) {
        for (const bucket of createBuckets.keys()) {
            const bucketMinute = Number(bucket.slice(bucket.lastIndexOf(':') + 1));
            if (bucketMinute < minute - 1) createBuckets.delete(bucket);
        }
    }
    return used <= 20;
}

function decodeBase64UrlConfig(value) {
    const stored = readStoredConfig(value);
    if (stored) return stored;

    try {
        const normalized = String(value || '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        return normalizeCredentials(JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')));
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

function secureConfigureHtml(html) {
    let output = String(html || '');
    output = output.replace(
        'Instalační konfigurace je v odkazu zapsaná jako Base64URL. Není běžně čitelná na první pohled, ale Base64 není šifrování, proto instalační odkaz nesdílej.',
        'Přihlašovací údaje se ukládají pouze na serveru. Instalační odkaz obsahuje náhodný přístupový token; odkaz proto stále nesdílej.'
    );

    const oldHandler = `document.getElementById('generate').addEventListener('click',()=>{
  const username=document.getElementById('username').value.trim();const passwordValue=password.value;const status=document.getElementById('status');document.getElementById('result').style.display='block';
  if(!username||!passwordValue){generatedToken='';document.getElementById('installUrl').value='';installBtn.href='#';status.textContent='Vyplň uživatelské jméno a heslo.';return;}
  generatedToken=toBase64Url({username,password:passwordValue});updateInstallLink();status.textContent=\`Připravený \${selectedMode==='direct'?'Direct test':'Hybrid'} odkaz pro \${selectedClient==='nuvio'?'Nuvio':'Stremio'}.\`;
});`;

    const newHandler = `document.getElementById('generate').addEventListener('click',async()=>{
  const username=document.getElementById('username').value.trim();const passwordValue=password.value;const status=document.getElementById('status');document.getElementById('result').style.display='block';
  if(!username||!passwordValue){generatedToken='';document.getElementById('installUrl').value='';installBtn.href='#';status.textContent='Vyplň uživatelské jméno a heslo.';return;}
  generateBtn.disabled=true;
  try{
    const basePath=location.pathname.replace(/\\/configure\\/?$/,'').replace(/\\/$/,'');
    const response=await fetch(\`\${basePath}/api/config\`,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({username,password:passwordValue})});
    if(!response.ok)throw new Error(\`HTTP \${response.status}\`);
    const data=await response.json();generatedToken=String(data&&data.token||'');
    if(!/^cfg\\.[a-f0-9]{64}$/.test(generatedToken))throw new Error('Neplatný token konfigurace.');
    updateInstallLink();status.textContent=\`Připravený bezpečný \${selectedMode==='direct'?'Direct test':'Hybrid'} odkaz pro \${selectedClient==='nuvio'?'Nuvio':'Stremio'}.\`;
  }catch(error){generatedToken='';document.getElementById('installUrl').value='';installBtn.href='#';status.textContent='Konfiguraci se nepodařilo bezpečně uložit. Zkus to znovu.';}
  finally{generateBtn.disabled=false;}
});`;

    if (!output.includes(oldHandler)) {
        throw new Error('Configure page structure changed; secure installer patch was not applied.');
    }
    return output.replace(oldHandler, newHandler);
}

app.disable('etag');
app.use(express.json({ limit: '8kb' }));

app.post('/api/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowConfigCreate(req)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many configuration requests.' });
    }

    try {
        const token = createStoredConfig(req.body);
        if (!token) return res.status(400).json({ error: 'Invalid configuration.' });
        return res.status(201).json({ token });
    } catch (error) {
        console.error('[config-store]', error.message);
        return res.status(500).json({ error: 'Configuration could not be stored.' });
    }
});

app.get(['/', '/configure'], (req, res) => {
    try {
        const source = fs.readFileSync(path.join(__dirname, 'public', 'configure.html'), 'utf8');
        res.setHeader('Cache-Control', 'no-store');
        return res.type('html').send(secureConfigureHtml(source));
    } catch (error) {
        console.error('[config-page]', error.message);
        return res.status(500).type('text/plain').send('Configuration page unavailable.');
    }
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

module.exports = { app, secureConfigureHtml };
