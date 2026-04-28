# Deploy runbook

Four deploy targets: local dev, Cartridge practice slot, Sepolia NFT mode,
Mainnet NFT mode.

## Profiles

Each environment has its own Dojo profile and config:

| Env | Profile | Dojo config | Manifest |
|---|---|---|---|
| Local Katana | `dev` | `dojo_dev.toml` | `manifest_dev.json` (gitignored) |
| Practice slot | `slot` | `dojo_slot.toml` | `manifest_slot.json` (tracked) |
| Sepolia | `sepolia` | `dojo_sepolia.toml` | `manifest_sepolia.json` (tracked) |
| Mainnet | `mainnet` | `dojo_mainnet.toml` | `manifest_mainnet.json` (tracked) |

`manifest_slot.json`, `manifest_sepolia.json`, and `manifest_mainnet.json`
are tracked so contributors can run the client against the live worlds
without re-deploying. `manifest_dev.json` differs per machine and stays
gitignored.

## Local dev

```bash
scripts/dev_up.sh
```

Boots Katana + Torii, migrates contracts, loads the full dictionary, starts
Vite. Re-running `dev_up.sh` resets the local katana world.

## Practice slot (Cartridge Katana)

The slot world lives at `https://api.cartridge.gg/x/zordle-practice-slot/katana`.

### Required env

```bash
SLOT_ACCOUNT_ADDRESS=0x...   # prefunded katana account on the slot
SLOT_PRIVATE_KEY=0x...       # matching key
```

Get them with:

```bash
slot deployments accounts zordle-practice-slot katana
```

### Routine in-place upgrade

After modifying actions/setup logic but **not the model schemas**:

```bash
scripts/deploy_slot.sh
```

This runs `sozo migrate` (incremental class upgrade), preserves the world
address, and skips the dictionary load if it's already loaded. Dictionary
state survives the upgrade.

### Forced dictionary reload

When the dictionary contents change (new wordlist file, different
answer-count split, etc.) but the **model schema is unchanged**:

```bash
FORCE_DICTIONARY_RELOAD=1 scripts/deploy_slot.sh
```

This calls `setup.reset_dictionary()` (admin-only) before reloading. In-flight
games will start failing on `dict.assert_loaded()` until the reload finishes
(~6 min for 14,855 words). After the load, any pre-existing `Game` rows
referenced word_ids whose meaning may have changed — drain them or accept
they'll behave incorrectly.

### Schema change → fresh world

When you add/remove fields on a `#[dojo::model]` struct, `sozo migrate`
refuses with "Invalid new schema to upgrade the resource". Bump the world
seed in `dojo_slot.toml`:

```toml
seed = "zordle_practice_slot_v3"   # was v2
```

Then run a full forced-reload deploy:

```bash
FORCE_DICTIONARY_RELOAD=1 scripts/deploy_slot.sh
```

The new seed produces a new world address. The deploy script auto-rewrites
`client/.env.slot` and merges the practice-slot block into
`client/.env.sepolia` so the frontend picks up the new addresses on next
build.

### Verify

```bash
sozo call -P slot \
  --rpc-url https://api.cartridge.gg/x/zordle-practice-slot/katana \
  <ACTIONS_ADDR> get_dictionary
```

Expected fields (decoded): `id=0`, `word_count=14855`, `answer_count=2315`,
`loaded=1`.

Smoke-test by submitting a guess via `sozo execute ... guess <game_id> <word_id>`
and reading `get_guess(game_id, 0)`.

## Sepolia (NFT mode)

```bash
scripts/deploy_sepolia.sh
```

Drives `sozo migrate -P sepolia` against Sepolia, deploys the Denshokan
minigame component, writes `client/.env.sepolia`. NFT mint flow is gated by
the Denshokan contract referenced in `.env.sepolia.example`.

## Mainnet (NFT mode)

Same shape as Sepolia, but with explicit guardrails because every tx is real
STRK and the world creation is irreversible.

### Pre-deploy

1. Replace the Denshokan placeholder (`0x0`) in `dojo_mainnet.toml`'s
   `zordle_0_1-actions` `init_call_args` with the mainnet MinigameToken
   address. The deploy script aborts if the placeholder is still present.
2. Fund the deployer address with enough STRK for migrate + the
   ~14855-tx dictionary load. See gas reference below.

### Required env

```bash
MAINNET_CONFIRM=YES          # explicit go-ahead, real money
DEPLOYER_ADDRESS=0x...       # mainnet account paying for migration + dict load
DEPLOYER_PRIVATE_KEY=0x...   # matching key
```

### Run

```bash
MAINNET_CONFIRM=YES \
DEPLOYER_ADDRESS=0x... \
DEPLOYER_PRIVATE_KEY=0x... \
  bash scripts/deploy_mainnet.sh
```

Same shape as `deploy_sepolia.sh`: `sozo build -P mainnet` →
`sozo migrate -P mainnet` (5x retry/backoff) → write
`manifest_mainnet.json` and `client/.env.mainnet` →
`load_dictionary.mjs` (idempotent, skips if `loaded == 1`). Re-running on
the same world is safe; class upgrades migrate incrementally.

### Client

```bash
cd client && pnpm install && pnpm dev --mode mainnet
```

Vite mode `mainnet` loads `client/.env.mainnet`. The
`VITE_PUBLIC_DOJO_PROFILE=mainnet` env var routes `networkConfig.ts` and
`cartridgeConnector.ts` to `manifest_mainnet.json` and the `SN_MAIN`
chain.

## Common pitfalls

- **Forgot to bump the seed after a model change** → "Invalid new schema"
  during migrate. Bump and redeploy.
- **`SLOT_PRIVATE_KEY` from your shell history doesn't match the slot
  account** → migrate fails on signature verification. Re-fetch via
  `slot deployments accounts ...`.
- **Reloaded the dictionary while a game was active** → the player's
  candidate bitmap silently misaligns with the new wordlist. Drain games
  before forced reloads, or accept the breakage in dev/practice envs.
- **`MAX_ANSWER_COUNT` ceiling hit** → `finalize_dictionary` reverts with
  `TOO_MANY_ANSWERS`. Bump `NUM_CHUNKS` in `contracts/src/constants.cairo`.
  Note: changing `NUM_CHUNKS` does not by itself trigger a schema upgrade
  (the candidate bitmap is one row per chunk, keyed by `(game_id, index)`).

## Gas reference

Approximate slot-measured costs (extrapolated to mainnet at
~$9.24×10⁻¹⁰/l2_gas):

| Action | l2_gas | Mainnet ≈ |
|---|---|---|
| `start_practice` | 5.30M | $0.005 |
| `guess` turn 1 (full 2315 walk) | ~1.4B | ~$1.30 |
| `guess` turn 2+ (narrowed) | 30–270M | $0.03–$0.25 |

Per-game total typically $1.30–$1.70 mainnet.
