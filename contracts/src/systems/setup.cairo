// Setup contract.
//
// Exposes:
//   - dojo_init: bootstraps the empty Dictionary singleton (loaded = false).
//   - load_word_packs: batch-insert pre-packed WordPack rows (10 words per
//     u256 slot, 25 bits each). Reverts after finalize.
//   - finalize_dictionary: asserts the pack count matches ceil(words/10) and
//     flips loaded, overwriting dict.word_count from "pack rows seen" to the
//     real word count.
//
// Called from `scripts/load_dictionary.mjs` once after `sozo migrate`.

#[starknet::interface]
pub trait ISetup<T> {
    fn load_word_packs(ref self: T, start_pack_id: u16, packs: Array<u256>);
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
    use zordle::models::index::WordPack;
    use zordle::store::StoreTrait;

    fn dojo_init(ref self: ContractState) {
        let world: WorldStorage = self.world(@"zordle_0_1");
        let mut store = StoreTrait::new(world);
        let dict = DictionaryTrait::new();
        store.set_dictionary(@dict);
    }

    #[abi(embed_v0)]
    impl SetupImpl of super::ISetup<ContractState> {
        fn load_word_packs(
            ref self: ContractState, start_pack_id: u16, mut packs: Array<u256>,
        ) {
            let world: WorldStorage = self.world(@"zordle_0_1");
            let mut store = StoreTrait::new(world);
            let mut dict = store.dictionary();
            dict.assert_not_loaded();

            let batch_size: u16 = packs.len().try_into().unwrap();
            let mut offset: u16 = 0;
            while let Some(packed) = packs.pop_front() {
                let id = start_pack_id + offset;
                store.set_word_pack(@WordPack { id, packed });
                offset += 1;
            }

            // During load, dict.word_count tracks the number of pack rows
            // seen so finalize can sanity-check coverage. finalize overwrites
            // with the real word count.
            let new_count = start_pack_id + batch_size;
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

            let pack_count_seen: u16 = dict.word_count;
            let expected_packs: u16 = (expected_count + 9) / 10;
            assert(
                pack_count_seen == expected_packs,
                zordle::models::dictionary::Errors::COUNT_MISMATCH,
            );
            assert(
                answer_count > 0 && answer_count <= expected_count,
                zordle::models::dictionary::Errors::BAD_ANSWER_COUNT,
            );
            dict.word_count = expected_count;
            dict.answer_count = answer_count;
            dict.loaded = true;
            store.set_dictionary(@dict);
        }
    }
}
