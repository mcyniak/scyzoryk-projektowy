#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
node scripts/install-all.js || exit 1
node server.js
