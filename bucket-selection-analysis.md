# Zordle Contract Bucket Selection Analysis

Date: 2026-04-27

## Summary

The current contract does not preselect a hidden answer. Instead, each guess partitions the current answer candidate set into Wordle feedback buckets, then picks one non-empty feedback bucket uniformly at random.

That rule makes the game easier than intended because tiny buckets are just as likely as large buckets. Strong opening guesses create many one-word or very-small buckets, so a player can often collapse the candidate set in one or two turns. This matches the observation that completion currently feels close to 3 guesses.

The recommended change is to select the feedback bucket with probability proportional to its candidate count. Equivalently, choose one surviving answer candidate uniformly at random, compute the feedback pattern for that sampled candidate, then keep all candidates with that pattern.

This preserves randomness and VRF fairness, but removes the current bias toward tiny buckets.

## Current Contract Behavior

Relevant files:

- `contracts/src/systems/actions.cairo`
- `contracts/src/constants.cairo`
- `contracts/src/helpers/bitmap.cairo`
- `contracts/src/helpers/wordle.cairo`
- `contracts/src/models/index.cairo`
- `contracts/src/store.cairo`
- `contracts/src/systems/setup.cairo`

Dictionary layout:

- `word_id` range `[0 .. answer_count)` is the answer pool.
- `word_id` range `[answer_count .. word_count)` is guess-only.
- Guess-only words are valid submitted guesses, but are never included in the answer candidate bitmap.
- The current shipped answer pool has `2315` words.
- The full allowed guess vocabulary has `12972` words.

Candidate storage:

- Each game stores candidates as `CandidateChunk` rows.
- Each chunk is a `u256` bitmap.
- `NUM_CHUNKS = 10`, enough for `10 * 256 = 2560` answer candidates.
- At game start, the contract sets bits for every answer word and leaves guess-only words out.

Guess flow today:

1. Validate game, owner, guess count, dictionary, and `word_id`.
2. Read the guessed word letters.
3. Snapshot all candidate chunks into memory.
4. Pass 1:
   - Walk every surviving candidate.
   - Compute `compute_pattern(guess, candidate)`.
   - Mark the pattern as seen in `pattern_seen`.
   - Append each candidate pattern to `pattern_stream`.
5. Pick a uniformly random non-empty pattern:
   - `bucket_count = popcount(pattern_seen)`.
   - `k = random % bucket_count`.
   - `chosen_pattern = kth_set_bit_u256(pattern_seen, k)`.
6. Pass 2:
   - Re-walk candidates.
   - Read each candidate pattern from `pattern_stream`.
   - Keep candidates whose pattern equals `chosen_pattern`.
7. Log the guess and update win/loss state.

The important point is that the contract picks uniformly over feedback patterns, not uniformly over answer candidates.

## Why The Current Rule Is Easy

Uniform non-empty bucket selection makes every possible feedback pattern equally likely after a guess, regardless of how many answer words produce that pattern.

For a strong opener, many feedback patterns correspond to tiny buckets. Under the current rule, those small buckets are overrepresented.

Example: opener `trace`

- Non-empty feedback patterns: `150`
- Bucket sizes:
  - min: `1`
  - p25: `2`
  - p50: `5`
  - p75: `14`
  - max: `246`
- Current uniform-over-patterns expected survivors: `15.43`
- Current probabilities:
  - `P(size = 1) = 21.3%`
  - `P(size <= 5) = 54.0%`
  - `P(size <= 20) = 82.7%`
  - `P(size > 100) = 4.0%`

That means a strong first guess has more than a 50% chance to leave five or fewer candidates. This makes 2-3 guess wins much more likely than normal Wordle-style play.

## Weighted Random Bucket Selection

Weighted bucket selection chooses feedback with probability proportional to the number of candidates in that bucket.

Implementation-equivalent version:

1. Count total surviving candidates.
2. Pick `selected_ordinal = random % total_candidates`.
3. Find the candidate at that ordinal in the candidate bitmap.
4. Compute `chosen_pattern = compute_pattern(guess, sampled_candidate)`.
5. Keep every candidate that produces `chosen_pattern`.

This is equivalent to picking a hidden answer uniformly from the current surviving candidate set for this turn, then returning the feedback for that sampled answer.

