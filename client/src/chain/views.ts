// Read-only contract views. These don't require an account; they go
// through the read-only RpcProvider so they work regardless of whether
// the user has connected a Controller account yet.

import { CallData, RpcProvider } from "starknet";
import {
  decodeDictionary,
  decodeGame,
  decodeGuess,
  type Dictionary,
  type Game,
  type Guess,
} from "./state";

const ACTIONS_ADDRESS = import.meta.env.VITE_PUBLIC_ACTIONS_ADDRESS as string;
const RPC_URL =
  import.meta.env.VITE_PUBLIC_NODE_URL ??
  "https://api.cartridge.gg/x/starknet/sepolia";

const provider = new RpcProvider({ nodeUrl: RPC_URL });

const view = async (entrypoint: string, calldata: any[]): Promise<string[]> =>
  provider.callContract({
    contractAddress: ACTIONS_ADDRESS,
    entrypoint,
    calldata: CallData.compile(calldata),
  });

export const getDictionary = async (): Promise<Dictionary> =>
  decodeDictionary(await view("get_dictionary", []));

export const getGame = async (tokenId: bigint): Promise<Game> =>
  decodeGame(await view("get_game", [tokenId]));

export const getGuess = async (tokenId: bigint, index: number): Promise<Guess> =>
  decodeGuess(await view("get_guess", [tokenId, index]));

export const getCandidateChunk = async (
  gameId: bigint,
  index: number,
): Promise<bigint> => {
  const [low, high = "0"] = await view("get_chunk", [gameId, index]);
  return BigInt(low) + (BigInt(high) << 128n);
};

export const getDailyGameId = async (player: string): Promise<bigint> => {
  const [out] = await view("daily_game_id", [player]);
  return BigInt(out);
};
