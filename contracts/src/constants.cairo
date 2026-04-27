// Wordle game shape.
pub const WORD_LENGTH: u8 = 5;
pub const MAX_GUESSES: u8 = 6;

// 3^5 patterns (each of 5 positions can be grey/yellow/green).
pub const PATTERN_COUNT: u32 = 243;

// Bitmap chunking. NUM_CHUNKS must cover the answer pool (the only set the
// lazy boss is constrained to). For the NYT real-wordles list (2,315 words)
// we need ceil(2315 / 256) = 10 u256 chunks.
//
// Note: the candidates bitmap covers the *answer pool*, not the full
// vocabulary. Guess-only words live in word_ids beyond the bitmap's range
// and are never iterated during the lazy-boss bucketing pass.
pub const NUM_CHUNKS: u8 = 10;
pub const CHUNK_BITS: u32 = 256;
pub const MAX_ANSWER_COUNT: u32 = NUM_CHUNKS.into() * CHUNK_BITS;

// Dictionary singleton key.
pub const DICTIONARY_ID: u8 = 0;

// Letter packing: 5 bits per letter (a-z fits in 0..25), 5 letters per word.
pub const LETTER_BITS: u32 = 5;
pub const ALPHABET_SIZE: u8 = 26;

// Dojo namespace. Keep this in sync with dojo_*.toml.
pub fn DEFAULT_NS() -> ByteArray {
    "zordle_0_1"
}
