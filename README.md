# Zordle

A fully on-chain Wordle clone built on [Dojo](https://dojoengine.org) and
deployed to [Cartridge](https://cartridge.gg) Katana. Daily-scheduled
practice mode is loginless via a burner; NFT mode runs on Sepolia.

**Play:** [zordle-azure.vercel.app](https://zordle-azure.vercel.app)

## How it works

The contract uses a "lazy boss" model — there is no preselected answer.
Each guess partitions the surviving candidate set by Wordle feedback
pattern, then picks one bucket weighted by `count^0.8`, narrows the
candidate set to that bucket, and shows the player the corresponding
3-color feedback. The boss commits to whichever word the player ends up
naming, as long as it's still in the candidate set.

Randomness comes from Cartridge VRF on Sepolia/mainnet, and from a
deterministic poseidon salt on practice slots.

See [`bucket-selection-analysis.md`](./bucket-selection-analysis.md) for
the full design rationale.

## Project layout

```
contracts/        Cairo / Dojo contracts (actions, setup, models)
client/           React + Vite frontend
scripts/          Deploy + dictionary loading + offline analysis tools
docs/             Operational runbooks
```

Key contract entry points (`contracts/src/systems/actions.cairo`):

- `start_practice()` / `start_game(token_id)` — begin a game
- `guess(game_id, word_id)` — submit a 5-letter word
- `get_game`, `get_guess`, `get_dictionary`, `active_game_id` — views

## Running locally

Prerequisites pinned in [`.tool-versions`](./.tool-versions):

- `scarb 2.15.1` (via [asdf](https://asdf-vm.com))
- `sozo 1.8.6`
- `starknet-foundry 0.55.0`
- Node 20+ with [pnpm](https://pnpm.io)

Boot a local Katana + Torii + dev client:

```bash
scripts/dev_up.sh
```

The script migrates the contracts, loads the 2,315-word answer pool +
12,540 guess-only words, finalizes the dictionary, and starts the Vite
dev server.

## Deploying

- **Practice slot** (Cartridge Katana): `scripts/deploy_slot.sh`
- **Sepolia NFT mode**: `scripts/deploy_sepolia.sh`

See [`docs/deploy.md`](./docs/deploy.md) for the full runbook including
when to bump `dojo_*.toml` seeds, when to force a dictionary reload, and
how to verify the deploy via `sozo call`.

## Testing

```bash
cd contracts && scarb test
```

CI runs this on every PR and push to `main` ([workflow](./.github/workflows/test.yml)).

For offline distribution analysis (different openers, different pools):

```bash
node scripts/pattern_distribution.mjs trace
node scripts/pattern_distribution.mjs slate --pool=merged --full
```

## Dictionaries

The on-chain dictionary holds 14,855 words split into two ranges:

- `[0, 2315)` — answer pool (NYT real wordles, in shuffled order)
- `[2315, 14855)` — guess-only (extra valid 5-letter words)

Source files in `scripts/`:

- `shuffled_real_wordles.txt` — 2,315 NYT answers (input to loader)
- `merged_valid_wordles.txt` — 14,855 valid Wordle words (full guess vocab)

`scripts/load_dictionary.mjs` packs words 10-per-`u256`, calls
`load_word_packs` in batches, and finalizes with `finalize_dictionary`.
The frontend reads the same ordering from `client/public/words.txt`.

## Credits

Built by [zKorp](https://github.com/z-korp). Dictionary derived from the
public NYT Wordle word lists.

## License

MIT — see [LICENSE](./LICENSE).
