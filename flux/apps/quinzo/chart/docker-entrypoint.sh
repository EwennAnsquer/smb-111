#!/bin/sh
# Prépare /data (dossier monté depuis ton PC) puis lance Quinzo sans les droits root.
set -e
mkdir -p /data/themes
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec su-exec node "$@"
fi
# Déjà lancé sans root (Kubernetes, docker run --user…) : on démarre directement.
exec "$@"
