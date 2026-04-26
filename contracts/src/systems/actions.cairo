// Actions contract — the lazy stochastic Wordle engine.
//
// Three entrypoints:
//   - start_game: mints a fresh game with full candidate bitmap.
//   - guess: walks the candidate bitmap once to record every non-empty
//     pattern bucket (in `pattern_seen: u256`) and each candidate's pattern
//     (packed in a u256 stream), picks a uniform-random non-empty bucket,
//     then re-walks to narrow the surviving set. Win when popcount == 1
//     and matches guess.
//   - surrender: voluntary forfeit; reveals one surviving candidate.

#[starknet::interface]
pub trait IActions<T> {
    // Caller picks the game_id (random felt) so the client knows it
    // without parsing transaction return values. Reverts on collision.
    fn start_game(ref self: T, game_id: felt252);
    fn guess(ref self: T, game_id: felt252, word_id: u16);
    fn surrender(ref self: T, game_id: felt252);
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
}

#[dojo::contract]
pub mod actions {
    use core::num::traits::Bounded;
    use core::poseidon::poseidon_hash_span;
    use dojo::world::WorldStorage;
    use starknet::{get_block_timestamp, get_caller_address};
    use zordle::constants::{CHUNK_BITS, MAX_GUESSES, NUM_CHUNKS};
    use zordle::helpers::bitmap::{
        Bitmap, append_pattern_to_stream, kth_set_bit_u256, read_pattern_from_stream,
    };
    use zordle::helpers::power::TwoPower;
    use zordle::helpers::wordle::compute_pattern;
    use zordle::models::candidate::CandidateChunkTrait;
    use zordle::models::dictionary::DictionaryAssert;
    use zordle::models::game::{GameAssert, GameTrait};
    use zordle::models::index::Guess;
    use zordle::store::StoreTrait;

    pub mod Errors {
        pub const ALREADY_STARTED: felt252 = 'Game: already started';
        pub const WORD_OUT_OF_RANGE: felt252 = 'Guess: word_id out of range';
        pub const NO_GUESSES_LEFT: felt252 = 'Guess: no guesses left';
        pub const NO_CANDIDATES: felt252 = 'Guess: no candidates';
    }

    #[abi(embed_v0)]
    impl ActionsImpl of super::IActions<ContractState> {
        fn start_game(ref self: ContractState, game_id: felt252) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);

            let dict = store.dictionary();
            dict.assert_loaded();

            let existing = store.game(game_id);
            assert(existing.started_at == 0, Errors::ALREADY_STARTED);

            let player = get_caller_address();
            let now = get_block_timestamp();
            let seed = poseidon_hash_span(
                [game_id, player.into(), now.into()].span(),
            );

            let game = GameTrait::new(game_id, player, seed);
            store.set_game(@game);

