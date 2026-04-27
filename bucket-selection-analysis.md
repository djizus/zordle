# Zordle Bucket Selection Analysis

Last updated: 2026-04-27

This doc records the design exploration that shaped the lazy-boss rule
shipped in `contracts/src/systems/actions.cairo`. It captures the problem,
the data, and the rationale for the approach we landed on. The contract
itself is the source of truth for current behavior.

## Problem

The original contract picked a feedback bucket **uniformly at random over
non-empty patterns** for each guess. Every distinct feedback pattern that
at least one surviving candidate produced was equally likely.

That gave tiny buckets the same probability as huge buckets. With strong
opening guesses, many feedback patterns correspond to one- or two-word
buckets, so a player frequently collapsed the candidate set in a single
turn. Empirically, completion was hovering around 3 guesses.

## Data (against the 2,315-word NYT answer pool)

Best opener `trace` produces 150 non-empty buckets out of 243:

- min / p25 / p50 / p75 / max bucket size: `1 / 2 / 5 / 14 / 246`
- 32 of 150 buckets (21.3%) are singletons; 81 (54%) are ≤5
- Top 6 buckets hold 36% of the answer pool; remaining 144 share 64%

Under uniform-over-non-empty selection: expected survivors after one guess
= `15.43`. Under weighted-by-size selection: `74.02`. The two regimes feel
very different — one preserves "lucky split" variance, the other is
strictly grinding.

`scripts/pattern_distribution.mjs` regenerates these numbers for any
opener / pool combination.

## Approach considered and why we passed on them

- **Hard min-bucket-size filter (K)**: only buckets ≥ K candidates eligible.
  Clean math, but feels grafted on; one more constant to tune.
- **Pure weighted-random** (probability ∝ size): doc-recommended, halves
  the on-chain hot path, but flattens variance — every game looks
  statistically the same and lucky splits disappear entirely.
- **Empty-bucket selection** (uniform over all 243): incoherent under
  narrowing semantics; coherent under elimination semantics but the game
  doesn't converge in 6 guesses without other major changes.
- **Coarser pattern function** (fewer than 243 patterns): rejected because
  it changes what the player sees. Yellows must remain visible.

## What shipped

Two compounding changes, in `contracts/src/systems/actions.cairo`:

1. **Bucket selection weighted by `count^0.8`.** Sits between uniform and
   linear weighting. Cheap singleton collapses become rare, the game stays
   reachable in 6 turns, and the largest buckets aren't selected so often
   that variance disappears.
2. **Lazy candidate-bitmap materialization.** `start_practice` /
   `start_game` no longer write all `NUM_CHUNKS` candidate chunks. The
   first guess recomputes the initial bitmap in-memory; only chunks that
   actually change (or are non-zero on the first narrow) get persisted.
   Net effect: `start_practice` cost dropped 43% in measured slot fees.

Plus a difficulty knob from the **dictionary side**: the answer pool stays
the canonical 2,315 NYT words, but the guess vocabulary expanded to 14,855
words (`scripts/merged_valid_wordles.txt`). This raises bucket sizes
modestly without making any obscure word the answer.

## Public API

Unchanged:

- `guess(game_id, word_id)`, `start_practice`, `start_game`, `get_game`,
  `get_guess`, `get_chunk`, `get_dictionary`, `active_game_id`
- Client-side VRF salt: `poseidon(game_id, guesses_used, word_id)`
- `Guess.candidates_remaining`, `Game.guesses_used`, score semantics

The `Game` model gained two fields: `answer_count` (gates resume across
dictionary reloads) and `active_chunks` (per-game bitmap of which chunks
have surviving candidates). Frontend reads these — see
`client/src/chain/state.ts`.

## Verification

- `cd contracts && scarb test` (16 helper tests).
- `node scripts/pattern_distribution.mjs <opener>` for offline distribution
  sanity.
- Slot smoke test: `start_practice` + `guess` against the deployed slot
  world. See `docs/deploy.md` for runbook.

## Gas, measured on the slot

| Action | l2_gas | Mainnet ≈ ($9.24×10⁻¹⁰/gas) |
|---|---|---|
| `start_practice` | 5.30M | $0.005 |
| `guess` turn 1 (full 2315 walk) | ~1.4B | ~$1.30 |
| `guess` turn 2+ (narrowed) | ~30–270M | $0.03–$0.25 |

Per-game total typically lands around **$1.30–$1.70** on mainnet pricing.
Turn 1 dominates because the lazy boss must touch every surviving
candidate to compute bucket weights.
