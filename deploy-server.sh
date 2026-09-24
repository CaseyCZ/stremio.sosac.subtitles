#!/usr/bin/env bash
set -euo pipefail

cd "/home/ubuntu/stremio.sosac.subtitles"

if [[ "$(git branch --show-current)" != "Master" ]]; then
  echo "Refusing deploy: expected branch Master."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing deploy: tracked local changes are present."
  git status --short
  exit 1
fi

git fetch origin "Master"

read -r ahead behind < <(git rev-list --left-right --count HEAD...origin/Master)
if [[ "$ahead" != "0" ]]; then
  echo "Refusing deploy: server has $ahead local commit(s) not on GitHub."
  exit 1
fi

git merge --ff-only "origin/Master"

npm ci --omit=dev --no-audit --no-fund
npm run version:check
node --check server.js && node --check index.js && node --check ecosystem.config.js

pm2 restart "stremio-subtitles" --update-env
pm2 save

curl --retry 15 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:7001/configure >/dev/null

echo "stremio-subtitles deployed successfully from Master."
