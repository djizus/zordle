// Randomness wrapper — delegates to Cartridge VRF when an address is
// configured on the actions contract; falls back to a deterministic
// pseudo-random derivation when running against local katana (where the
// VRF provider is not deployed).
//
// On Sepolia/Mainnet the actions contract stores `vrf_address` from
// dojo_init. On dev/katana the deployer leaves it zero and we use
// pseudo_random instead.

use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use starknet::{
    ContractAddress, get_block_timestamp, get_caller_address, get_contract_address, get_tx_info,
};
use zordle::interfaces::vrf::{IVrfProviderDispatcher, IVrfProviderDispatcherTrait, Source};

pub fn vrf_random(vrf_address: ContractAddress, salt: felt252) -> felt252 {
    let provider = IVrfProviderDispatcher { contract_address: vrf_address };
    provider.consume_random(Source::Salt(salt))
}

pub fn pseudo_random(salt: felt252) -> felt252 {
    let tx_info = get_tx_info().unbox();
    let caller = get_caller_address();
    let contract = get_contract_address();
    let timestamp: felt252 = get_block_timestamp().into();
    poseidon_hash_span(
        array![
            tx_info.transaction_hash,
            caller.into(),
            contract.into(),
            timestamp,
            tx_info.nonce,
            salt,
        ]
            .span(),
    )
}

// Unified entry point. If the contract has been initialised with a non-zero
// VRF provider address, defer to VRF; otherwise derive locally.
pub fn random_from(vrf_address: ContractAddress, salt: felt252) -> felt252 {
    if vrf_address.is_zero() {
        pseudo_random(salt)
    } else {
        vrf_random(vrf_address, salt)
    }
}
