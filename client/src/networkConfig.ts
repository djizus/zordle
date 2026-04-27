import { RpcProvider } from "starknet";
import { contractAddressFromManifest } from "./manifest";

export type GameMode = "practice" | "nft";

export type ZordleNetwork = {
  mode: GameMode;
  rpcUrl: string;
  chainId: string;
  actionsAddress: string;
  vrfAddress: string;
  namespace: string;
  slot?: string;
};

export const ZERO_ADDRESS = "0x0";

const env = import.meta.env;

const legacyActions = env.VITE_PUBLIC_ACTIONS_ADDRESS as string | undefined;
const legacyRpc = env.VITE_PUBLIC_NODE_URL as string | undefined;
const nftNamespace = (env.VITE_PUBLIC_NAMESPACE_NFT as string | undefined) ?? "zordle_0_1";
const practiceNamespace =
  (env.VITE_PUBLIC_NAMESPACE_PRACTICE as string | undefined) ?? "zordle_0_1";

const nftActions =
  contractAddressFromManifest("sepolia", nftNamespace, "actions") ??
  (env.VITE_PUBLIC_ACTIONS_ADDRESS_NFT as string | undefined) ??
  legacyActions ??
  "";
const nftRpc =
  (env.VITE_PUBLIC_NODE_URL_NFT as string | undefined) ??
  legacyRpc ??
  "https://api.cartridge.gg/x/starknet/sepolia";

const practiceActions =
  contractAddressFromManifest("slot", practiceNamespace, "actions") ??
  (env.VITE_PUBLIC_ACTIONS_ADDRESS_PRACTICE as string | undefined) ??
  legacyActions ??
  "";
const practiceRpc =
  (env.VITE_PUBLIC_NODE_URL_PRACTICE as string | undefined) ??
  legacyRpc ??
  "http://localhost:5050";

export const NFT_NETWORK: ZordleNetwork = {
  mode: "nft",
  rpcUrl: nftRpc,
  chainId: (env.VITE_PUBLIC_CHAIN_ID_NFT as string | undefined) ?? "SN_SEPOLIA",
  actionsAddress: nftActions,
  vrfAddress:
    (env.VITE_PUBLIC_VRF_ADDRESS_NFT as string | undefined) ??
    (env.VITE_PUBLIC_VRF_ADDRESS as string | undefined) ??
    "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f",
  namespace: nftNamespace,
  slot: (env.VITE_PUBLIC_SLOT_NFT as string | undefined) ?? env.VITE_PUBLIC_SLOT,
};

export const PRACTICE_NETWORK: ZordleNetwork = {
  mode: "practice",
  rpcUrl: practiceRpc,
  chainId:
    (env.VITE_PUBLIC_CHAIN_ID_PRACTICE as string | undefined) ?? "WP_ZORDLE_PRACTICE_SLOT",
  actionsAddress: practiceActions,
  vrfAddress: (env.VITE_PUBLIC_VRF_ADDRESS_PRACTICE as string | undefined) ?? ZERO_ADDRESS,
  namespace: practiceNamespace,
  slot: (env.VITE_PUBLIC_SLOT_PRACTICE as string | undefined) ?? "zordle-practice-slot",
};

export const networkForMode = (mode: GameMode): ZordleNetwork =>
  mode === "practice" ? PRACTICE_NETWORK : NFT_NETWORK;

export const providerForNetwork = (network: ZordleNetwork) =>
  new RpcProvider({ nodeUrl: network.rpcUrl });

export const isZeroAddress = (address: string | undefined | null): boolean =>
  !address || BigInt(address) === 0n;
