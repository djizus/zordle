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
//      candidate bitmap, pick a uniform-random non-empty pattern bucket,
//      narrow. On terminal state (won, or 6th guess), post_action ends the
//      token's lifecycle so Denshokan/Budokan can settle the score.
//   4. surrender(token_id): same flow, just reveals one surviving word and
//      ends the game with `won=false`.
//
// Randomness comes from Cartridge VRF on Sepolia/Mainnet (consume_random
// with a deterministic salt that the client also encoded into a multicall
// `request_random` preamble). On local katana the contract is initialised
// with vrf_address=0 and falls back to a tx-info-derived pseudo-random.

#[starknet::interface]
pub trait IActions<T> {
    fn start_game(ref self: T, token_id: felt252);
    fn guess(ref self: T, token_id: felt252, word_id: u16);
    fn surrender(ref self: T, token_id: felt252);
}

// Read-only views the web client uses to render UI. Going through the
// contract avoids direct Dojo-storage RPC reads and Torii.
#[starknet::interface]
pub trait IActionsView<T> {
    fn get_game(self: @T, token_id: felt252) -> zordle::models::index::Game;
    fn get_chunk(self: @T, token_id: felt252, index: u8) -> u256;
    fn get_guess(self: @T, token_id: felt252, index: u8) -> zordle::models::index::Guess;
    fn get_word(self: @T, word_id: u16) -> u32;
    fn get_dictionary(self: @T) -> zordle::models::index::Dictionary;
}

#[dojo::contract]
pub mod actions {
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
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use zordle::constants::{CHUNK_BITS, MAX_GUESSES, NUM_CHUNKS};
    use zordle::helpers::bitmap::{
        Bitmap, append_pattern_to_stream, kth_set_bit_u256, read_pattern_from_stream,
    };
    use zordle::helpers::power::TwoPower;
    use zordle::helpers::random::random_from;
    use zordle::helpers::wordle::compute_pattern;
    use zordle::models::candidate::CandidateChunkTrait;
    use zordle::models::dictionary::DictionaryAssert;
    use zordle::models::game::{GameAssert, GameTrait};
    use zordle::models::index::{Game, Guess};
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
                    "Lazy adversarial Wordle on Dojo. Six guesses, on-chain.",
                    "zKorp",
                    "zKorp",
                    "Word Puzzle",
                    "https://zordle.zkorp.xyz/zkorp-cube.png",
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
    #[abi(embed_v0)]
    impl GameTokenDataImpl of IMinigameTokenData<ContractState> {
        fn score(self: @ContractState, token_id: felt252) -> u64 {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let game: Game = StoreTrait::new(world).game(token_id);
            if game.won && game.guesses_used <= MAX_GUESSES {
                let score: u8 = (MAX_GUESSES + 1) - game.guesses_used;
                score.into()
            } else {
                0
            }
        }

        fn game_over(self: @ContractState, token_id: felt252) -> bool {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let game: Game = StoreTrait::new(world).game(token_id);
            game.ended_at != 0
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

    #[abi(embed_v0)]
    impl ActionsImpl of super::IActions<ContractState> {
        fn start_game(ref self: ContractState, token_id: felt252) {
            let world: WorldStorage = self.world(@"zordle_0_1");
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
            let game = GameTrait::new(token_id, player);
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
                store.set_candidate(@CandidateChunkTrait::new(token_id, i, bits));
                i += 1;
            }
        }

        fn guess(ref self: ContractState, token_id: felt252, word_id: u16) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);

            let mut game = store.game(token_id);
            game.assert_exists();
            game.assert_not_over();
            game.assert_owner(get_caller_address());
            assert(game.guesses_used < MAX_GUESSES, Errors::NO_GUESSES_LEFT);

            let token_address = self.token_address();
            if !token_address.is_zero() {
                pre_action(token_address, token_id);
                assert_token_ownership(token_address, token_id);
            }

            let dict = store.dictionary();
            dict.assert_loaded();
            assert(word_id < dict.word_count, Errors::WORD_OUT_OF_RANGE);

            let guess_letters = store.word_letters(word_id);

            // Snapshot candidate chunks into an in-memory array so we don't
            // re-read storage on the second pass.
            let mut chunks: Array<u256> = array![];
            let mut i: u8 = 0;
            while i < NUM_CHUNKS {
                chunks.append(store.candidate(token_id, i).bits);
                i += 1;
            }

            // ---- Pass 1 ----
            // pattern_seen: bit p == 1 ⇔ at least one surviving candidate
            //   produces pattern p (243 bits used, fits in a u256).
            // pattern_stream: each candidate's pattern packed in iteration
            //   order, 1 byte per candidate. Pass 2 reads it back by ordinal,
            //   avoiding a re-compute.
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

            // ---- Pick a uniform-random non-empty pattern via VRF ----
            let bucket_count: u32 = Bitmap::popcount(pattern_seen).into();
            assert(bucket_count > 0, Errors::NO_CANDIDATES);
            // Salt encodes the (token_id, turn_number, guess word_id) so the
            // pick is unique per guess. The client must also call
            // request_random with this exact salt before our action in the
            // multicall (otherwise consume_random reverts).
            let salt = poseidon_hash_span(
                [token_id, game.guesses_used.into(), word_id.into()].span(),
            );
            let vrf_addr = self.vrf_address.read();
            let mix = random_from(vrf_addr, salt);
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
                    .set_candidate(@CandidateChunkTrait::new(token_id, chunk_index, new_bits));
                chunk_index += 1;
            }
            // Catches drift if Pass 1 / Pass 2 diverge in iteration order.
            assert(ordinal == ordinal2, 'Guess: stream ordinal drift');

            // ---- Log the guess ----
            store
                .set_guess(
                    @Guess {
                        game_id: token_id,
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

            if game_ended && !token_address.is_zero() {
                post_action(token_address, token_id);
            }
        }

        fn surrender(ref self: ContractState, token_id: felt252) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);

            let mut game = store.game(token_id);
            game.assert_exists();
            game.assert_not_over();
            game.assert_owner(get_caller_address());

            let token_address = self.token_address();
            if !token_address.is_zero() {
                pre_action(token_address, token_id);
                assert_token_ownership(token_address, token_id);
            }

            // Reveal the lowest-index surviving word.
            let mut chunk_index: u8 = 0;
            let mut revealed: u32 = 0;
            let mut found = false;
            while chunk_index < NUM_CHUNKS && !found {
                let chunk_bits = store.candidate(token_id, chunk_index).bits;
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

            if !token_address.is_zero() {
                post_action(token_address, token_id);
            }
        }
    }

    #[abi(embed_v0)]
    impl ActionsViewImpl of super::IActionsView<ContractState> {
        fn get_game(self: @ContractState, token_id: felt252) -> Game {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).game(token_id)
        }

        fn get_chunk(self: @ContractState, token_id: felt252, index: u8) -> u256 {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).candidate(token_id, index).bits
        }

        fn get_guess(self: @ContractState, token_id: felt252, index: u8) -> Guess {
            let world: WorldStorage = self.world(@"zordle_0_1");
            StoreTrait::new(world).guess(token_id, index)
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
