#!/usr/bin/env bash
# InferMesh — Orbio API key setup helper
# Run this script from the Code panel terminal OR click the Run button.
#
# HOW TO USE:
#   1. When prompted, paste your Orbio API key (from orbio.so).
#   2. Press Enter.
#   3. The key is written to .env — it is never echoed to the screen.
#   4. The backend is restarted automatically.
#   5. The health check confirms the key was loaded (true/false only, never the key itself).

set -euo pipefail

ENV_FILE="$(dirname "$0")/.env"

echo ""
echo "========================================"
echo " InferMesh — Orbio API Key Setup"
echo "========================================"
echo ""
echo "Your key will NOT be displayed as you type."
echo "Paste it and press Enter."
echo ""

# -s flag hides input (no echo to screen)
read -r -s -p "Paste your ORBIO_API_KEY: " NEW_KEY
echo ""  # newline after hidden input

if [ -z "$NEW_KEY" ]; then
  echo "No key entered. Exiting without changes."
  exit 1
fi

# Update only the ORBIO_API_KEY line; leave all other lines untouched.
if grep -q '^ORBIO_API_KEY=' "$ENV_FILE"; then
  # Line exists — replace its value
  sed -i "s|^ORBIO_API_KEY=.*|ORBIO_API_KEY=${NEW_KEY}|" "$ENV_FILE"
  echo "Updated ORBIO_API_KEY in .env"
else
  # Line missing — append it
  printf '\n# Orbio inference gateway\nORBIO_API_KEY=%s\n' "$NEW_KEY" >> "$ENV_FILE"
  echo "Added ORBIO_API_KEY to .env"
fi

# Clear the variable from this shell's memory immediately
unset NEW_KEY

echo ""
echo "Restarting backend server..."
pkill -f 'server/index.ts' 2>/dev/null || true
sleep 1
nohup bun run "$(dirname "$0")/server/index.ts" > /tmp/backend.log 2>&1 &
sleep 2

echo ""
echo "Checking backend health..."
HEALTH=$(curl -s http://localhost:3001/health 2>/dev/null || echo '{"ok":false,"hasApiKey":false}')
echo "Health response: $HEALTH"

if echo "$HEALTH" | grep -q '"hasApiKey":true'; then
  echo ""
  echo "SUCCESS: Backend detected the API key."
  echo "The Playground warning banner will now disappear."
else
  echo ""
  echo "WARNING: Backend did not detect the key yet."
  echo "Check /tmp/backend.log for errors."
fi

echo ""
echo "Done. You can delete set-orbio-key.sh after setup if you wish."
