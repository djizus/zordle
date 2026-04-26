pub use crate::models::index::CandidateChunk;

#[generate_trait]
pub impl CandidateChunkImpl of CandidateChunkTrait {
    fn new(game_id: felt252, index: u8, bits: u256) -> CandidateChunk {
        CandidateChunk { game_id, index, bits }
    }
}
