import { decodePattern, type Trit } from "../chain/state";

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

export type PastGuess = {
  word: string;
  pattern: number;
};

export function renderBoard(
  past: PastGuess[],
  active: string,
  message: string,
  flipRowIndex: number = -1,
  pending: boolean = false,
): string {
  const rows: string[] = [];
  for (let r = 0; r < MAX_GUESSES; r++) {
    if (r < past.length) {
      rows.push(filledRow(past[r], r === flipRowIndex));
    } else if (r === past.length) {
      rows.push(activeRow(active));
    } else {
      rows.push(emptyRow());
    }
  }
  // pathLength=100 normalises the rect's perimeter to 100 user units so
  // we can express the dasharray as percentages directly. The chasing
  // segment is 18% of the perimeter; animation is 2.4s linear infinite.
  const loader = `
    <svg class="board-loader" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <rect x="0" y="0" width="100" height="100" pathLength="100"
            fill="none"
            stroke="var(--accent)"
            stroke-width="2"
            stroke-linecap="round"
            stroke-dasharray="18 82"
            vector-effect="non-scaling-stroke" />
    </svg>
  `;
  return `
    <div class="status">${message}</div>
    <div class="board-wrap${pending ? " loading" : ""}">
      <div class="board">${rows.join("")}</div>
      ${loader}
    </div>
  `;
}

function filledRow(g: PastGuess, fresh: boolean): string {
  const trits = decodePattern(g.pattern);
  const cells = [];
  for (let i = 0; i < WORD_LENGTH; i++) {
    const letter = (g.word[i] ?? "").toUpperCase();
    cells.push(`<div class="cell ${trits[i]}">${letter}</div>`);
  }
  return `<div class="row${fresh ? " fresh" : ""}">${cells.join("")}</div>`;
}

function activeRow(text: string): string {
  const cells = [];
  for (let i = 0; i < WORD_LENGTH; i++) {
    const letter = (text[i] ?? "").toUpperCase();
    cells.push(
      `<div class="cell ${letter ? "filled" : ""}">${letter}</div>`,
    );
  }
  return `<div class="row">${cells.join("")}</div>`;
}

function emptyRow(): string {
  const cells = [];
  for (let i = 0; i < WORD_LENGTH; i++) {
    cells.push(`<div class="cell"></div>`);
  }
  return `<div class="row">${cells.join("")}</div>`;
}

// Per-letter best status across all past guesses, for keyboard coloring.
export function letterStatus(past: PastGuess[]): Map<string, Trit> {
  const rank: Record<Trit, number> = { grey: 0, yellow: 1, green: 2 };
  const map = new Map<string, Trit>();
  for (const g of past) {
    const trits = decodePattern(g.pattern);
    for (let i = 0; i < WORD_LENGTH; i++) {
      const letter = g.word[i].toLowerCase();
      const cur = map.get(letter);
      if (!cur || rank[trits[i]] > rank[cur]) {
        map.set(letter, trits[i]);
      }
    }
  }
  return map;
}
