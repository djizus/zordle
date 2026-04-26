// Typed facade over WorldStorage. One method per (model, read|write).

use dojo::model::ModelStorage;
use dojo::world::WorldStorage;
use crate::helpers::power::TwoPower;
use crate::models::index::{CandidateChunk, Dictionary, Game, Guess, WordPack};

#[derive(Copy, Drop)]
pub struct Store {
    pub world: WorldStorage,
}

#[generate_trait]
pub impl StoreImpl of StoreTrait {
    #[inline]
    fn new(world: WorldStorage) -> Store {
        Store { world }
    }

    // -- Dictionary ---------------------------------------------------------

    fn dictionary(self: @Store) -> Dictionary {
        self.world.read_model(crate::constants::DICTIONARY_ID)
    }

    fn set_dictionary(mut self: Store, model: @Dictionary) {
        self.world.write_model(model);
    }

    // -- WordPack -----------------------------------------------------------

    fn word_pack(self: @Store, pack_id: u16) -> WordPack {
        self.world.read_model(pack_id)
    }

    fn set_word_pack(mut self: Store, model: @WordPack) {
        self.world.write_model(model);
    }

    // Read the 5-letter packed word at `word_id` from its pack slot. Returns
    // a u32 with 5 × 5-bit letter codes (compatible with helpers/wordle.cairo).
    fn word_letters(self: @Store, word_id: u16) -> u32 {
        let pack_id: u16 = word_id / 10;
        let slot: u8 = (word_id % 10).try_into().unwrap();
        let pack: u256 = self.word_pack(pack_id).packed;
        let shifted: u256 = pack / TwoPower::pow(slot * 25);
        // Mask 25 bits = 2^25 = 0x2000000.
        (shifted % 0x2000000_u256).try_into().unwrap()
    }

    // -- Game ---------------------------------------------------------------

    fn game(self: @Store, id: felt252) -> Game {
        self.world.read_model(id)
    }

    fn set_game(mut self: Store, model: @Game) {
        self.world.write_model(model);
    }

    // -- CandidateChunk -----------------------------------------------------

    fn candidate(self: @Store, game_id: felt252, index: u8) -> CandidateChunk {
        self.world.read_model((game_id, index))
    }

    fn set_candidate(mut self: Store, model: @CandidateChunk) {
        self.world.write_model(model);
    }

    // -- Guess --------------------------------------------------------------

    fn guess(self: @Store, game_id: felt252, index: u8) -> Guess {
        self.world.read_model((game_id, index))
    }

    fn set_guess(mut self: Store, model: @Guess) {
        self.world.write_model(model);
    }
}
