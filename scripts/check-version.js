const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = file => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const lockRootVersion = lock && lock.packages && lock.packages[''] && lock.packages[''].version;
const failures = [];

if (lock.version !== pkg.version) {
  failures.push(`package-lock.json version (${lock.version}) != package.json (${pkg.version})`);
}
if (lockRootVersion !== pkg.version) {
  failures.push(`package-lock root package version (${lockRootVersion}) != package.json (${pkg.version})`);
}

const runtimeFile = "index.js";
const runtime = readText(runtimeFile);
if (!runtime.includes("require('./package.json').version")) {
  failures.push(`${runtimeFile} must read the runtime version from package.json`);
}

const configure = readText('public/configure.html');
if (/📦\s*Verze\s+\d+\.\d+\.\d+/.test(configure)) {
  failures.push('public/configure.html contains a hard-coded version');
}
if (!configure.includes("id=\"versionBadge\"") || !configure.includes('/health')) {
  failures.push('public/configure.html must load the displayed version from /health');
}

for (const readmeFile of ['README.md', 'README_EN.md']) {
  const readme = readText(readmeFile);
  if (!readme.includes('img.shields.io/github/package-json/v/')) {
    failures.push(`${readmeFile} must use the package.json-backed Shields version badge`);
  }
}

if (failures.length) {
  console.error('Version linkage check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Version linkage OK: ${pkg.name} v${pkg.version}`);
