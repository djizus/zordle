// Build the answer-candidate pool while keeping the full merged dictionary
// available for guess validation.
//
// The curation is intentionally deterministic and local:
//   - all current official answers are kept;
//   - optional extras are ranked by similarity to the official answer list;
//   - obvious low-quality inflections and rare-letter/weird-shape words are
//     penalized or excluded.
//
// Env:
//   OFFICIAL_ANSWER_FILE  default scripts/shuffled_real_wordles.txt
//   MERGED_WORD_FILE      default scripts/merged_valid_wordles.txt
//   OUT_FILE              default scripts/curated_answer_candidates.txt
//   TARGET_ANSWER_COUNT   default official answer count (2315)
//   MAX_ANSWER_COUNT      default TARGET_ANSWER_COUNT

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const OFFICIAL_ANSWER_FILE = process.env.OFFICIAL_ANSWER_FILE
  ?? resolve(here, "shuffled_real_wordles.txt");
const MERGED_WORD_FILE = process.env.MERGED_WORD_FILE
  ?? resolve(here, "merged_valid_wordles.txt");
const OUT_FILE = process.env.OUT_FILE
  ?? resolve(here, "curated_answer_candidates.txt");
const targetEnv = process.env.TARGET_ANSWER_COUNT;
const maxEnv = process.env.MAX_ANSWER_COUNT;

function readWords(path) {
  const seen = new Set();
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const word = line.trim().toLowerCase();
    if (!word || word.startsWith("#")) continue;
    if (!/^[a-z]{5}$/.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

function countBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

const officialAnswers = readWords(OFFICIAL_ANSWER_FILE);
const mergedWords = readWords(MERGED_WORD_FILE);
const officialSet = new Set(officialAnswers);
const mergedSet = new Set(mergedWords);
const TARGET_ANSWER_COUNT = Number(targetEnv ?? officialAnswers.length);
const MAX_ANSWER_COUNT = Number(maxEnv ?? TARGET_ANSWER_COUNT);

if (!Number.isInteger(TARGET_ANSWER_COUNT) || TARGET_ANSWER_COUNT <= 0) {
  throw new Error("TARGET_ANSWER_COUNT must be a positive integer");
}
if (!Number.isInteger(MAX_ANSWER_COUNT) || MAX_ANSWER_COUNT < TARGET_ANSWER_COUNT) {
  throw new Error("MAX_ANSWER_COUNT must be an integer >= TARGET_ANSWER_COUNT");
}

for (const word of officialAnswers) {
  if (!mergedSet.has(word)) {
    throw new Error(`official answer missing from merged dictionary: ${word}`);
  }
}

const letterFreq = countBy([...officialAnswers.join("")], (c) => c);
const positionFreq = [0, 1, 2, 3, 4].map((i) => countBy(officialAnswers, (w) => w[i]));
const bigramFreq = new Map();
const trigramFreq = new Map();

for (const word of officialAnswers) {
  for (let i = 0; i < 4; i += 1) {
    const key = word.slice(i, i + 2);
    bigramFreq.set(key, (bigramFreq.get(key) ?? 0) + 1);
  }
  for (let i = 0; i < 3; i += 1) {
    const key = word.slice(i, i + 3);
    trigramFreq.set(key, (trigramFreq.get(key) ?? 0) + 1);
  }
}

const rareLetters = new Set(["j", "q", "x", "z"]);
const lowQualitySuffixes = [
  "eth", "est", "ism", "ist", "ium", "ius", "ae", "ii", "um", "us",
  "ix", "ax", "ex", "qi", "za",
];
const lowQualityPrefixes = ["aa", "ae", "oe"];

function isExcludedExtra(word) {
  if (officialSet.has(word)) return false;
  // The merged list is five-letter-only, so stem lookups such as "bakes" ->
  // "bake" are not available here. For non-official extras, exclude these
  // inflection-shaped endings directly; official answers are always retained.
  if (word.endsWith("s")) return true;
  if (word.endsWith("ed")) return true;
  if (word.endsWith("er")) return true;
  if (word.endsWith("ly")) return true;
  if ([...word].filter((c) => rareLetters.has(c)).length >= 2) return true;
  return false;
}

function scoreExtra(word) {
  let score = 0;
  const uniqueLetters = new Set(word);
  const vowelCount = [...word].filter((c) => "aeiou".includes(c)).length;

  for (const c of uniqueLetters) score += (letterFreq.get(c) ?? 0) / 40;
  for (let i = 0; i < 5; i += 1) score += (positionFreq[i].get(word[i]) ?? 0) / 10;
  for (let i = 0; i < 4; i += 1) score += (bigramFreq.get(word.slice(i, i + 2)) ?? 0) / 8;
  for (let i = 0; i < 3; i += 1) score += (trigramFreq.get(word.slice(i, i + 3)) ?? 0) / 6;

  score -= Math.abs(vowelCount - 2) * 35;
  if (vowelCount === 0) score -= 200;
  score -= [...word].filter((c) => rareLetters.has(c)).length * 45;
  if (uniqueLetters.size <= 3) score -= 45;
  if (lowQualityPrefixes.some((prefix) => word.startsWith(prefix))) score -= 100;
  if (lowQualitySuffixes.some((suffix) => word.endsWith(suffix))) score -= 80;

  return score;
}

const extras = mergedWords
  .filter((word) => !officialSet.has(word))
  .filter((word) => !isExcludedExtra(word))
  .map((word) => ({ word, score: scoreExtra(word) }))
  .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));

const target = Math.min(MAX_ANSWER_COUNT, TARGET_ANSWER_COUNT);
if (officialAnswers.length > target) {
  throw new Error(
    `official answer count ${officialAnswers.length} exceeds target ${target}`,
  );
}
if (officialAnswers.length + extras.length < target) {
  throw new Error(
    `not enough candidate extras: have ${officialAnswers.length + extras.length}, need ${target}`,
  );
}

const selectedExtras = extras.slice(0, target - officialAnswers.length).map((entry) => entry.word);
const curated = [...officialAnswers, ...selectedExtras];

writeFileSync(
  OUT_FILE,
  [
    "# Curated Zordle answer candidates.",
    "# Generated by scripts/curate_answers.mjs.",
    `# official_answers=${officialAnswers.length}`,
    `# selected_extras=${selectedExtras.length}`,
    `# total=${curated.length}`,
    ...curated,
    "",
  ].join("\n"),
);

console.log(`official answers : ${officialAnswers.length}`);
console.log(`eligible extras   : ${extras.length}`);
console.log(`selected extras   : ${selectedExtras.length}`);
console.log(`total answers     : ${curated.length}`);
console.log(`wrote             : ${OUT_FILE}`);
