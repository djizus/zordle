// Pattern distribution analysis for Zordle openers.
//
// For a given opener, computes the Wordle feedback pattern of every word
// in the answer pool against that opener and reports the bucket size of
// each of the 243 possible patterns (3^5 = 5 positions x {grey, yellow,
// green}). Empty buckets are included so we can see the full distribution,
// not just the non-empty subset the contract sees today.
//
// Usage:
//   node scripts/pattern_distribution.mjs                 # default opener: trace
//   node scripts/pattern_distribution.mjs slate           # custom opener
//   node scripts/pattern_distribution.mjs trace --full    # dump all rows
//   node scripts/pattern_distribution.mjs --pool=merged   # full 14855 vocab as candidates
//
// To experiment with a custom pool (e.g. a curated answer set), regenerate
// it via scripts/curate_answers.mjs and add an entry to POOLS below.
//
// Pattern encoding matches contracts/src/helpers/wordle.cairo:compute_pattern:
//   trit per position: 0 = grey, 1 = yellow, 2 = green
//   pattern = p0 + p1*3 + p2*9 + p3*27 + p4*81
//   two-pass: greens consume target slots first, then yellows take the
//   leftmost unused matching target slot.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const opener = (positional[0] ?? "trace").toLowerCase();

const poolFlag = [...flags].find((f) => f.startsWith("--pool="));
const poolName = poolFlag ? poolFlag.slice("--pool=".length) : "answers";

const POOLS = {
  answers: "shuffled_real_wordles.txt",
  merged: "merged_valid_wordles.txt",
};
const poolFile = POOLS[poolName];
if (!poolFile) {
  console.error(`unknown --pool=${poolName}; choose one of: ${Object.keys(POOLS).join(", ")}`);
  process.exit(1);
}

if (!/^[a-z]{5}$/.test(opener)) {
  console.error(`opener must be 5 lowercase letters, got '${opener}'`);
  process.exit(1);
}

function loadWords(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((w) => w.toLowerCase())
    .filter((w) => /^[a-z]{5}$/.test(w));
}

const candidates = loadWords(resolve(here, poolFile));

