#!/usr/bin/env bash
# Lanceur Docker pour Mac / Linux
set -e
cd "$(dirname "$0")"
PORT="${QUINZO_PORT:-3000}"
if [ -z "$PUBLIC_HOST" ]; then
  if command -v ip >/dev/null 2>&1; then
    PUBLIC_HOST=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  fi
  if [ -z "$PUBLIC_HOST" ] && [ "$(uname)" = "Darwin" ]; then
    PUBLIC_HOST=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  fi
fi
export PUBLIC_HOST QUINZO_PORT="$PORT"
echo "Adresse de ce PC : ${PUBLIC_HOST:-inconnue}"
mkdir -p data
docker compose up -d --build
sleep 3
URL="http://localhost:${PORT}/host"
echo
echo "  Écran hôte : $URL"
echo "  Tes potes  : http://${PUBLIC_HOST:-<ip-de-ce-pc>}:${PORT}"
echo "  Arrêt      : docker compose down"
( command -v xdg-open >/dev/null && xdg-open "$URL" ) || ( command -v open >/dev/null && open "$URL" ) || true
