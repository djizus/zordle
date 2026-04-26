// Types mirroring on-chain models, plus felt-array decoders.

export type Game = {
  id: bigint;
  player: bigint;
  startedAt: bigint;
  endedAt: bigint;
  guessesUsed: number;
  seed: bigint;
  won: boolean;
  finalWordId: number;
};

export type Guess = {
  gameId: bigint;
  index: number;
  wordId: number;
  pattern: number;
  candidatesRemaining: number;
};

export type Dictionary = {
  id: number;
  wordCount: number;
  answerCount: number;
  loaded: boolean;
};

const big = (x: string): bigint => BigInt(x);
const num = (x: string): number => Number(BigInt(x));
const bool = (x: string): boolean => BigInt(x) !== 0n;

export function decodeGame(felts: string[]): Game {
  return {
    id: big(felts[0]),
    player: big(felts[1]),
    startedAt: big(felts[2]),
    endedAt: big(felts[3]),
    guessesUsed: num(felts[4]),
    seed: big(felts[5]),
    won: bool(felts[6]),
    finalWordId: num(felts[7]),
  };
}

export function decodeGuess(felts: string[]): Guess {
  return {
    gameId: big(felts[0]),
    index: num(felts[1]),
    wordId: num(felts[2]),
    pattern: num(felts[3]),
    candidatesRemaining: num(felts[4]),
  };
}

export function decodeDictionary(felts: string[]): Dictionary {
  return {
    id: num(felts[0]),
    wordCount: num(felts[1]),
    answerCount: num(felts[2]),
    loaded: bool(felts[3]),
  };
}

// Pattern is base-3 encoded with 5 trits (0=grey, 1=yellow, 2=green),
// position 0 is the least significant trit.
export type Trit = "grey" | "yellow" | "green";

export function decodePattern(pattern: number): Trit[] {
  const trits: Trit[] = [];
  let x = pattern;
  for (let i = 0; i < 5; i++) {
    const t = x % 3;
    trits.push(t === 0 ? "grey" : t === 1 ? "yellow" : "green");
    x = Math.floor(x / 3);
  }
  return trits;
}