// Two-pass Wordle feedback. Mirrors contracts/src/helpers/wordle.cairo.
function computePattern(guess, target) {
  const g = [...guess];
  const t = [...target];
  const p = [0, 0, 0, 0, 0];
  const used = [false, false, false, false, false];

  for (let i = 0; i < 5; i++) {
    if (g[i] === t[i]) {
      p[i] = 2; // green
      used[i] = true;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (p[i] !== 0) continue;
    for (let j = 0; j < 5; j++) {
      if (!used[j] && g[i] === t[j]) {
        p[i] = 1; // yellow
        used[j] = true;
        break;
      }
    }
  }

  return p[0] + p[1] * 3 + p[2] * 9 + p[3] * 27 + p[4] * 81;
}

function patternToString(code) {
  let n = code;
  let out = "";
  for (let i = 0; i < 5; i++) {
    const trit = n % 3;
    n = (n - trit) / 3;
    out += trit === 0 ? "." : trit === 1 ? "y" : "G";
  }
  return out;
}

const counts = new Array(243).fill(0);
for (const word of candidates) {
  counts[computePattern(opener, word)]++;
}

const nonEmptyCount = counts.filter((c) => c > 0).length;
const emptyCount = 243 - nonEmptyCount;
const total = candidates.length;

const sortedNonEmpty = counts
  .map((c, code) => ({ code, count: c }))
  .filter((b) => b.count > 0)
  .sort((a, b) => b.count - a.count);

const sizes = sortedNonEmpty.map((b) => b.count).sort((a, b) => a - b);
function pct(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[idx];
}

const sizeHist = new Map();
for (const s of sizes) sizeHist.set(s, (sizeHist.get(s) ?? 0) + 1);
const histRows = [...sizeHist.entries()].sort((a, b) => a[0] - b[0]);

const sumSizes = sortedNonEmpty.reduce((acc, b) => acc + b.count, 0);
const expectedUniformOverNonEmpty = sumSizes / nonEmptyCount;
// Uniform over all 243; empty pick wipes the candidate set (game over).
const expectedUniformOverAll243Wipe = sumSizes / 243;
// Uniform over all 243; empty pick is a no-op (candidate set unchanged).
const expectedUniformOverAll243Noop = (sumSizes + emptyCount * total) / 243;
const expectedWeighted =
  sortedNonEmpty.reduce((acc, b) => acc + (b.count * b.count) / total, 0);
const contractWeights = sortedNonEmpty.map((b) => Math.floor(b.count ** 0.8));
const contractWeightTotal = contractWeights.reduce((acc, w) => acc + w, 0);
const expectedContractWeighted =
  sortedNonEmpty.reduce((acc, b, i) => acc + b.count * contractWeights[i] / contractWeightTotal, 0);

// Probability that a uniform-over-243 pick hits a non-empty bucket.
const pNonEmpty = nonEmptyCount / 243;
const pEmpty = emptyCount / 243;
// Expected probability of all 6 guesses hitting non-empty buckets (given
// stationary distribution, which is a rough upper bound; actual game has
// fewer candidates after early narrows so empty share grows over time).
const pAllSixHitNonEmpty = pNonEmpty ** 6;

const cumulativeBySize = (cap) =>
  sortedNonEmpty.filter((b) => b.count <= cap).length;
const probSize = (cap) =>
  cumulativeBySize(cap) / nonEmptyCount;
const probSizeOver243 = (cap) =>
  cumulativeBySize(cap) / 243;

console.log(`opener:           ${opener}`);
console.log(`candidate pool:   ${poolName} (${total} words from ${poolFile})`);
console.log(`pattern slots:    243 total = ${nonEmptyCount} non-empty + ${emptyCount} empty`);
console.log("");
console.log("bucket size stats (non-empty only):");
console.log(`  min / p25 / p50 / p75 / max = ${sizes[0]} / ${pct(sizes, 25)} / ${pct(sizes, 50)} / ${pct(sizes, 75)} / ${sizes.at(-1)}`);
console.log("");
console.log("expected survivors after one guess:");
console.log(`  uniform over non-empty (current rule):     ${expectedUniformOverNonEmpty.toFixed(2)}`);
console.log(`  size^0.8-weighted (contract rule):         ${expectedContractWeighted.toFixed(2)}`);
console.log(`  uniform over 243, empty = wipe (game lost): ${expectedUniformOverAll243Wipe.toFixed(2)}`);
console.log(`  uniform over 243, empty = no-op (no narrow):${expectedUniformOverAll243Noop.toFixed(2)}`);
console.log(`  weighted by candidate count:                ${expectedWeighted.toFixed(2)}`);
console.log("");
console.log("uniform-over-243 selection mix:");
console.log(`  P(pick hits non-empty bucket):             ${(pNonEmpty * 100).toFixed(1)}%`);
console.log(`  P(pick hits empty bucket):                 ${(pEmpty * 100).toFixed(1)}%`);
console.log(`  P(all 6 turns hit non-empty, this opener): ${(pAllSixHitNonEmpty * 100).toFixed(2)}%`);
console.log("");
console.log("singleton risk:");
console.log(`  P(size = 1 | uniform non-empty):    ${(cumulativeBySize(1) / nonEmptyCount * 100).toFixed(1)}%`);
console.log(`  P(size = 1 | size^0.8):             ${(sortedNonEmpty.reduce((acc, b, i) => acc + (b.count === 1 ? contractWeights[i] : 0), 0) / contractWeightTotal * 100).toFixed(1)}%`);
console.log(`  P(size = 1 | uniform over 243):     ${(cumulativeBySize(1) / 243 * 100).toFixed(1)}%`);
console.log(`  P(size <= 5 | uniform non-empty):   ${(probSize(5) * 100).toFixed(1)}%`);
console.log(`  P(size <= 5 | size^0.8):            ${(sortedNonEmpty.reduce((acc, b, i) => acc + (b.count <= 5 ? contractWeights[i] : 0), 0) / contractWeightTotal * 100).toFixed(1)}%`);
console.log(`  P(size <= 5 | uniform over 243):    ${(probSizeOver243(5) * 100).toFixed(1)}%`);
console.log("");

console.log("bucket size histogram (size -> how many patterns have that size):");
let cumPatterns = 0;
let cumCandidates = 0;
console.log(`  size  | patterns | cum_patterns | cum_candidates`);
for (const [size, n] of histRows) {
  cumPatterns += n;
  cumCandidates += size * n;
  console.log(`  ${String(size).padStart(4)} | ${String(n).padStart(8)} | ${String(cumPatterns).padStart(12)} | ${String(cumCandidates).padStart(14)}`);
}
console.log(`  empty | ${String(emptyCount).padStart(8)} |             - |              -`);
console.log("");

console.log("top 15 largest buckets (.=grey y=yellow G=green):");
console.log(`  rank | code | pattern | size`);
for (let i = 0; i < Math.min(15, sortedNonEmpty.length); i++) {
  const { code, count } = sortedNonEmpty[i];
  console.log(`  ${String(i + 1).padStart(4)} | ${String(code).padStart(4)} | ${patternToString(code)}   | ${String(count).padStart(4)}`);
}

if (flags.has("--full")) {
  console.log("");
  console.log("all 243 patterns (sorted by code):");
  console.log(`  code | pattern | size`);
  for (let code = 0; code < 243; code++) {
    console.log(`  ${String(code).padStart(4)} | ${patternToString(code)}   | ${String(counts[code]).padStart(4)}`);
  }
}
