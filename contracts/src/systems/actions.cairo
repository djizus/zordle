// Actions contract — the lazy stochastic Wordle engine.
//
// One game == one Denshokan MinigameToken. The token's id doubles as the
// game key. Per-game flow:
//
//   1. (off-chain) Client mints a token via Denshokan, gets `token_id`.
//   2. start_game(token_id): pre_action → assert_ownership → init candidate
//      bitmap. The contract refuses if token_id has already been started or
//      the caller doesn't own it.
//   3. guess(token_id, word_id): pre_action → assert_ownership → walk the
//      candidate bitmap, pick a ~size^0.8-weighted non-empty pattern bucket,
//      narrow. On terminal state (won, or 6th guess), post_action ends the
//      token's lifecycle so Denshokan/Budokan can settle the score.
// NFT randomness comes from Cartridge VRF on Sepolia/Mainnet (consume_random
// with a deterministic salt that the client also encoded into a multicall
// `request_random` preamble). Practice mode runs without VRF and uses the
// same deterministic salt directly.

#[starknet::interface]
pub trait IActions<T> {
    /// Mode 0 — free practice. No EGC token, no mint cost. If the caller
    /// already has an unfinished practice game, returns it; otherwise creates
    /// a fresh run.
    fn start_practice(ref self: T) -> felt252;

    /// Mode 1 — NFT. Caller must already own the Denshokan token at
    /// `token_id` (mint via the embedded mint_game entrypoint). Each NFT
    /// is a fresh, replayable game.
    fn start_game(ref self: T, token_id: felt252);

    /// Submit a guess. game_id is whatever was returned by start_practice()
    /// or the token_id passed to start_game(). Salt for VRF consume_random
    /// is derived from the game's mode (read from storage).
    fn guess(ref self: T, game_id: felt252, word_id: u16);
}

// Read-only views the web client uses to render UI. Going through the
// contract avoids direct Dojo-storage RPC reads and Torii.
#[starknet::interface]
pub trait IActionsView<T> {
    fn get_game(self: @T, game_id: felt252) -> zordle::models::index::Game;
    fn get_chunk(self: @T, game_id: felt252, index: u8) -> u256;
    fn get_guess(self: @T, game_id: felt252, index: u8) -> zordle::models::index::Guess;
    fn get_word(self: @T, word_id: u16) -> u32;
    fn get_dictionary(self: @T) -> zordle::models::index::Dictionary;
    /// Return the player's unfinished practice game id, or 0 if none exists.
    fn active_game_id(self: @T, player: starknet::ContractAddress) -> felt252;
}

