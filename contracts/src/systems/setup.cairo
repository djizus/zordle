// Setup contract.
//
// Exposes:
//   - dojo_init: bootstraps the empty Dictionary singleton (loaded = false).
//   - load_words: batch-insert pre-packed Word rows. Reverts after finalize.
//   - finalize_dictionary: asserts the row count matches and flips loaded.
//
// Called from `scripts/load_dictionary.ts` once after `sozo migrate`.

#[starknet::interface]
pub trait ISetup<T> {
    fn load_words(ref self: T, start_id: u16, words: Array<u32>);
    // Locks the dictionary. answer_count is the size of the prefix of
    // word_ids that the lazy boss is allowed to pick from; the remaining
    // [answer_count..expected_count) are valid guess words but can never
    // be the answer.
    fn finalize_dictionary(ref self: T, expected_count: u16, answer_count: u16);
}

#[dojo::contract]
pub mod setup {
    use dojo::world::WorldStorage;
    use zordle::models::dictionary::{DictionaryAssert, DictionaryTrait};
    use zordle::models::index::Word;
    use zordle::store::StoreTrait;

    fn dojo_init(ref self: ContractState) {
        let world: WorldStorage = self.world(@"zordle_0_1");
        let mut store = StoreTrait::new(world);
        let dict = DictionaryTrait::new();
        store.set_dictionary(@dict);
    }

    #[abi(embed_v0)]
    impl SetupImpl of super::ISetup<ContractState> {
        fn load_words(ref self: ContractState, start_id: u16, mut words: Array<u32>) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);
            let mut dict = store.dictionary();
            dict.assert_not_loaded();

            let batch_size: u16 = words.len().try_into().unwrap();
            let mut offset: u16 = 0;
            while let Some(letters) = words.pop_front() {
                let id = start_id + offset;
                store.set_word(@Word { id, letters });
                offset += 1;
            }

            let new_count = start_id + batch_size;
            if new_count > dict.word_count {
                dict.word_count = new_count;
                store.set_dictionary(@dict);
            }
        }

        fn finalize_dictionary(
            ref self: ContractState, expected_count: u16, answer_count: u16,
        ) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);
            let mut dict = store.dictionary();
            dict.assert_not_loaded();
            assert(
                dict.word_count == expected_count,
                zordle::models::dictionary::Errors::COUNT_MISMATCH,
            );
            assert(
                answer_count > 0 && answer_count <= expected_count,
                zordle::models::dictionary::Errors::BAD_ANSWER_COUNT,
            );
            dict.answer_count = answer_count;
            dict.loaded = true;
            store.set_dictionary(@dict);
        }
    }
}
