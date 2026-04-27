// Read-only contract views. These don't require an account; they go
// through the read-only RpcProvider so they work regardless of whether
// the user has connected a Controller account yet.

import { CallData } from "starknet";
import { providerForNetwork, type ZordleNetwork } from "../networkConfig";
import {
  decodeDictionary,
  decodeGame,
  decodeGuess,
  type Dictionary,
  type Game,
  type Guess,
} from "./state";

const view = async (
  network: ZordleNetwork,
  entrypoint: string,
  calldata: any[],
): Promise<string[]> =>
  providerForNetwork(network).callContract({
    contractAddress: network.actionsAddress,
    entrypoint,
    calldata: CallData.compile(calldata),
  });

export const getDictionary = async (network: ZordleNetwork): Promise<Dictionary> =>
  decodeDictionary(await view(network, "get_dictionary", []));

export const getGame = async (
  network: ZordleNetwork,
  tokenId: bigint,
): Promise<Game> => decodeGame(await view(network, "get_game", [tokenId]));

export const getGuess = async (
  network: ZordleNetwork,
  tokenId: bigint,
  index: number,
): Promise<Guess> => decodeGuess(await view(network, "get_guess", [tokenId, index]));

export const getCandidateChunk = async (
  network: ZordleNetwork,
  gameId: bigint,
  index: number,
): Promise<bigint> => {
  const [low, high = "0"] = await view(network, "get_chunk", [gameId, index]);
  return BigInt(low) + (BigInt(high) << 128n);
};

export const getActiveGameId = async (
  network: ZordleNetwork,
  player: string,
): Promise<bigint> => {
  const [out] = await view(network, "active_game_id", [player]);
  return BigInt(out);
};
