// Typed facade over WorldStorage. One method per (model, read|write).

use dojo::model::ModelStorage;
use dojo::world::WorldStorage;
use crate::models::index::{CandidateChunk, Dictionary, Game, Guess, Word};

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

    // -- Word ---------------------------------------------------------------

    fn word(self: @Store, id: u16) -> Word {
        self.world.read_model(id)
    }

    fn set_word(mut self: Store, model: @Word) {
        self.world.write_model(model);
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
