#!/usr/bin/env bash
# Boots local katana, migrates the world, loads the dictionary, and writes
# client/.env.local. After this completes:
#
#   cd client && pnpm dev
#
# Requires: katana, sozo, jq, node, pnpm.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/.dev"
mkdir -p "$LOG_DIR"
KATANA_LOG="$LOG_DIR/katana.log"
PID_FILE="$LOG_DIR/katana.pid"
RPC="http://localhost:5050"

# --- 1. (re)start katana --------------------------------------------------

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Stopping existing katana (pid $(cat "$PID_FILE"))"
  kill "$(cat "$PID_FILE")" || true
  sleep 1
fi

echo "Starting katana..."
: > "$KATANA_LOG"
katana --config "$ROOT/katana_dev.toml" >> "$KATANA_LOG" 2>&1 &
echo $! > "$PID_FILE"

# Wait for katana to accept RPC (poll, but bail after ~30s).
for _ in {1..60}; do
  if curl -sf -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","method":"starknet_chainId","params":[],"id":1}' \
       "$RPC" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf -X POST -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","method":"starknet_chainId","params":[],"id":1}' \
     "$RPC" >/dev/null 2>&1; then
  echo "ERROR: katana did not come up. Tail of $KATANA_LOG:"
  tail -40 "$KATANA_LOG"
  exit 1
fi

# --- 2. extract first prefunded account -----------------------------------

# Accept env override; otherwise scrape the log. Katana prints account
# blocks like:
#   | Account address |  0x...
#   | Private key     |  0x...
ACCOUNT="${ACCOUNT_ADDRESS:-$(grep -i -A1 'account address' "$KATANA_LOG" | grep -oE '0x[0-9a-fA-F]{40,66}' | head -1)}"
PRIVKEY="${PRIVATE_KEY:-$(grep -i -A1 'private key' "$KATANA_LOG" | grep -oE '0x[0-9a-fA-F]{40,66}' | head -1)}"

if [[ -z "$ACCOUNT" || -z "$PRIVKEY" ]]; then
  echo "ERROR: could not extract a prefunded account from $KATANA_LOG."
  echo "Set ACCOUNT_ADDRESS and PRIVATE_KEY env vars and re-run."
  exit 1
fi

echo "Account: $ACCOUNT"

# --- 3. build + migrate ---------------------------------------------------

echo "Building..."
sozo build

echo "Migrating world..."
sozo migrate \
  --rpc-url "$RPC" \
  --account-address "$ACCOUNT" \
  --private-key "$PRIVKEY" \
  2>&1 | tee "$LOG_DIR/migrate.log"

# --- 4. extract addresses from manifest -----------------------------------

MANIFEST="$ROOT/manifest_dev.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "ERROR: $MANIFEST not found after migrate."
  exit 1
fi

WORLD=$(jq -r '.world.address' "$MANIFEST")
ACTIONS=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-actions") | .address' "$MANIFEST")
SETUP=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-setup") | .address' "$MANIFEST")

echo "World:   $WORLD"
echo "Actions: $ACTIONS"
echo "Setup:   $SETUP"

# --- 5. write client env + serve words.txt -------------------------------

cat > "$ROOT/client/.env.local" <<EOF
VITE_PUBLIC_NODE_URL=$RPC
VITE_PUBLIC_BURNER_ADDRESS=$ACCOUNT
VITE_PUBLIC_BURNER_PRIVATE_KEY=$PRIVKEY
VITE_PUBLIC_ACTIONS_ADDRESS=$ACTIONS
EOF

mkdir -p "$ROOT/client/public"
# Note: load_dictionary.mjs writes client/public/words.txt as its last step,
# so the file is guaranteed to match the on-chain word_id ordering.

# --- 6. install + run loader ---------------------------------------------

if [[ ! -d "$ROOT/scripts/node_modules" ]]; then
  echo "Installing scripts deps..."
  (cd "$ROOT/scripts" && pnpm install --silent)
fi

echo "Loading dictionary..."
NODE_URL="$RPC" \
ACCOUNT_ADDRESS="$ACCOUNT" \
PRIVATE_KEY="$PRIVKEY" \
SETUP_ADDRESS="$SETUP" \
  node "$ROOT/scripts/load_dictionary.mjs"

echo ""
echo "Ready. Run:  cd client && pnpm dev"
echo "Then open:   http://localhost:5173"
echo ""
echo "Katana log:  $KATANA_LOG"
echo "Stop katana: kill \$(cat $PID_FILE)"