            // Populate NUM_CHUNKS candidate bitmap rows. The candidate set
            // is the answer pool only (word_ids in [0, answer_count)), so
            // mask off everything past answer_count even if the full vocab
            // extends further.
            let max_chunk: u256 = Bounded::<u256>::MAX;
            let mut i: u8 = 0;
            while i < NUM_CHUNKS {
                let first_id: u32 = i.into() * CHUNK_BITS;
                let next_id: u32 = (i.into() + 1) * CHUNK_BITS;
                let bits: u256 = if next_id <= dict.answer_count.into() {
                    max_chunk
                } else if first_id >= dict.answer_count.into() {
                    0
                } else {
                    let live: u32 = dict.answer_count.into() - first_id;
                    TwoPower::pow(live.try_into().unwrap()) - 1
                };
                store.set_candidate(@CandidateChunkTrait::new(game_id, i, bits));
                i += 1;
            }
        }

        fn guess(ref self: ContractState, game_id: felt252, word_id: u16) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);

            let mut game = store.game(game_id);
            game.assert_exists();
            game.assert_not_over();
            game.assert_owner(get_caller_address());
            assert(game.guesses_used < MAX_GUESSES, Errors::NO_GUESSES_LEFT);

            let dict = store.dictionary();
            dict.assert_loaded();
            assert(word_id < dict.word_count, Errors::WORD_OUT_OF_RANGE);

            let guess_letters = store.word_letters(word_id);

            // Snapshot candidate chunks into an in-memory array so we don't
            // re-read storage on the second pass.
            let mut chunks: Array<u256> = array![];
            let mut i: u8 = 0;
            while i < NUM_CHUNKS {
                chunks.append(store.candidate(game_id, i).bits);
                i += 1;
            }

            // ---- Pass 1 ----
            // pattern_seen: bit p == 1 ⇔ at least one surviving candidate
            //   produces pattern p (243 bits used, fits in a u256).
            // pattern_stream: each candidate's pattern packed in iteration
            //   order, 32 patterns per u256 (8 bits each). Pass 2 reads it
            //   back by ordinal, avoiding a re-compute.
            // word_pack cache: candidate_id / 10 → packed u256. Without this
            //   we'd re-read the same pack 10× for 10 consecutive candidates.
            let mut pattern_seen: u256 = 0;
            let mut pattern_stream: Array<u8> = array![];
            let mut ordinal: u32 = 0;
            let mut cached_pack_id: u32 = 0xFFFFFFFF;
            let mut cached_pack: u256 = 0;

            let mut chunk_index: u8 = 0;
            while chunk_index < NUM_CHUNKS {
                let mut bits: u256 = *chunks.at(chunk_index.into());
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
                        let mask = TwoPower::pow(pattern);
                        if (pattern_seen / mask) % 2 == 0 {
                            pattern_seen += mask;
                        }
                        append_pattern_to_stream(ref pattern_stream, pattern);
                        ordinal += 1;
                    }
                    bits = bits / 2;
                    bit_idx += 1;
                }
                chunk_index += 1;
            }

            // ---- Pick a uniform-random non-empty pattern ----
            let bucket_count: u32 = Bitmap::popcount(pattern_seen).into();
            assert(bucket_count > 0, Errors::NO_CANDIDATES);
            let mix = poseidon_hash_span(
                [game.seed, game.guesses_used.into(), word_id.into()].span(),
            );
            let mix_u256: u256 = mix.into();
            let k: u32 = (mix_u256 % bucket_count.into()).try_into().unwrap();
            let chosen_pattern: u8 = kth_set_bit_u256(pattern_seen, k);

            // ---- Pass 2: re-walk in lockstep with pattern_stream, narrow ----
            let mut total_remaining: u32 = 0;
            let mut first_surviving: u32 = Bounded::<u32>::MAX;
            let mut ordinal2: u32 = 0;

            let mut chunk_index: u8 = 0;
            while chunk_index < NUM_CHUNKS {
                let mut bits: u256 = *chunks.at(chunk_index.into());
                let chunk_base: u32 = chunk_index.into() * CHUNK_BITS;
                let mut new_bits: u256 = 0;
                let mut bit_idx: u32 = 0;
                while bits > 0 {
                    if (bits % 2) == 1 {
                        let candidate_id: u32 = chunk_base + bit_idx;
                        let pattern = read_pattern_from_stream(@pattern_stream, ordinal2);
                        if pattern == chosen_pattern {
                            new_bits = new_bits + TwoPower::pow(bit_idx.try_into().unwrap());
                            total_remaining += 1;
                            if candidate_id < first_surviving {
                                first_surviving = candidate_id;
                            }
                        }
                        ordinal2 += 1;
                    }
                    bits = bits / 2;
                    bit_idx += 1;
                }
                store
                    .set_candidate(@CandidateChunkTrait::new(game_id, chunk_index, new_bits));
                chunk_index += 1;
            }
            // Catches drift if Pass 1 / Pass 2 diverge in iteration order.
            assert(ordinal == ordinal2, 'Guess: stream ordinal drift');

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
            if total_remaining == 1 {
                let surviving_word: u16 = first_surviving.try_into().unwrap();
                if surviving_word == word_id {
                    game.won = true;
                    game.ended_at = now;
                    game.final_word_id = surviving_word;
                } else if game.guesses_used >= MAX_GUESSES {
                    // Out of guesses; reveal the surviving word.
                    game.ended_at = now;
                    game.final_word_id = surviving_word;
                }
            } else if game.guesses_used >= MAX_GUESSES {
                // Out of guesses with multiple survivors; reveal any.
                game.ended_at = now;
                game.final_word_id = first_surviving.try_into().unwrap();
            }

            store.set_game(@game);
        }

        fn surrender(ref self: ContractState, game_id: felt252) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);

            let mut game = store.game(game_id);
            game.assert_exists();
            game.assert_not_over();
            game.assert_owner(get_caller_address());

            // Reveal the lowest-index surviving word.
            let mut chunk_index: u8 = 0;
            let mut revealed: u32 = 0;
            let mut found = false;
            while chunk_index < NUM_CHUNKS && !found {
                let chunk_bits = store.candidate(game_id, chunk_index).bits;
                if chunk_bits > 0 {
                    let mut bits = chunk_bits;
                    let mut bit_idx: u32 = 0;
                    while bits > 0 && (bits % 2) == 0 {
                        bits = bits / 2;
                        bit_idx += 1;
                    }
                    revealed = chunk_index.into() * CHUNK_BITS + bit_idx;
                    found = true;
                }
                chunk_index += 1;
            }

            game.ended_at = get_block_timestamp();
            game.final_word_id = revealed.try_into().unwrap();
            store.set_game(@game);
        }
    }

    #[abi(embed_v0)]
    impl ActionsViewImpl of super::IActionsView<ContractState> {
        fn get_game(
            self: @ContractState, game_id: felt252,
        ) -> zordle::models::index::Game {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).game(game_id)
        }

        fn get_chunk(self: @ContractState, game_id: felt252, index: u8) -> u256 {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).candidate(game_id, index).bits
        }

        fn get_guess(
            self: @ContractState, game_id: felt252, index: u8,
        ) -> zordle::models::index::Guess {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).guess(game_id, index)
        }

        fn get_word(self: @ContractState, word_id: u16) -> u32 {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).word_letters(word_id)
        }

        fn get_dictionary(self: @ContractState) -> zordle::models::index::Dictionary {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).dictionary()
        }
    }
}
