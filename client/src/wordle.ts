// Wordle feedback computation, client-side mirror of
// contracts/src/helpers/wordle.cairo:compute_pattern.
//
// Pattern encoding: trit per position (0 = grey, 1 = yellow, 2 = green),
// packed as p0 + p1*3 + p2*9 + p3*27 + p4*81 (range 0..242).
// Two-pass to handle duplicate letters: greens consume target slots first,
// then yellows take the leftmost unused matching target slot.

export function computePattern(guess: string, target: string): number {
  const g = [
    guess.charCodeAt(0),
    guess.charCodeAt(1),
    guess.charCodeAt(2),
    guess.charCodeAt(3),
    guess.charCodeAt(4),
  ];
  const t = [
    target.charCodeAt(0),
    target.charCodeAt(1),
    target.charCodeAt(2),
    target.charCodeAt(3),
    target.charCodeAt(4),
  ];
  const p = [0, 0, 0, 0, 0];
  const used = [false, false, false, false, false];

  for (let i = 0; i < 5; i += 1) {
    if (g[i] === t[i]) {
      p[i] = 2;
      used[i] = true;
    }
  }

  for (let i = 0; i < 5; i += 1) {
    if (p[i] !== 0) continue;
    for (let j = 0; j < 5; j += 1) {
      if (!used[j] && g[i] === t[j]) {
        p[i] = 1;
        used[j] = true;
        break;
      }
    }
  }

  return p[0] + p[1] * 3 + p[2] * 9 + p[3] * 27 + p[4] * 81;
}

// Filter a vocabulary down to words that produce the same feedback pattern
// as every past (guess, pattern) record. Used by the play screen to derive
// the "valid guesses still consistent with feedback" view client-side
// against the full guess vocab (not the on-chain answer-pool narrowing).
export function filterVocabByFeedback(
  vocab: readonly string[],
  past: readonly { word: string; pattern: number }[],
): string[] {
  if (past.length === 0) return [...vocab];
  const out: string[] = [];
  for (const w of vocab) {
    let consistent = true;
    for (const g of past) {
      if (computePattern(g.word, w) !== g.pattern) {
        consistent = false;
        break;
      }
    }
    if (consistent) out.push(w);
  }
  return out;
}
