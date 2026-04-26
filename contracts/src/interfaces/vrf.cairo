// Cartridge VRF interface — verbatim port from zkube. The VRF provider
// contract on Sepolia/Mainnet implements this; we call `consume_random`
// (with a Source::Salt(salt) the client also encoded into the multicall
// `request_random` preamble) to receive a verifiable random felt.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IVrfProvider<TContractState> {
    fn request_random(self: @TContractState, caller: ContractAddress, source: Source);
    fn consume_random(ref self: TContractState, source: Source) -> felt252;
}

#[derive(Drop, Copy, Clone, Serde)]
pub enum Source {
    Nonce: ContractAddress,
    Salt: felt252,
}