It does not permanently commit to a hidden answer across turns, because after narrowing, the next guess repeats the same process over the remaining candidate set. The game remains a lazy stochastic Wordle engine, but without favoring tiny buckets.

## Distribution Data

Measured against:

- Answer list: `scripts/shuffled_real_wordles.txt`
- Guess vocabulary: answer list plus `scripts/official_allowed_guesses.txt`
- Answer count: `2315`
- Allowed guesses: `12972`

### Best First Guess By Policy

Current uniform non-empty bucket:

- Best opener by expected survivors: `trace`
- Non-empty patterns: `150`
- Expected survivors under current rule: `15.43`
- Expected survivors under weighted rule for same opener: `74.02`
- Largest bucket: `246`
- Singleton buckets: `32`

Weighted by candidate count:

- Best opener by weighted expected survivors: `roate`
- Non-empty patterns: `126`
- Expected survivors under current rule: `18.37`
- Expected survivors under weighted rule: `60.42`
- Largest bucket: `195`
- Singleton buckets: `23`

Minimax largest bucket:

- Best opener by largest bucket: `raise`
- Non-empty patterns: `132`
- Expected survivors under current rule: `17.54`
- Expected survivors under weighted rule: `61.00`
- Largest bucket: `168`
- Singleton buckets: `28`

### Opener Comparison

#### `trace`

- Non-empty patterns: `150`
- Bucket size min/p25/p50/p75/max: `1 / 2 / 5 / 14 / 246`
- Current uniform expected survivors: `15.43`
- Current probabilities:
  - `P(size = 1) = 21.3%`
  - `P(size <= 5) = 54.0%`
  - `P(size <= 20) = 82.7%`
  - `P(size > 100) = 4.0%`
- Weighted expected survivors: `74.02`
- Weighted probabilities:
  - `P(size = 1) = 1.4%`
  - `P(size <= 5) = 7.8%`
  - `P(size <= 20) = 29.2%`
  - `P(size > 100) = 35.7%`

#### `roate`

- Non-empty patterns: `126`
- Bucket size min/p25/p50/p75/max: `1 / 2 / 7 / 21 / 195`
- Current uniform expected survivors: `18.37`
- Current probabilities:
  - `P(size = 1) = 18.3%`
  - `P(size <= 5) = 43.7%`
  - `P(size <= 20) = 72.2%`
  - `P(size > 100) = 3.2%`
- Weighted expected survivors: `60.42`
- Weighted probabilities:
  - `P(size = 1) = 1.0%`
  - `P(size <= 5) = 5.2%`
  - `P(size <= 20) = 23.0%`
  - `P(size > 100) = 22.2%`

#### `raise`

- Non-empty patterns: `132`
- Bucket size min/p25/p50/p75/max: `1 / 2 / 6 / 20 / 168`
- Current uniform expected survivors: `17.54`
- Current probabilities:
  - `P(size = 1) = 21.2%`
  - `P(size <= 5) = 48.5%`
  - `P(size <= 20) = 75.0%`
  - `P(size > 100) = 3.8%`
- Weighted expected survivors: `61.00`
- Weighted probabilities:
  - `P(size = 1) = 1.2%`
  - `P(size <= 5) = 6.5%`
  - `P(size <= 20) = 24.9%`
  - `P(size > 100) = 26.0%`

#### `slate`

- Non-empty patterns: `147`
- Bucket size min/p25/p50/p75/max: `1 / 2 / 5 / 15 / 221`
- Current uniform expected survivors: `15.75`
- Current probabilities:
  - `P(size = 1) = 19.7%`
  - `P(size <= 5) = 50.3%`
  - `P(size <= 20) = 81.6%`
  - `P(size > 100) = 2.7%`
- Weighted expected survivors: `71.57`
- Weighted probabilities:
  - `P(size = 1) = 1.3%`
  - `P(size <= 5) = 7.1%`
  - `P(size <= 20) = 29.3%`
  - `P(size > 100) = 27.2%`

#### `crane`

- Non-empty patterns: `142`
- Bucket size min/p25/p50/p75/max: `1 / 2 / 5 / 13 / 263`
- Current uniform expected survivors: `16.30`
- Current probabilities:
  - `P(size = 1) = 20.4%`
  - `P(size <= 5) = 52.8%`
  - `P(size <= 20) = 80.3%`
  - `P(size > 100) = 3.5%`
