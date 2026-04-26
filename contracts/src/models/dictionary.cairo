use crate::constants::DICTIONARY_ID;
pub use crate::models::index::Dictionary;

pub mod Errors {
    pub const ALREADY_LOADED: felt252 = 'Dict: already loaded';
    pub const NOT_LOADED: felt252 = 'Dict: not loaded';
    pub const COUNT_MISMATCH: felt252 = 'Dict: count mismatch';
    pub const BAD_ANSWER_COUNT: felt252 = 'Dict: bad answer count';
}

#[generate_trait]
pub impl DictionaryImpl of DictionaryTrait {
    fn new() -> Dictionary {
        Dictionary { id: DICTIONARY_ID, word_count: 0, answer_count: 0, loaded: false }
    }
}

#[generate_trait]
pub impl DictionaryAssert of DictionaryAssertTrait {
    fn assert_loaded(self: @Dictionary) {
        assert(*self.loaded, Errors::NOT_LOADED);
    }

    fn assert_not_loaded(self: @Dictionary) {
        assert(!*self.loaded, Errors::ALREADY_LOADED);
    }
}