#[dojo::contract]
pub mod actions {
    use core::dict::Felt252Dict;
    use core::num::traits::{Bounded, Zero};
    use core::poseidon::poseidon_hash_span;
    use dojo::world::WorldStorage;
    use game_components_embeddable_game_standard::minigame::interface::IMinigameTokenData;
    use game_components_embeddable_game_standard::minigame::minigame::{
        assert_token_ownership, post_action, pre_action,
    };
    use game_components_embeddable_game_standard::minigame::minigame_component::MinigameComponent;
    use openzeppelin_introspection::src5::SRC5Component;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_tx_info};
    use zordle::constants::{CHUNK_BITS, DEFAULT_NS, MAX_GUESSES, NUM_CHUNKS};
    use zordle::helpers::bitmap::{append_pattern_to_stream, read_pattern_from_stream, Bitmap};
    use zordle::helpers::power::TwoPower;
    use zordle::helpers::random::random_from;
    use zordle::helpers::wordle::compute_pattern;
    use zordle::models::candidate::CandidateChunkTrait;
    use zordle::models::dictionary::DictionaryAssert;
    use zordle::models::game::{GameAssert, GameTrait, MODE_NFT, MODE_PRACTICE};
    use zordle::models::index::{ActiveGame, Game, Guess};
    use zordle::store::StoreTrait;

    component!(path: MinigameComponent, storage: minigame, event: MinigameEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[abi(embed_v0)]
    impl MinigameImpl = MinigameComponent::MinigameImpl<ContractState>;
    impl MinigameInternalImpl = MinigameComponent::InternalImpl<ContractState>;

    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        minigame: MinigameComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        // Cartridge VRF provider address. Zero on local katana → use
        // pseudo-random fallback. Set on Sepolia/Mainnet via dojo_init.
        vrf_address: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        MinigameEvent: MinigameComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
    }

    pub mod Errors {
        pub const ALREADY_STARTED: felt252 = 'Game: already started';
        pub const WORD_OUT_OF_RANGE: felt252 = 'Guess: word_id out of range';
        pub const NO_GUESSES_LEFT: felt252 = 'Guess: no guesses left';
        pub const NO_CANDIDATES: felt252 = 'Guess: no candidates';
    }

    fn dojo_init(
        ref self: ContractState,
        creator_address: ContractAddress,
        denshokan_address: ContractAddress,
        renderer_address: Option<ContractAddress>,
        vrf_address: ContractAddress,
    ) {
        // Wire MinigameComponent so this contract advertises itself to
        // Denshokan/Budokan as the game contract for the minted token.
        // renderer_address: Option::None falls back to Denshokan's default
        // SVG renderer — we don't ship a custom one for v1.
        if !denshokan_address.is_zero() {
            self
                .minigame
                .initializer(
                    creator_address,
                    "zordle",
                    "A 5-letter word puzzle. Six guesses to crack it. Play free practice runs or compete with NFT-bound games.",
                    "zKorp",
                    "zKorp",
                    "Word Puzzle",
                    "https://raw.githubusercontent.com/z-korp/zordle/refs/heads/main/client/public/zordle_logo.png",
                    Option::Some("#A9D8FF"),
                    Option::None,
                    renderer_address,
                    Option::None,
                    Option::None,
                    denshokan_address,
                    Option::None,
                    Option::None,
                    1,
                    Option::None,
                    Option::None,
                );
        }

        self.vrf_address.write(vrf_address);
    }

    // Score view consumed by Denshokan / Budokan leaderboard. Higher = better.
    //   1/6 win → 6, 2/6 → 5, ..., 6/6 → 1, loss → 0.
    // Only mode 1 (NFT) games expose a score — practice-mode games (mode 0)
    // aren't tied to a token, so any token_id query returns 0 by default
    // (Dojo zero-init).
    #[abi(embed_v0)]
    impl GameTokenDataImpl of IMinigameTokenData<ContractState> {
        fn score(self: @ContractState, token_id: felt252) -> u64 {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let game: Game = StoreTrait::new(world).game(token_id);
            if game.mode == MODE_NFT && game.won && game.guesses_used <= MAX_GUESSES {
                let score: u8 = (MAX_GUESSES + 1) - game.guesses_used;
                score.into()
            } else {
                0
            }
        }

        fn game_over(self: @ContractState, token_id: felt252) -> bool {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let game: Game = StoreTrait::new(world).game(token_id);
            game.mode == MODE_NFT && game.ended_at != 0
        }

        fn score_batch(self: @ContractState, token_ids: Span<felt252>) -> Array<u64> {
            let mut out: Array<u64> = array![];
            let mut i: u32 = 0;
            while i < token_ids.len() {
                out.append(self.score(*token_ids.at(i)));
                i += 1;
            }
            out
        }

        fn game_over_batch(self: @ContractState, token_ids: Span<felt252>) -> Array<bool> {
            let mut out: Array<bool> = array![];
            let mut i: u32 = 0;
            while i < token_ids.len() {
                out.append(self.game_over(*token_ids.at(i)));
                i += 1;
            }
            out
        }
    }

    fn initial_candidate_bits(index: u8, answer_count: u16) -> u256 {
        let max_chunk: u256 = Bounded::<u256>::MAX;
        let first_id: u32 = index.into() * CHUNK_BITS;
        let next_id: u32 = (index.into() + 1) * CHUNK_BITS;
        if next_id <= answer_count.into() {
            max_chunk
        } else if first_id >= answer_count.into() {
            0
        } else {
            let live: u32 = answer_count.into() - first_id;
            TwoPower::pow(live.try_into().unwrap()) - 1
        }
    }

    // Shared helper: compute the initial active chunk mask for the answer
    // pool. Candidate chunks are materialized lazily after the first guess.
    fn initial_active_chunks(answer_count: u16) -> u256 {
        let mut active_chunks: u256 = 0;
        let mut i: u8 = 0;
        while i < NUM_CHUNKS {
            if initial_candidate_bits(i, answer_count) != 0 {
                active_chunks += TwoPower::pow(i);
            }
            i += 1;
        }
        active_chunks
    }

    fn compute_practice_game_id(player: ContractAddress) -> felt252 {
        let tx_info = get_tx_info().unbox();
        poseidon_hash_span(
            [player.into(), get_block_timestamp().into(), tx_info.transaction_hash].span(),
        )
    }

    // Largest u128 r such that r^5 <= target. Doubling search to bracket the
    // root in O(log target), then binary search inside the bracket. Replaces
    // an earlier linear scan whose worst case (root = 491 for a full 2315
    // pool) dominated selection cost.
    fn fifth_root(target: u128) -> u128 {
        if target == 0 {
            return 0;
        }
        let mut hi: u128 = 1;
        while hi * hi * hi * hi * hi <= target {
            hi = hi * 2;
        }
        let mut lo: u128 = hi / 2;
        while lo + 1 < hi {
            let mid: u128 = (lo + hi) / 2;
            let mid5: u128 = mid * mid * mid * mid * mid;
            if mid5 <= target {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
    }

    fn bucket_weight(count: u32) -> u32 {
        // Integer approximation of count^0.8 = fifth_root(count^4).
        let count_u128: u128 = count.into();
        let target: u128 = count_u128 * count_u128 * count_u128 * count_u128;
        fifth_root(target).try_into().unwrap()
    }

    #[abi(embed_v0)]
    impl ActionsImpl of super::IActions<ContractState> {
        fn start_practice(ref self: ContractState) -> felt252 {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let mut store = StoreTrait::new(world);

            let dict = store.dictionary();
            dict.assert_loaded();

            let player = get_caller_address();
            let active = store.active_game(player);
            if active.game_id != 0 {
                let active_game = store.game(active.game_id);
                if active_game.started_at != 0
                    && active_game.ended_at == 0
                    && active_game.answer_count == dict.answer_count
                    && active_game.active_chunks != 0 {
                    return active.game_id;
                }
            }

            let game_id = compute_practice_game_id(player);
            let existing = store.game(game_id);
            assert(existing.started_at == 0, Errors::ALREADY_STARTED);

            let mut game = GameTrait::new(game_id, player, MODE_PRACTICE);
            game.answer_count = dict.answer_count;
            game.active_chunks = initial_active_chunks(dict.answer_count);
            store.set_game(@game);
            store.set_active_game(@ActiveGame { player, game_id });

            game_id
        }

        fn start_game(ref self: ContractState, token_id: felt252) {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let mut store = StoreTrait::new(world);

            let dict = store.dictionary();
            dict.assert_loaded();

            let token_address = self.token_address();
            if !token_address.is_zero() {
                pre_action(token_address, token_id);
                assert_token_ownership(token_address, token_id);
            }

            let existing = store.game(token_id);
            assert(existing.started_at == 0, Errors::ALREADY_STARTED);

            let player = get_caller_address();
            let mut game = GameTrait::new(token_id, player, MODE_NFT);
            game.answer_count = dict.answer_count;
            game.active_chunks = initial_active_chunks(dict.answer_count);
            store.set_game(@game);
        }

        fn guess(ref self: ContractState, game_id: felt252, word_id: u16) {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let mut store = StoreTrait::new(world);

            let mut game = store.game(game_id);
            game.assert_exists();
            game.assert_not_over();
            game.assert_owner(get_caller_address());
            assert(game.guesses_used < MAX_GUESSES, Errors::NO_GUESSES_LEFT);

            // Only NFT mode hits the EGC ownership gate; practice mode is
            // standalone and loginless on the slot.
            let token_address = self.token_address();
            let is_nft = game.mode == MODE_NFT;
            if is_nft && !token_address.is_zero() {
                pre_action(token_address, game_id);
                assert_token_ownership(token_address, game_id);
            }

            let dict = store.dictionary();
            dict.assert_loaded();
            assert(word_id < dict.word_count, Errors::WORD_OUT_OF_RANGE);

            let guess_letters = store.word_letters(word_id);

            // Snapshot active candidate chunks into memory so we don't
            // re-read storage on the second pass. Empty chunks are skipped
            // using the per-game active chunk mask.
            let active_chunks = game.active_chunks;
            assert(active_chunks != 0, Errors::NO_CANDIDATES);

            // Consume VRF as soon as the guess has passed cheap validity
            // checks. If later bucket work fails, the provider has still
            // been consumed and the surfaced revert points at the guess.
            let salt: felt252 = poseidon_hash_span(
                [game_id, game.guesses_used.into(), word_id.into()].span(),
            );
            let vrf_addr = self.vrf_address.read();
            let mix = if vrf_addr.is_zero() {
                salt
            } else {
                random_from(vrf_addr, salt)
            };
            let mix_u256: u256 = mix.into();

            let mut chunk_indices: Array<u8> = array![];
            let mut chunks: Array<u256> = array![];
            let mut i: u8 = 0;
            while i < NUM_CHUNKS {
                if Bitmap::get(active_chunks, i) == 1 {
                    chunk_indices.append(i);
                    let bits = if game.guesses_used == 0 {
                        initial_candidate_bits(i, game.answer_count)
                    } else {
                        store.candidate(game_id, i).bits
                    };
                    chunks.append(bits);
                }
                i += 1;
            }

            // ---- Pass 1 ----
            // pattern_seen: bit p == 1 ⇔ at least one surviving candidate
            //   produces pattern p (243 bits used, fits in a u256).
            // pattern_counts stores the bucket size for p, used to select a
            // ~size^0.8-weighted non-empty bucket. This keeps the game's
            // swingy bucket lottery while reducing tiny-bucket frequency.
            // word_pack cache: candidate_id / 10 → packed u256. Without this
            //   we'd re-read the same pack 10× for 10 consecutive candidates.
            let mut pattern_seen: u256 = 0;
            let mut pattern_counts: Felt252Dict<u32> = Default::default();
            let mut pattern_stream: Array<u8> = array![];
            let mut ordinal: u32 = 0;
            let mut cached_pack_id: u32 = 0xFFFFFFFF;
            let mut cached_pack: u256 = 0;

            let mut active_index: u32 = 0;
            while active_index < chunks.len() {
                let chunk_index: u8 = *chunk_indices.at(active_index);
                let mut bits: u256 = *chunks.at(active_index);
                let chunk_base: u32 = chunk_index.into() * CHUNK_BITS;
                let mut bit_idx: u32 = 0;
                while bits > 0 {
                    if (bits % 2) == 1 {
                        let candidate_id: u32 = chunk_base + bit_idx;
                        let pack_id: u32 = candidate_id / 10;
                        if pack_id != cached_pack_id {
                            cached_pack = store
                                .word_pack(pack_id.try_into().unwrap())
                                .packed;
                            cached_pack_id = pack_id;
                        }
                        let pack_slot: u8 = (candidate_id % 10).try_into().unwrap();
                        let shifted: u256 = cached_pack / TwoPower::pow(pack_slot * 25);
                        let target: u32 = (shifted % 0x2000000_u256).try_into().unwrap();
                        let pattern = compute_pattern(guess_letters, target);
                        append_pattern_to_stream(ref pattern_stream, pattern);
                        let mask = TwoPower::pow(pattern);
                        if (pattern_seen / mask) % 2 == 0 {
                            pattern_seen += mask;
                        }
                        let pattern_key: felt252 = pattern.into();
                        let count = pattern_counts.get(pattern_key);
                        pattern_counts.insert(pattern_key, count + 1);
                        ordinal += 1;
                    }
                    bits = bits / 2;
                    bit_idx += 1;
                }
                active_index += 1;
            }

            // ---- Pick a ~size^0.8-weighted non-empty pattern via VRF ----
            let bucket_count: u32 = Bitmap::popcount(pattern_seen).into();
            assert(bucket_count > 0, Errors::NO_CANDIDATES);
            // `mix_u256` was consumed before the expensive bucket scan using
            // salt = poseidon(game_id, turn, word_id). The client must encode
            // the same salt into its request_random preamble.

            let mut total_weight: u32 = 0;
            let mut pattern_code: u8 = 0;
            while pattern_code < 243 {
                if Bitmap::get(pattern_seen, pattern_code) == 1 {
                    let count = pattern_counts.get(pattern_code.into());
                    total_weight += bucket_weight(count);
                }
                pattern_code += 1;
            }
            assert(total_weight > 0, Errors::NO_CANDIDATES);

            let selected_weight: u32 = (mix_u256 % total_weight.into()).try_into().unwrap();
            let mut cumulative_weight: u32 = 0;
            let mut chosen_pattern: u8 = 0;
            let mut found_pattern: bool = false;
            let mut pattern_code: u8 = 0;
            while pattern_code < 243 && !found_pattern {
                if Bitmap::get(pattern_seen, pattern_code) == 1 {
                    let count = pattern_counts.get(pattern_code.into());
                    cumulative_weight += bucket_weight(count);
                    if selected_weight < cumulative_weight {
                        chosen_pattern = pattern_code;
                        found_pattern = true;
                    }
                }
                pattern_code += 1;
            }
            assert(found_pattern, Errors::NO_CANDIDATES);

            // ---- Pass 2: re-walk active chunks and narrow ----
            let mut total_remaining: u32 = 0;
            let mut first_surviving: u32 = Bounded::<u32>::MAX;
            let mut new_active_chunks: u256 = 0;
            ordinal = 0;

            let mut active_index: u32 = 0;
            while active_index < chunks.len() {
                let chunk_index: u8 = *chunk_indices.at(active_index);
                let mut bits: u256 = *chunks.at(active_index);
                let chunk_base: u32 = chunk_index.into() * CHUNK_BITS;
                let mut new_bits: u256 = 0;
                let mut bit_idx: u32 = 0;
                while bits > 0 {
                    if (bits % 2) == 1 {
                        let candidate_id: u32 = chunk_base + bit_idx;
                        let pattern = read_pattern_from_stream(@pattern_stream, ordinal);
                        if pattern == chosen_pattern {
                            new_bits = new_bits + TwoPower::pow(bit_idx.try_into().unwrap());
                            total_remaining += 1;
                            if candidate_id < first_surviving {
                                first_surviving = candidate_id;
                            }
                        }
                        ordinal += 1;
                    }
                    bits = bits / 2;
                    bit_idx += 1;
                }
                if new_bits != 0 {
                    new_active_chunks += TwoPower::pow(chunk_index);
                }
                let old_bits = *chunks.at(active_index);
                if new_bits != 0 && (game.guesses_used == 0 || new_bits != old_bits) {
                    store
                        .set_candidate(@CandidateChunkTrait::new(game_id, chunk_index, new_bits));
                }
                active_index += 1;
            }
            game.active_chunks = new_active_chunks;

            // ---- Log the guess ----
            store
                .set_guess(
                    @Guess {
                        game_id,
                        index: game.guesses_used,
                        word_id,
                        pattern: chosen_pattern,
                        candidates_remaining: total_remaining.try_into().unwrap(),
                    },
                );

            game.guesses_used += 1;

            // ---- Win / lose ----
            let now = get_block_timestamp();
            let mut game_ended = false;
            if total_remaining == 1 {
                let surviving_word: u16 = first_surviving.try_into().unwrap();
                if surviving_word == word_id {
                    game.won = true;
                    game.ended_at = now;
                    game.final_word_id = surviving_word;
                    game_ended = true;
                } else if game.guesses_used >= MAX_GUESSES {
                    // Out of guesses; reveal the surviving word.
                    game.ended_at = now;
                    game.final_word_id = surviving_word;
                    game_ended = true;
                }
            } else if game.guesses_used >= MAX_GUESSES {
                // Out of guesses with multiple survivors; reveal any.
                game.ended_at = now;
                game.final_word_id = first_surviving.try_into().unwrap();
                game_ended = true;
            }

            store.set_game(@game);

            if game_ended && is_nft && !token_address.is_zero() {
                post_action(token_address, game_id);
            }
        }
    }

    #[abi(embed_v0)]
    impl ActionsViewImpl of super::IActionsView<ContractState> {
        fn get_game(self: @ContractState, game_id: felt252) -> Game {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            StoreTrait::new(world).game(game_id)
        }

        fn get_chunk(self: @ContractState, game_id: felt252, index: u8) -> u256 {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let store = StoreTrait::new(world);
            let game = store.game(game_id);
            if game.started_at == 0 || Bitmap::get(game.active_chunks, index) == 0 {
                return 0;
            }
            if game.guesses_used == 0 {
                initial_candidate_bits(index, game.answer_count)
            } else {
                store.candidate(game_id, index).bits
            }
        }

        fn get_guess(self: @ContractState, game_id: felt252, index: u8) -> Guess {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            StoreTrait::new(world).guess(game_id, index)
        }

        fn get_word(self: @ContractState, word_id: u16) -> u32 {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            StoreTrait::new(world).word_letters(word_id)
        }

        fn get_dictionary(self: @ContractState) -> zordle::models::index::Dictionary {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            StoreTrait::new(world).dictionary()
        }

        fn active_game_id(
            self: @ContractState, player: ContractAddress,
        ) -> felt252 {
            let world: WorldStorage = self.world(@DEFAULT_NS());
            let store = StoreTrait::new(world);
            let active = store.active_game(player);
            if active.game_id == 0 {
                return 0;
            }

            let game = store.game(active.game_id);
            if game.started_at != 0 && game.ended_at == 0 {
                active.game_id
            } else {
                0
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{bucket_weight, fifth_root};

        // bucket_weight(count) = floor(count^0.8) = floor(fifth_root(count^4)).
        // Hand-computed expected values cover edge cases, monotonicity
        // boundaries, and the realistic full-pool maximum.
        #[test]
        fn test_bucket_weight_known_values() {
            assert_eq!(bucket_weight(0), 0);
            assert_eq!(bucket_weight(1), 1);
            assert_eq!(bucket_weight(2), 1); // 2^4 = 16, 1^5=1 <= 16 < 32 = 2^5
            assert_eq!(bucket_weight(3), 2); // 3^4 = 81, 2^5=32 <= 81 < 243
            assert_eq!(bucket_weight(10), 6); // 10^4=10000, 6^5=7776 <= 10000 < 16807
            assert_eq!(bucket_weight(100), 39); // 100^4=1e8, 39^5≈9.0e7, 40^5≈1.02e8
            assert_eq!(bucket_weight(246), 81); // largest single bucket on a 2315 pool
            assert_eq!(bucket_weight(2315), 491); // full-pool extreme: 491^5 < 2315^4 < 492^5
        }

        // bucket_weight is non-decreasing: larger buckets are never weighted
        // less than smaller ones. Anything else would invert the difficulty
        // curve.
        #[test]
        fn test_bucket_weight_monotonic_small_range() {
            let mut prev: u32 = 0;
            let mut count: u32 = 0;
            while count <= 64 {
                let w = bucket_weight(count);
                assert!(w >= prev, "bucket_weight non-monotonic");
                prev = w;
                count += 1;
            }
        }

        // fifth_root invariant: r^5 <= target < (r+1)^5 for every r returned.
        #[test]
        fn test_fifth_root_invariant() {
            let mut count: u128 = 0;
            while count <= 64 {
                let target = count * count * count * count;
                let r = fifth_root(target);
                let r5 = r * r * r * r * r;
                assert!(r5 <= target, "fifth_root: r^5 > target");
                if target > 0 {
                    let rp1 = r + 1;
                    let rp1_5 = rp1 * rp1 * rp1 * rp1 * rp1;
                    assert!(target < rp1_5, "fifth_root: (r+1)^5 <= target");
                }
                count += 1;
            }
        }
    }
}
