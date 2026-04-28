#!/usr/bin/env bash
# Zordle — Mainnet deploy orchestrator.
#
# Required env vars:
#   MAINNET_CONFIRM=YES    Mandatory confirmation gate. Mainnet costs real STRK.
#   DEPLOYER_ADDRESS       Mainnet account that pays for the migration + dict load.
#                          Must be funded with STRK (or ETH if your account uses v2 fees).
#   DEPLOYER_PRIVATE_KEY   The matching key. Don't commit it.
#
# Optional:
#   RPC_URL                Override the Mainnet RPC. Defaults to Cartridge's managed
#                          endpoint (free, no key, decent SLA): https://api.cartridge.gg/x/starknet/mainnet
#
# Side effects:
#   - writes manifest_mainnet.json at the repo root
#   - writes client/.env.mainnet with the deployed addresses
#   - writes client/public/words.txt as part of the dictionary load
#
# Pre-deploy checklist:
#   - Verify dojo_mainnet.toml's "zordle_0_1-actions" init_call_args uses the
#     known mainnet MinigameToken (Denshokan) address. The script aborts if not.
#   - Verify the deployer is funded for migrate plus the batched dictionary
#     load. Per-game gas reference: docs/deploy.md.
#
# Idempotency:
#   - sozo migrate is incremental: re-running with the same dojo_mainnet.toml +
#     funded account is safe.
#   - load_dictionary.mjs is NOT incremental beyond a per-batch granularity. If
#     the load fails partway through, see the note in scripts/load_dictionary.mjs
#     about adjusting start_pack_id to resume.
#
# Usage:
#   MAINNET_CONFIRM=YES \
#   DEPLOYER_ADDRESS=0x... \
#   DEPLOYER_PRIVATE_KEY=0x... \
#     bash scripts/deploy_mainnet.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE="mainnet"
MANIFEST="$ROOT/manifest_mainnet.json"
PRACTICE_MANIFEST="$ROOT/manifest_slot.json"
DOJO_CONFIG="$ROOT/dojo_mainnet.toml"
CLIENT_ENV="$ROOT/client/.env.mainnet"
DEFAULT_RPC="https://api.cartridge.gg/x/starknet/mainnet"
EXPECTED_MAINNET_DENSHOKAN="0x00263cc540dac11334470a64759e03952ee2f84a290e99ba8cbc391245cd0bf9"
PRACTICE_SLOT_NAME="${PRACTICE_SLOT_NAME:-zordle-practice-slot}"
PRACTICE_RPC_URL="${PRACTICE_RPC_URL:-https://api.cartridge.gg/x/${PRACTICE_SLOT_NAME}/katana}"
DOJO_CONFIG_BAK="$ROOT/.dojo_mainnet.toml.bak.$$"

restore_dojo_config() {
  if [[ -f "$DOJO_CONFIG_BAK" ]]; then
    mv "$DOJO_CONFIG_BAK" "$DOJO_CONFIG"
  fi
}
trap restore_dojo_config EXIT

# --- ANSI helpers --------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $1"; }
fail()  { echo -e "${RED}[deploy]${NC} $1" >&2; }

# --- 0. Validate environment --------------------------------------------

if [[ "${MAINNET_CONFIRM:-}" != "YES" ]]; then
  fail "Mainnet deploys require explicit confirmation."
  echo "  Re-run with MAINNET_CONFIRM=YES if you really intend to deploy on mainnet."
  echo "  This is real money: world creation, batched dictionary load, irreversible."
  exit 1
fi

if [[ ! -f "$DOJO_CONFIG" ]]; then
  fail "Missing $DOJO_CONFIG."
  exit 1
fi

# Refuse to run unless the actions contract is wired to the known mainnet
# MinigameToken. A wrong nonzero Denshokan address is worse than a placeholder:
# the deployed world would be permanently wired to the wrong NFT gate.
CONFIG_DENSHOKAN=$(perl -0ne 'if (/"zordle_0_1-actions"\s*=\s*\[\s*"[^"]+"\s*,\s*"([^"]+)"/s) { print $1 }' "$DOJO_CONFIG")
if [[ "$CONFIG_DENSHOKAN" != "$EXPECTED_MAINNET_DENSHOKAN" ]]; then
  fail "Unexpected Denshokan address in $DOJO_CONFIG."
  echo "  Found:    ${CONFIG_DENSHOKAN:-<missing>}"
  echo "  Expected: $EXPECTED_MAINNET_DENSHOKAN"
  exit 1
fi

