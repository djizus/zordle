// Receipt-first state extraction. Mirrors the zkube / death-mountain
// approach: every write returns a receipt, and we decode the Dojo
// StoreSetRecord events for our models out of receipt.events. No second
// view roundtrip and no Torii dependency.
//
// Two event shapes appear in the wild depending on Dojo version:
//   Format A (older): keys[0] = StoreSetRecord variant selector,
//                     keys[1] = model selector,
//                     data    = [numKeys, ...keys, numValues, ...values]
//   Format B (newer): keys[0] = StoreSetRecord variant selector,
//                     data    = [model_selector, numKeys, ...keys, numValues, ...values]
//
// We try A first, then B.

import { getSelectorFromTag } from "@dojoengine/utils";
import type { Game, Guess } from "./state";

const NAMESPACE = "zordle_0_1";

// Dojo's model selector is poseidon(bytearray_hash(namespace),
// bytearray_hash(name)) — not plain starknet_keccak. Use the canonical
// helper instead of rolling our own.
const SEL_GAME = BigInt(getSelectorFromTag(NAMESPACE, "Game"));
const SEL_GUESS = BigInt(getSelectorFromTag(NAMESPACE, "Guess"));

type RawEvent = {
  keys?: string[];
  data?: string[];
  from_address?: string;
};

function tryParse(felt: string | undefined): bigint | null {
  if (felt === undefined) return null;
  try {
    return BigInt(felt);
  } catch {
    return null;
  }
}

// Returns (modelSelector, payloadOffsetIntoData). null if this event isn't
// a StoreSetRecord for one of our tracked models.
function classify(e: RawEvent): { sel: bigint; offset: number } | null {
  // Format A — model selector at keys[1].
  const k1 = tryParse(e.keys?.[1]);
  if (k1 !== null && (k1 === SEL_GAME || k1 === SEL_GUESS)) {
    return { sel: k1, offset: 0 };
  }
  // Format B — model selector at data[0].
  const d0 = tryParse(e.data?.[0]);
  if (d0 !== null && (d0 === SEL_GAME || d0 === SEL_GUESS)) {
    return { sel: d0, offset: 1 };
  }
  return null;
}

export type ReceiptParsed = {
  game?: Game;
  guess?: Guess;
};

export function parseReceipt(receipt: any, gameId: bigint): ReceiptParsed {
  const events: RawEvent[] = receipt?.events ?? [];
  const out: ReceiptParsed = {};

  console.log(`[zordle/parse] selectors`, {
    game: "0x" + SEL_GAME.toString(16),
    guess: "0x" + SEL_GUESS.toString(16),
    eventCount: events.length,
  });

  let matched = 0;
  for (const event of events) {
    const cls = classify(event);
    if (!cls) continue;
    matched++;
    const data = event.data ?? [];
    if (data.length < cls.offset + 2) {
      console.warn(`[zordle/parse] short event`, { data });
      continue;
    }

    const numKeysIdx = cls.offset;
    const numKeys = Number(BigInt(data[numKeysIdx]));
    if (numKeys < 1 || numKeys > 4) continue;
    if (data.length < cls.offset + 1 + numKeys + 1) continue;

    const keyFelts = data.slice(numKeysIdx + 1, numKeysIdx + 1 + numKeys);
    const numValuesIdx = numKeysIdx + 1 + numKeys;
    const numValues = Number(BigInt(data[numValuesIdx]));
    const valStart = numValuesIdx + 1;
    if (data.length < valStart + numValues) continue;
    const valFelts = data.slice(valStart, valStart + numValues);

    const eventGameId = BigInt(keyFelts[0]);
    if (eventGameId !== gameId) {
      // Log but don't drop — a tx only ever writes events for one game,
      // so a "mismatch" here means JS-side gameId got out of sync (e.g.
      // calldata.compile reduced the felt mod p) and we still want the data.
      console.warn(`[zordle/parse] gameId differs from expected`, {
        model: cls.sel === SEL_GAME ? "Game" : "Guess",
        eventGameId: "0x" + eventGameId.toString(16),
        expectedGameId: "0x" + gameId.toString(16),
      });
    }

    if (cls.sel === SEL_GAME && numKeys === 1 && numValues >= 7) {
      // Game value layout (Cairo struct order, after the keyed `id`):
      //   player, started_at, ended_at, guesses_used, seed, won, final_word_id
      out.game = {
        id: BigInt(keyFelts[0]),
        player: BigInt(valFelts[0]),
        startedAt: BigInt(valFelts[1]),
        endedAt: BigInt(valFelts[2]),
        guessesUsed: Number(BigInt(valFelts[3])),
        seed: BigInt(valFelts[4]),
        won: BigInt(valFelts[5]) !== 0n,
        finalWordId: Number(BigInt(valFelts[6])),
      };
    } else if (cls.sel === SEL_GUESS && numKeys === 2 && numValues >= 3) {
      // Guess value layout (after keyed game_id, index):
      //   word_id, pattern, candidates_remaining
      out.guess = {
        gameId: BigInt(keyFelts[0]),
        index: Number(BigInt(keyFelts[1])),
        wordId: Number(BigInt(valFelts[0])),
        pattern: Number(BigInt(valFelts[1])),
        candidatesRemaining: Number(BigInt(valFelts[2])),
      };
    }
  }

  console.log(`[zordle/parse] matched ${matched} of ${events.length} events`, {
    gotGame: !!out.game,
    gotGuess: !!out.guess,
  });
  return out;
}
