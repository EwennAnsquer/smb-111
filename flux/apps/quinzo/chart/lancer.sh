#!/usr/bin/env bash
# Lanceur Mac / Linux
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé : https://nodejs.org"
  exit 1
fi
[ -d node_modules/socket.io ] || npm install --omit=dev
node server.js
