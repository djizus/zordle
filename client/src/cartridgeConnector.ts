// Cartridge Controller connector.
//
// Slimmer than zkube's because we only ship one contract (actions) and
// pick the chain via VITE_PUBLIC_DOJO_PROFILE (sepolia or mainnet).
// Policies are hardcoded against env-supplied addresses so we don't need
// a manifest_<profile>.json import at build time.

import type { Connector } from "@starknet-react/core";
import ControllerConnector from "@cartridge/connector/controller";
import type { AuthOptions, ControllerOptions } from "@cartridge/controller";
import { contractAddressFromManifest } from "./manifest";

// Inline shape — @cartridge/presets's `SessionPolicies` is a peer dep we
// don't want to add. The structure is stable.
type SessionPolicies = {
  contracts: Record<
    string,
    {
      description: string;
      methods: Array<{ name: string; entrypoint: string }>;
    }
  >;
};
import { shortString } from "starknet";

const SEPOLIA_CHAIN_ID = "SN_SEPOLIA";
const MAINNET_CHAIN_ID = "SN_MAIN";
const SEPOLIA_RPC_URL = "https://api.cartridge.gg/x/starknet/sepolia";
const MAINNET_RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";

// Cartridge VRF on Sepolia/Mainnet — same contract, same address.
const VRF_ADDRESS =
  "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

const NFT_PROFILE =
  (import.meta.env.VITE_PUBLIC_DOJO_PROFILE as string | undefined) ?? "sepolia";
const DEFAULT_CHAIN_ID = NFT_PROFILE === "mainnet" ? MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID;

const NAMESPACE =
  import.meta.env.VITE_PUBLIC_NAMESPACE_NFT ??
  import.meta.env.VITE_PUBLIC_NAMESPACE ??
  "zordle_0_1";
const ACTIONS_ADDRESS =
  contractAddressFromManifest(NFT_PROFILE, NAMESPACE, "actions") ??
  import.meta.env.VITE_PUBLIC_ACTIONS_ADDRESS_NFT ??
  import.meta.env.VITE_PUBLIC_ACTIONS_ADDRESS ??
  "0x1";
const SLOT = import.meta.env.VITE_PUBLIC_SLOT_NFT ?? import.meta.env.VITE_PUBLIC_SLOT ?? "zordle-sepolia";

const stringToFelt = (v: string) =>
  v ? shortString.encodeShortString(v) : "0x0";

// Methods the session key is allowed to call without a per-tx signature.
// Keep this in sync with the IActions trait in actions.cairo and any
// minigame-component entrypoints we exercise from the client (mint_game).
const ACTIONS_METHODS = [
  { name: "Start game", entrypoint: "start_game" },
  { name: "Guess", entrypoint: "guess" },
  { name: "Mint game", entrypoint: "mint_game" },
];

const VRF_METHODS = [
  { name: "Request random", entrypoint: "request_random" },
];

const policies: SessionPolicies = {
  contracts: {
    [VRF_ADDRESS]: {
      description: "Cartridge VRF — random number generation",
      methods: VRF_METHODS,
    },
    [ACTIONS_ADDRESS]: {
      description: "Zordle actions — game lifecycle + guesses",
      methods: ACTIONS_METHODS,
    },
  },
};

const signupOptions: AuthOptions = ["google", "discord", "webauthn", "password"];

const options: ControllerOptions = {
  chains: [{ rpcUrl: SEPOLIA_RPC_URL }, { rpcUrl: MAINNET_RPC_URL }],
  defaultChainId: stringToFelt(DEFAULT_CHAIN_ID).toString(),
  namespace: NAMESPACE,
  slot: SLOT,
  policies,
  signupOptions,
};

export const cartridgeConnector = new ControllerConnector(
  options,
) as unknown as Connector;
