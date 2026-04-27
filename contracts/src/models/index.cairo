use starknet::ContractAddress;

// Singleton row (key = DICTIONARY_ID = 0) describing the loaded dictionary.
//
// The dictionary holds two ranges packed contiguously:
//   - [0 .. answer_count)            : answer pool (real wordles).
//                                      Lazy boss may pick from these.
//   - [answer_count .. word_count)   : guess-only (allowed-but-never-answer
//                                      words). Players may submit these,
//                                      but they're never in the candidate
//                                      bitmap.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct Dictionary {
    #[key]
    pub id: u8,
    pub word_count: u16,
    pub answer_count: u16,
    pub loaded: bool,
}

// One row per pack of up to 10 dictionary words. Each word packs 5 letter
// codes (a=0..z=25) into 5-bit slots inside 25 bits; ten such 25-bit slots
// fit into a u256 (250 bits used). pack_id = word_id / 10, slot in pack =
// word_id % 10. The trailing pack may have unused (zero-padded) slots beyond
// `dict.word_count`; callers must gate on `word_id < word_count` before
// reading.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct WordPack {
    #[key]
    pub id: u16,
    pub packed: u256,
}

// One row per game. The `id` field is mode-dependent:
//   - mode = 0 (practice): id = poseidon(player, timestamp, tx_hash).
//                          No EGC token; a player has at most one
//                          unfinished practice game at a time.
//   - mode = 1 (NFT):    id = Denshokan token_id — minted via our
//                        embedded MinigameComponent, salt derived
//                        from `token_id` so each NFT is its own
//                        unique game.
// Other invariants:
//   - `started_at == 0` means "doesn't exist" (Dojo returns zero default).
//   - `ended_at != 0` means the game is over (won or lost).
//   - `final_word_id` is the word the contract reveals on game end.
//   - No `seed` field — randomness comes from Cartridge VRF.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct Game {
    #[key]
    pub id: felt252,
    pub player: ContractAddress,
    pub started_at: u64,
    pub ended_at: u64,
    pub guesses_used: u8,
    pub won: bool,
    pub final_word_id: u16,
    pub mode: u8,
}

// Current unfinished practice game for a player. When the referenced game is
// over, start_practice creates a fresh one and overwrites this row.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ActiveGame {
    #[key]
    pub player: ContractAddress,
    pub game_id: felt252,
}

// Per-game candidate bitmap, sharded across NUM_CHUNKS u256 chunks.
// Bit `i` of chunk `c` corresponds to dictionary word id `c * 256 + i`.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct CandidateChunk {
    #[key]
    pub game_id: felt252,
    #[key]
    pub index: u8,
    pub bits: u256,
}

// Append-only log: one row per submitted guess. UI reads these to render
// the past-guess board. `pattern` is base-3 encoded (0..242).
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct Guess {
    #[key]
    pub game_id: felt252,
    #[key]
    pub index: u8,
    pub word_id: u16,
    pub pattern: u8,
    pub candidates_remaining: u16,
}
