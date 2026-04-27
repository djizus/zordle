// Contract call builders. VRF preambles are included only for deployments
// configured with a non-zero VRF address.

import { CallData, hash, type AccountInterface, type Call } from "starknet";
import { isZeroAddress, type ZordleNetwork } from "../networkConfig";

// Source variant: 0 = Source::Nonce(addr), 1 = Source::Salt(felt).
// We always use Salt so the salt can be reproduced contract-side from
// (token_id, guesses_used, word_id).
const SOURCE_SALT_VARIANT = 1;

const buildVrfRequestCall = (
  network: ZordleNetwork,
  caller: string,
  salt: bigint,
): Call => ({
  contractAddress: network.vrfAddress,
  entrypoint: "request_random",
  calldata: CallData.compile({
    caller,
    source: { type: SOURCE_SALT_VARIANT, salt },
  }),
});

// Mint a Denshokan token whose game is our actions contract. Returns a
// receipt tx_hash; the caller is expected to fish out the new token_id
// from the events. The MinigameComponent embeds `mint_game` in our contract.
export const mintGame = async (network: ZordleNetwork, account: AccountInterface) => {
  return account.execute([
    {
      contractAddress: network.actionsAddress,
      entrypoint: "mint_game",
      // game_components_embeddable_game_standard's minigame::mint_game
      // expects an Option-heavy struct — we pass all None for v1.
      calldata: CallData.compile({
        player_name: 0,
        settings_id: 0,
        start: 0,
        end: 0,
        objective_ids: [],
        context: 0,
        client_url: 0,
        renderer_address: 0,
        to_address: account.address,
        soulbound: false,
      }),
    },
  ]);
};

// Salt convention mirrors the contract:
//   salt = poseidon(game_id, turn, word_id)
// For NFT games, game_id is the token id.
const gameSalt = (gameId: bigint, guessesUsed: number, wordId: number): bigint =>
  BigInt(
    hash.computePoseidonHashOnElements([
      gameId,
      BigInt(guessesUsed),
      BigInt(wordId),
    ]),
  );

// Practice start: no token, contract derives game_id internally and
// returns it. We refetch via active_game_id view rather than parsing the tx
// return value (Cartridge Controller doesn't surface return values cleanly).
export const startPractice = async (network: ZordleNetwork, account: AccountInterface) =>
  account.execute([
    {
      contractAddress: network.actionsAddress,
      entrypoint: "start_practice",
      calldata: [],
    },
  ]);

export const startNftGame = async (
  network: ZordleNetwork,
  account: AccountInterface,
  tokenId: bigint,
) =>
  account.execute([
    {
      contractAddress: network.actionsAddress,
      entrypoint: "start_game",
      calldata: CallData.compile([tokenId]),
    },
  ]);

// One submitGuess for both modes. game_id is passed verbatim to the contract
// (it stored the mode at start time). `tokenId` is only used to decide whether
// the NFT deployment needs a VRF preamble.
export const submitGuess = async (
  network: ZordleNetwork,
  account: AccountInterface,
  gameId: bigint,
  tokenId: bigint | null,
  guessesUsed: number,
  wordId: number,
) => {
  const salt = gameSalt(gameId, guessesUsed, wordId);
  const calls: Call[] = [
    {
      contractAddress: network.actionsAddress,
      entrypoint: "guess",
      calldata: CallData.compile([gameId, wordId]),
    },
  ];

  if (tokenId !== null && !isZeroAddress(network.vrfAddress)) {
    calls.unshift(buildVrfRequestCall(network, network.actionsAddress, salt));
  }

  return account.execute(calls);
};