- Weighted expected survivors: `78.74`
- Weighted probabilities:
  - `P(size = 1) = 1.3%`
  - `P(size <= 5) = 7.4%`
  - `P(size <= 20) = 25.7%`
  - `P(size > 100) = 32.3%`

## Gas Efficiency Notes

Current approach:

- Computes one pattern per candidate in pass 1.
- Appends one `u8` pattern per candidate to `pattern_stream`.
- Computes a 243-bit pattern bitmap.
- Popcounts the pattern bitmap.
- Finds the `k`th set pattern bit.
- Re-walks candidates and reads one stream item per candidate in pass 2.

Weighted approach:

- Popcounts candidate chunks to count total live candidates.
- Selects one candidate ordinal.
- Finds that sampled candidate and computes one pattern.
- Re-walks candidates and computes patterns while narrowing.

Expected gas impact:

- Removes `pattern_stream` append/read overhead.
- Removes `pattern_seen` bit setting.
- Removes `Bitmap::popcount(pattern_seen)`.
- Removes `kth_set_bit_u256(pattern_seen, k)`.
- Adds candidate chunk popcounts and one sampled-candidate pattern computation.

The likely net effect is lower memory/array overhead and simpler selection logic. The second pass will compute patterns instead of reading them from memory, so exact gas should be measured after implementation, but the code path becomes simpler and avoids growing an array with one entry per candidate.

## Public API Impact

No public API change is required.

Unchanged:

- `guess(game_id, word_id)`
- `start_practice()`
- `start_game(token_id)`
- `get_game`
- `get_guess`
- `get_chunk`
- `get_dictionary`
- `active_game_id`
- Client-side VRF preamble salt: `poseidon(game_id, guesses_used, word_id)`
- `Guess.candidates_remaining`
- `Game.guesses_used`
- Score semantics

The frontend should not need calldata or model decoder changes.

## Recommended Implementation Plan

1. Update `contracts/src/systems/actions.cairo`.
2. Replace the current `pattern_seen` / `pattern_stream` / `kth_set_bit_u256` selection block with candidate-weighted selection.
3. Keep the existing candidate chunk snapshot.
4. Count `total_candidates` from the chunk snapshots.
5. Use existing VRF/pseudo-random `mix`.
6. Compute `selected_ordinal = mix % total_candidates`.
7. Walk the candidate bitmap to find the selected candidate id.
8. Load the selected candidate word from `WordPack`.
9. Compute `chosen_pattern`.
10. Re-walk candidates, compute each candidate pattern, and keep matches.
11. Preserve the existing guess log and win/loss logic.

Optional helper extraction:

- Add a helper to count live candidates across chunk snapshots.
- Add a helper to load candidate word letters with the same pack-cache pattern used today.
- Add a helper to find the `n`th live candidate in chunk snapshots.

## Test Plan

Run existing tests:

```bash
scarb test
```

Current result before changes:

- `16` tests passed.
- Existing tests are helper-level only.

Add tests where practical:

- Candidate ordinal selection across chunk boundaries.
- Candidate count from multiple chunks.
- Weighted chosen pattern equals `compute_pattern(guess, sampled_candidate)`.
- Narrowing keeps exactly candidates with the chosen pattern.
- Regression for `compute_pattern` remains unchanged.

Add or keep an off-chain analysis script for distribution sanity:

- Confirm current uniform-over-patterns gives `trace` about `15.43` expected first-turn survivors.
- Confirm weighted selection gives `trace` about `74.02` expected first-turn survivors.
- Confirm weighted selection sharply lowers the chance of first-turn `<=5` candidates.

## Conclusion

The current bucket rule is the main difficulty issue. It gives tiny feedback buckets too much probability, which lets strong players collapse the candidate set unusually fast.

Weighted bucket selection is the best default change:

- It is harder.
- It is still random and fair.
- It does not require a public API or frontend salt change.
- It likely simplifies the hot path by removing the per-candidate pattern stream.

Largest-bucket selection would be even harder, but it would make the game explicitly adversarial and less random-feeling. Weighted random is the better first adjustment.
