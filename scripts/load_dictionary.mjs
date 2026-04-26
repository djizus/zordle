// Loads the answer pool followed by the guess-only words into the deployed
// Zordle world.
//
// Required env:
//   NODE_URL          - katana RPC (default http://localhost:5050)
//   ACCOUNT_ADDRESS   - prefunded katana account
//   PRIVATE_KEY       - matching key
//   SETUP_ADDRESS     - deployed setup contract (parsed from sozo manifest)
//   ANSWER_FILE       - path to real-wordles file (default scripts/shuffled_real_wordles.txt)
//   GUESS_FILE        - path to guess-only file (default scripts/official_allowed_guesses.txt)
//
// Loads ANSWER_FILE first (word_ids 0..A-1 = answer pool), then GUESS_FILE
// (word_ids A..A+G-1 = allowed-only). Calls finalize_dictionary(total, A).
//
// Pack format: 5 letters per word, 5 bits per letter (a=0..z=25), packed
// into 25 bits. Ten such 25-bit slots are concatenated into a u256 (250
// bits used) and stored as one WordPack row. The contract's setup expects
// pre-packed u256 packs via `load_word_packs`. Comment lines starting with
// '#' are skipped. Words are lowercased and validated against /^[a-z]{5}$/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, CallData, RpcProvider } from "starknet";

const here = dirname(fileURLToPath(import.meta.url));
const ANSWER_FILE = process.env.ANSWER_FILE
  ?? resolve(here, "shuffled_real_wordles.txt");
const GUESS_FILE = process.env.GUESS_FILE
  ?? resolve(here, "official_allowed_guesses.txt");

const RPC = process.env.NODE_URL ?? "http://localhost:5050";
const ACCOUNT = process.env.ACCOUNT_ADDRESS;
const PRIVKEY = process.env.PRIVATE_KEY;
const SETUP_ADDR = process.env.SETUP_ADDRESS;

if (!ACCOUNT || !PRIVKEY || !SETUP_ADDR) {
  console.error(
    "Missing env. Required: ACCOUNT_ADDRESS, PRIVATE_KEY, SETUP_ADDRESS",
  );
  process.exit(1);
}

function readWords(path) {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .filter((w) => /^[a-z]{5}$/.test(w));
}

const answerWords = readWords(ANSWER_FILE);
const guessOnly = readWords(GUESS_FILE);

if (answerWords.length === 0) {
  console.error("No answer words found in", ANSWER_FILE);
  process.exit(1);
}

// Defensive de-dup: drop guess-only words that already appear in the
// answer pool. The two NYT files are disjoint by construction; this just
// keeps things safe if someone swaps in custom files.
const answerSet = new Set(answerWords);
const guessOnlyDeduped = guessOnly.filter((w) => !answerSet.has(w));

const allWords = [...answerWords, ...guessOnlyDeduped];
const ANSWER_COUNT = answerWords.length;
const TOTAL = allWords.length;

console.log(
  `answer pool : ${ANSWER_COUNT.toString().padStart(6)} from ${ANSWER_FILE}`,
);
console.log(
  `guess-only  : ${guessOnlyDeduped.toString().padStart(6).length}` +
    ` (read ${guessOnly.length}, deduped ${guessOnly.length - guessOnlyDeduped.length})`,
);
console.log(`total       : ${TOTAL.toString().padStart(6)}`);

function packWord(word) {
  let packed = 0n;
  for (let i = 0; i < 5; i++) {
    const code = BigInt(word.charCodeAt(i) - 97);
    packed += code << BigInt(i * 5);
  }
  return packed;
}

// Pack 10 consecutive words into one u256: each word in its own 25-bit slot
// at position `i * 25`. Trailing positions are zero (decode to "aaaaa" but
// never read because callers gate on word_id < dict.word_count).
function packWords10(words) {
  let pack = 0n;
  for (let i = 0; i < words.length; i++) {
    const w = packWord(words[i]);
    pack += w << BigInt(i * 25);
  }
  return pack;
}

// starknet.js u256 calldata format is { low, high } 128-bit halves.
function toU256(x) {
  const MASK = (1n << 128n) - 1n;
  return { low: (x & MASK).toString(), high: (x >> 128n).toString() };
}

const provider = new RpcProvider({ nodeUrl: RPC });
const account = new Account({
  provider,
  address: ACCOUNT,
  signer: PRIVKEY,
});

// Pack words into u256 packs (10 words per pack).
const PACK_SIZE = 10;
const packs = [];
for (let i = 0; i < allWords.length; i += PACK_SIZE) {
  packs.push(packWords10(allWords.slice(i, i + PACK_SIZE)));
}
const PACK_COUNT = packs.length;
console.log(`packs       : ${PACK_COUNT.toString().padStart(6)} (10 words each)`);

// Each batch of ~50 packs = 500 words, similar calldata size to the old loader.
const PACK_BATCH = 50;
const t0 = Date.now();
for (let i = 0; i < packs.length; i += PACK_BATCH) {
  const batch = packs.slice(i, i + PACK_BATCH).map(toU256);
  process.stdout.write(
    `  packs ${String(i).padStart(4)}..${String(i + batch.length - 1).padStart(4)}... `,
  );
  const { transaction_hash } = await account.execute({
    contractAddress: SETUP_ADDR,
    entrypoint: "load_word_packs",
    calldata: CallData.compile([i, batch]),
  });
  await provider.waitForTransaction(transaction_hash);
  console.log("ok");
}
console.log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log(`Finalizing (total=${TOTAL}, answer_count=${ANSWER_COUNT})`);
const { transaction_hash } = await account.execute({
  contractAddress: SETUP_ADDR,
  entrypoint: "finalize_dictionary",
  calldata: CallData.compile([TOTAL, ANSWER_COUNT]),
});
await provider.waitForTransaction(transaction_hash);

// Write the canonical word list for the web client. Order MUST match the
// on-chain word_id ordering (answer pool first, then guess-only) so that
// `wordIndex.get(typed) === word_id` agrees with the contract.
const clientPath = resolve(here, "../client/public/words.txt");
mkdirSync(dirname(clientPath), { recursive: true });
writeFileSync(clientPath, allWords.join("\n") + "\n");
console.log(`Wrote ${allWords.length} words to ${clientPath}`);

console.log("Done.");
