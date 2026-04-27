use starknet::ContractAddress;
pub use crate::models::index::Game;

pub mod Errors {
    pub const NOT_FOUND: felt252 = 'Game: not found';
    pub const OVER: felt252 = 'Game: over';
    pub const NOT_OWNER: felt252 = 'Game: not owner';
}

pub const MODE_PRACTICE: u8 = 0;
pub const MODE_NFT: u8 = 1;

#[generate_trait]
pub impl GameImpl of GameTrait {
    fn new(id: felt252, player: ContractAddress, mode: u8) -> Game {
        Game {
            id,
            player,
            started_at: starknet::get_block_timestamp(),
            ended_at: 0,
            guesses_used: 0,
            won: false,
            final_word_id: 0,
            mode,
        }
    }

    fn is_over(self: @Game) -> bool {
        *self.ended_at != 0
    }
}

#[generate_trait]
pub impl GameAssert of GameAssertTrait {
    fn assert_exists(self: @Game) {
        assert(*self.started_at != 0, Errors::NOT_FOUND);
    }

    fn assert_not_over(self: @Game) {
        assert(*self.ended_at == 0, Errors::OVER);
    }

    fn assert_owner(self: @Game, caller: ContractAddress) {
        assert(*self.player == caller, Errors::NOT_OWNER);
    }
}
