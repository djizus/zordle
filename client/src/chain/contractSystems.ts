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

// Salt convention mirrors the contract's mode-aware derivation:
//   - Daily (mode 0): salt = poseidon(day, turn, word_id)
//   - NFT (mode 1):   salt = poseidon(token_id, turn, word_id)
// The day approximation uses wall-clock UTC; block timestamps are within
// a few seconds of UTC, so the only edge case is a guess submitted right
// at midnight that lands in the next day's block. If consume_random
// reverts, retry — the next block's day matches the new salt.
const SECONDS_PER_DAY = 86_400n;
const computeDay = (): bigint => BigInt(Math.floor(Date.now() / 1000)) / SECONDS_PER_DAY;
const DAILY_DOMAIN = BigInt("0x5a4f52444c455f4441494c59"); // 'ZORDLE_DAILY'

const dailySeed = (): bigint =>
  BigInt(
    hash.computePoseidonHashOnElements([
      computeDay(),
      DAILY_DOMAIN,
    ]),
  );

const dailySalt = (guessesUsed: number, wordId: number): bigint =>
  BigInt(
    hash.computePoseidonHashOnElements([
      dailySeed(),
      BigInt(guessesUsed),
      BigInt(wordId),
    ]),
  );

const nftSalt = (tokenId: bigint, guessesUsed: number, wordId: number): bigint =>
  BigInt(
    hash.computePoseidonHashOnElements([
      tokenId,
      BigInt(guessesUsed),
      BigInt(wordId),
    ]),
  );

// Daily-mode start: no token, contract derives game_id internally and
// returns it. We refetch via daily_game_id view rather than parsing the tx
// return value (Cartridge Controller doesn't surface return values cleanly).
export const startDaily = async (network: ZordleNetwork, account: AccountInterface) =>
  account.execute([
    {
      contractAddress: network.actionsAddress,
      entrypoint: "start_daily",
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

// One submitGuess for both modes. `tokenId` is null for daily — we use the
// daily salt; non-null for NFT — we use the per-token salt. game_id is
// passed verbatim to the contract (it stored the mode at start time).
export const submitGuess = async (
  network: ZordleNetwork,
  account: AccountInterface,
  gameId: bigint,
  tokenId: bigint | null,
  guessesUsed: number,
  wordId: number,
) => {
  const salt =
    tokenId === null
      ? dailySalt(guessesUsed, wordId)
      : nftSalt(tokenId, guessesUsed, wordId);
  const calls: Call[] = [
    {
      contractAddress: network.actionsAddress,
      entrypoint: "guess",
      calldata: CallData.compile([gameId, wordId]),
    },
  ];

  if (!isZeroAddress(network.vrfAddress)) {
    calls.unshift(buildVrfRequestCall(network, network.actionsAddress, salt));
  }

  return account.execute(calls);
};
