import { RpcProvider } from "starknet";

export type GameMode = "daily" | "nft";

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

const nftActions =
  (env.VITE_PUBLIC_ACTIONS_ADDRESS_NFT as string | undefined) ?? legacyActions ?? "";
const nftRpc =
  (env.VITE_PUBLIC_NODE_URL_NFT as string | undefined) ??
  legacyRpc ??
  "https://api.cartridge.gg/x/starknet/sepolia";

const dailyActions =
  (env.VITE_PUBLIC_ACTIONS_ADDRESS_DAILY as string | undefined) ?? legacyActions ?? "";
const dailyRpc =
  (env.VITE_PUBLIC_NODE_URL_DAILY as string | undefined) ??
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
  namespace: (env.VITE_PUBLIC_NAMESPACE_NFT as string | undefined) ?? "zordle_0_1",
  slot: (env.VITE_PUBLIC_SLOT_NFT as string | undefined) ?? env.VITE_PUBLIC_SLOT,
};

export const DAILY_NETWORK: ZordleNetwork = {
  mode: "daily",
  rpcUrl: dailyRpc,
  chainId:
    (env.VITE_PUBLIC_CHAIN_ID_DAILY as string | undefined) ?? "WP_ZORDLE_DAILY_SLOT",
  actionsAddress: dailyActions,
  vrfAddress: (env.VITE_PUBLIC_VRF_ADDRESS_DAILY as string | undefined) ?? ZERO_ADDRESS,
  namespace: (env.VITE_PUBLIC_NAMESPACE_DAILY as string | undefined) ?? "zordle_0_1",
  slot: (env.VITE_PUBLIC_SLOT_DAILY as string | undefined) ?? "zordle-daily-slot",
};

export const networkForMode = (mode: GameMode): ZordleNetwork =>
  mode === "daily" ? DAILY_NETWORK : NFT_NETWORK;

export const providerForNetwork = (network: ZordleNetwork) =>
  new RpcProvider({ nodeUrl: network.rpcUrl });

export const isZeroAddress = (address: string | undefined | null): boolean =>
  !address || BigInt(address) === 0n;

