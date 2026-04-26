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
// into a u32. Comment lines starting with '#' are skipped. Words are
// lowercased and validated against /^[a-z]{5}$/.

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

const provider = new RpcProvider({ nodeUrl: RPC });
const account = new Account({
  provider,
  address: ACCOUNT,
  signer: PRIVKEY,
});

const BATCH = 500;
const t0 = Date.now();
for (let i = 0; i < allWords.length; i += BATCH) {
  const batch = allWords.slice(i, i + BATCH);
  const packed = batch.map(packWord);
  process.stdout.write(
    `  batch ${String(i).padStart(5)}..${String(i + batch.length - 1).padStart(5)}... `,
  );
  const { transaction_hash } = await account.execute({
    contractAddress: SETUP_ADDR,
    entrypoint: "load_words",
    calldata: CallData.compile([i, packed]),
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
