// Multicall builders for the Cartridge Controller account. Each game-state
// mutation (start_game, guess, surrender) is paired with a VRF
// `request_random` preamble so the contract's consume_random call inside
// the same tx can resolve.

import { CallData, hash, type AccountInterface, type Call } from "starknet";

const ACTIONS_ADDRESS = import.meta.env.VITE_PUBLIC_ACTIONS_ADDRESS as string;
const VRF_ADDRESS =
  (import.meta.env.VITE_PUBLIC_VRF_ADDRESS as string) ??
  "0x051fea4450da9d6aee758bdeba88b2f665bcbf549d2c61421aa724e9ac0ced8f";

if (!ACTIONS_ADDRESS) {
  throw new Error("VITE_PUBLIC_ACTIONS_ADDRESS missing — run deploy_sepolia.sh");
}

// Source variant: 0 = Source::Nonce(addr), 1 = Source::Salt(felt).
// We always use Salt so the salt can be reproduced contract-side from
// (token_id, guesses_used, word_id).
const SOURCE_SALT_VARIANT = 1;

const buildVrfRequestCall = (caller: string, salt: bigint): Call => ({
  contractAddress: VRF_ADDRESS,
  entrypoint: "request_random",
  calldata: CallData.compile({
    caller,
    source: { type: SOURCE_SALT_VARIANT, salt },
  }),
});

// Mint a Denshokan token whose game is our actions contract. Returns a
// receipt tx_hash; the caller is expected to fish out the new token_id
// from the events. The MinigameComponent embeds `mint_game` in our contract.
export const mintGame = async (account: AccountInterface) => {
  return account.execute([
    {
      contractAddress: ACTIONS_ADDRESS,
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

// Salt convention shared with the contract: salt = poseidon([day, turn, word_id]).
// The contract derives `day = block_timestamp / 86400`. We approximate with
// the wall clock — block timestamps are within a few seconds of UTC, so
// the only edge case is a guess submitted right at midnight that lands in
// the next day's block. If you see consume_random revert, retry — the next
// block's day matches the new salt.
const SECONDS_PER_DAY = 86_400n;
const computeDay = (): bigint => BigInt(Math.floor(Date.now() / 1000)) / SECONDS_PER_DAY;
const computeSalt = (day: bigint, guessesUsed: number, wordId: number): bigint =>
  BigInt(
    hash.computePoseidonHashOnElements([
      day,
      BigInt(guessesUsed),
      BigInt(wordId),
    ]),
  );

export const startGame = async (account: AccountInterface, tokenId: bigint) => {
  return account.execute([
    {
      contractAddress: ACTIONS_ADDRESS,
      entrypoint: "start_game",
      calldata: CallData.compile([tokenId]),
    },
  ]);
};

export const submitGuess = async (
  account: AccountInterface,
  tokenId: bigint,
  guessesUsed: number,
  wordId: number,
) => {
  const salt = computeSalt(computeDay(), guessesUsed, wordId);
  return account.execute([
    buildVrfRequestCall(ACTIONS_ADDRESS, salt),
    {
      contractAddress: ACTIONS_ADDRESS,
      entrypoint: "guess",
      calldata: CallData.compile([tokenId, wordId]),
    },
  ]);
};

export const surrenderGame = async (account: AccountInterface, tokenId: bigint) => {
  return account.execute([
    {
      contractAddress: ACTIONS_ADDRESS,
      entrypoint: "surrender",
      calldata: CallData.compile([tokenId]),
    },
  ]);
};
