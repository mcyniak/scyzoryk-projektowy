#!/usr/bin/env bash
# Uruchamia Scyzoryka w profilu linux-pilot. Zadna z istniejacych .cmd
# nie dziala na Linuksie - to jest ich odpowiednik do reczengo startu
# (docelowo zastapiony jednostka systemd, patrz docs/linux-pilot-install.md).
set -euo pipefail
cd "$(dirname "$0")"

export SCYZORYK_PROFILE="${SCYZORYK_PROFILE:-linux-pilot}"
export SCYZORYK_HOST="${SCYZORYK_HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec node server.js