if [[ -z "${DEPLOYER_ADDRESS:-}" || -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  fail "DEPLOYER_ADDRESS and DEPLOYER_PRIVATE_KEY must be set in your env."
  echo "  example:"
  echo "    MAINNET_CONFIRM=YES DEPLOYER_ADDRESS=0x... DEPLOYER_PRIVATE_KEY=0x... \\"
  echo "      bash scripts/deploy_mainnet.sh"
  exit 1
fi

RPC_URL="${RPC_URL:-$DEFAULT_RPC}"

if [[ ! -f "$PRACTICE_MANIFEST" ]]; then
  fail "Missing $PRACTICE_MANIFEST."
  echo "  Mainnet client env includes practice mode; deploy the slot first or restore manifest_slot.json."
  exit 1
fi

for dep in sozo jq node perl; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    fail "Required tool not found: $dep"
    exit 1
  fi
done

info "Profile:  $PROFILE"
info "RPC:      $RPC_URL"
info "Account:  $DEPLOYER_ADDRESS"
warn "Target:   MAINNET — real STRK will be spent."
echo "============================================"

# Keep the profile free of account-specific deployer state. The actions
# creator metadata and setup dictionary admin must both match this deployer.
cp "$DOJO_CONFIG" "$DOJO_CONFIG_BAK"
DEPLOYER_ADDRESS="$DEPLOYER_ADDRESS" perl -0pi -e \
  's/("zordle_0_1-actions"\s*=\s*\[\s*)"[^\"]+"/$1"$ENV{DEPLOYER_ADDRESS}"/s;
   s/("zordle_0_1-setup"\s*=\s*\[\s*)"[^\"]+"/$1"$ENV{DEPLOYER_ADDRESS}"/s' \
  "$DOJO_CONFIG"

# --- 1. Build ------------------------------------------------------------

info "Step 1/4 — sozo build -P $PROFILE"
sozo build -P "$PROFILE"

# --- 2. Migrate (with retry — Mainnet RPCs are sometimes flaky) ----------

info "Step 2/4 — sozo migrate -P $PROFILE"
ATTEMPT=0
MAX_ATTEMPTS=5
BACKOFF=60

migrate_once() {
  sozo migrate -P "$PROFILE" \
    --rpc-url "$RPC_URL" \
    --account-address "$DEPLOYER_ADDRESS" \
    --private-key "$DEPLOYER_PRIVATE_KEY"
}

until migrate_once; do
  ATTEMPT=$((ATTEMPT + 1))
  if (( ATTEMPT >= MAX_ATTEMPTS )); then
    fail "migrate failed after $MAX_ATTEMPTS attempts."
    exit 1
  fi
  warn "migrate attempt $ATTEMPT failed; retrying in ${BACKOFF}s…"
  sleep "$BACKOFF"
  BACKOFF=$((BACKOFF * 2))
done

# --- 3. Pull addresses out of the freshly-written manifest ---------------

if [[ ! -f "$MANIFEST" ]]; then
  fail "$MANIFEST not generated by sozo migrate. Aborting."
  exit 1
fi

WORLD=$(jq -r '.world.address' "$MANIFEST")
ACTIONS=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-actions") | .address' "$MANIFEST")
SETUP=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-setup") | .address' "$MANIFEST")
DENSHOKAN=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-actions") | .init_calldata[1]' "$MANIFEST")
PRACTICE_WORLD=$(jq -r '.world.address' "$PRACTICE_MANIFEST")
PRACTICE_ACTIONS=$(jq -r '.contracts[] | select(.tag == "zordle_0_1-actions") | .address' "$PRACTICE_MANIFEST")

if [[ -z "$WORLD" || -z "$ACTIONS" || -z "$SETUP" ]]; then
  fail "Failed to extract one or more addresses from $MANIFEST"
  echo "  WORLD=$WORLD ACTIONS=$ACTIONS SETUP=$SETUP"
  exit 1
fi

if [[ "$DENSHOKAN" != "$EXPECTED_MAINNET_DENSHOKAN" ]]; then
  fail "Migrated Actions contract has unexpected Denshokan init calldata."
  echo "  Found:    ${DENSHOKAN:-<missing>}"
  echo "  Expected: $EXPECTED_MAINNET_DENSHOKAN"
  exit 1
fi

if [[ -z "$PRACTICE_WORLD" || -z "$PRACTICE_ACTIONS" || "$PRACTICE_WORLD" == "null" || "$PRACTICE_ACTIONS" == "null" ]]; then
  fail "Failed to extract practice addresses from $PRACTICE_MANIFEST"
  exit 1
fi

info "World:     $WORLD"
info "Actions:   $ACTIONS"
info "Setup:     $SETUP"
info "Denshokan: $DENSHOKAN"

# --- 4. Write client env + run dictionary loader -------------------------

info "Step 3/4 — writing $CLIENT_ENV"
cat > "$CLIENT_ENV" <<EOF
# Generated by scripts/deploy_mainnet.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
#
# Each player connects with their own Cartridge Controller account; the
# deployer's credentials never reach the client. This file is committed
# so contributors can run the client against the live world.
VITE_PUBLIC_DOJO_PROFILE=mainnet
VITE_PUBLIC_NODE_URL=$RPC_URL
VITE_PUBLIC_NODE_URL_NFT=$RPC_URL
VITE_PUBLIC_NAMESPACE=zordle_0_1
VITE_PUBLIC_NAMESPACE_NFT=zordle_0_1
VITE_PUBLIC_SLOT=zordle-mainnet
VITE_PUBLIC_SLOT_NFT=zordle-mainnet
VITE_PUBLIC_CHAIN_ID_NFT=SN_MAIN
VITE_PUBLIC_WORLD_ADDRESS=$WORLD
VITE_PUBLIC_ACTIONS_ADDRESS=$ACTIONS
VITE_PUBLIC_WORLD_ADDRESS_NFT=$WORLD
VITE_PUBLIC_ACTIONS_ADDRESS_NFT=$ACTIONS
VITE_PUBLIC_DENSHOKAN_ADDRESS=$DENSHOKAN
VITE_PUBLIC_VRF_ADDRESS=0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f
VITE_PUBLIC_VRF_ADDRESS_NFT=0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f

# --- practice slot (begin) ---
VITE_PUBLIC_NAMESPACE_PRACTICE=zordle_0_1
VITE_PUBLIC_SLOT_PRACTICE=$PRACTICE_SLOT_NAME
VITE_PUBLIC_NODE_URL_PRACTICE=$PRACTICE_RPC_URL
VITE_PUBLIC_CHAIN_ID_PRACTICE=WP_ZORDLE_PRACTICE_SLOT
VITE_PUBLIC_WORLD_ADDRESS_PRACTICE=$PRACTICE_WORLD
VITE_PUBLIC_ACTIONS_ADDRESS_PRACTICE=$PRACTICE_ACTIONS
VITE_PUBLIC_VRF_ADDRESS_PRACTICE=0x0
# --- practice slot (end) ---
EOF

if [[ ! -d "$ROOT/scripts/node_modules" ]]; then
  info "Installing scripts deps…"
  (cd "$ROOT/scripts" && pnpm install --silent)
fi

# Skip the dictionary load on incremental redeploys — the setup contract
# rejects re-loading via dict.assert_not_loaded(). Read the `loaded` flag
# (last felt of the get_dictionary view's struct) and bail early if set.
is_dict_loaded() {
  local out last
  out=$(sozo call -P "$PROFILE" --rpc-url "$RPC_URL" "$ACTIONS" get_dictionary 2>/dev/null) || return 1
  last=$(echo "$out" | tr -d '[]' | awk '{ print $NF }' | sed 's/^0x0x/0x/')
  [[ "$last" =~ ^0x0*1$ ]]
}

if is_dict_loaded; then
  info "Step 4/4 — dictionary already loaded on Mainnet, skipping"
else
  info "Step 4/4 — loading dictionary onto Mainnet (this can take 15-30 minutes)"
  warn "Each tx is real STRK on mainnet. Make sure the deployer is well-funded;"
  warn "see docs/deploy.md gas reference."
  NODE_URL="$RPC_URL" \
  ACCOUNT_ADDRESS="$DEPLOYER_ADDRESS" \
  PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  SETUP_ADDRESS="$SETUP" \
    node "$ROOT/scripts/load_dictionary.mjs"
fi

# --- 5. Summary ----------------------------------------------------------

echo ""
echo "============================================"
info "Mainnet deploy complete."
echo ""
echo "  World:     $WORLD"
echo "  Actions:   $ACTIONS"
echo "  Setup:     $SETUP"
echo "  Denshokan: $DENSHOKAN"
echo ""
echo "  Manifest: $MANIFEST"
echo "  Client env written: $CLIENT_ENV"
echo ""
echo "Build the client against this deploy:"
echo "  cd client && pnpm install && pnpm build --mode mainnet"
echo ""
echo "Or run a dev preview:"
echo "  cd client && pnpm install && pnpm dev --mode mainnet"
echo "============================================"
