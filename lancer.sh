#!/usr/bin/env bash
# Demarre CutLocal. Laissez ce terminal ouvert pendant le montage.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  printf '\n  Node.js est introuvable.\n  Lancez d abord ./installer.sh\n\n'
  exit 1
fi

exec node server/server.js
