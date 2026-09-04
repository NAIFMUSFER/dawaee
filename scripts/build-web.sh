#!/usr/bin/env bash
# Builds the mobile app for web and inlines it into ONE self-contained HTML
# file that the API serves from its own origin.
#
# Same origin is the point: a browser build hosted elsewhere cannot call this
# API, because the static hosts it would live on forbid cross-origin fetch
# outright — the request never leaves the page and CORS cannot rescue it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${API_URL:-}"   # empty means "same origin as this page"

cd "$ROOT/apps/mobile"
[ -d node_modules ] || npm ci --legacy-peer-deps
rm -rf dist .expo
EXPO_PUBLIC_DEMO=0 EXPO_PUBLIC_API_URL="$API_URL" npx expo export --platform web --clear

python3 "$ROOT/scripts/inline-web.py" "$ROOT/apps/mobile/dist" "$ROOT/apps/api/public/index.html"
echo "wrote apps/api/public/index.html"
