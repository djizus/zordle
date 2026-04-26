import {
  getDictionary,
  getCandidateChunk,
  getGame,
  getGuess,
  randomFelt,
  startGame,
  submitGuess,
} from "./chain/client";
import { renderBoard, type PastGuess } from "./ui/board";
import { renderEnd } from "./ui/end";
import { normalizeKey, renderKeyboard } from "./ui/input";

type Phase = "loading" | "splash" | "playing" | "ending";

type AppState = {
  phase: Phase;
  words: string[]; // dictionary indexed by word_id
  wordIndex: Map<string, number>;
  gameId: bigint | null;
  past: PastGuess[];
  active: string;
  message: string;
  won: boolean;
  finalWord: string;
  txPending: boolean;
  remainingWords: string[];
};

type SavedRun = {
  gameId: string;
  past: PastGuess[];
  active: string;
  message: string;
  remainingWords?: string[];
};

const RUN_KEY = "zordle:active-run:v1";
const CANDIDATE_CHUNKS = 10;

// One-shot row index to flip with the reveal animation. -1 means "no row".
// Set when a guess is just confirmed, consumed by the next render call.
let flipOnce = -1;

// Five-letter words cycled by the splash demo, themed around the project's
// stack (zkorp / Starknet / Cairo / Wordle classics).
const DEMO_WORDS = [
  "crane", "stark", "cairo", "prove",
  "block", "nonce", "chain", "trace",
];
let demoIndex = 0;

const state: AppState = {
  phase: "loading",
  words: [],
  wordIndex: new Map(),
  gameId: null,
  past: [],
  active: "",
  message: "",
  won: false,
  finalWord: "",
  txPending: false,
  remainingWords: [],
};

const root = document.getElementById("app")!;

function saveRun() {
  if (state.phase !== "playing" || state.gameId === null) return;
  const saved: SavedRun = {
    gameId: state.gameId.toString(),
    past: state.past,
    active: state.active,
    message: state.message,
    remainingWords: state.remainingWords,
  };
  localStorage.setItem(RUN_KEY, JSON.stringify(saved));
}

function clearRun() {
  localStorage.removeItem(RUN_KEY);
}

function shareText(): string {
  const score = state.won ? `${state.past.length}/6` : "X/6";
  const rows = state.past
    .map((guess) => {
      let pattern = guess.pattern;
      let row = "";
      for (let i = 0; i < 5; i += 1) {
        const trit = pattern % 3;
        row += trit === 2 ? "🟩" : trit === 1 ? "🟧" : "⬜";
        pattern = Math.floor(pattern / 3);
      }
      return row;
    })
    .join("\n");

  return [`zordle ${score}`, rows, "verified · zkorp.xyz/zordle"].join("\n");
}

function restoreRun(): boolean {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as SavedRun;
    if (!saved.gameId || !Array.isArray(saved.past)) return false;

    state.gameId = BigInt(saved.gameId);
    state.past = saved.past;
    state.active = saved.active ?? "";
    state.message = saved.message || `guess <span class="accent">1</span> of 6`;
    state.phase = "playing";
    state.won = false;
    state.finalWord = "";
    state.txPending = false;
    state.remainingWords = saved.remainingWords ?? [];
    return true;
  } catch (err) {
    console.warn("[zordle/ui] failed to restore active run", err);
    clearRun();
    return false;
  }
}

// Listener cleanup for the splash demo. The interval-based approach drifted
// from the CSS animation; we now hook into cell 0's animationiteration
// event so the letter swap fires at the exact frame the cycle wraps —
// which (with the keyframes' all-empty tail) is the only moment every
// cell is reset to transparent. No more residual green on the next word.
let demoCleanup: (() => void) | null = null;

function startDemoCycle() {
  if (demoCleanup) return;
  const spans = document.querySelectorAll<HTMLElement>(".demo-cell span");
  if (spans.length !== 5) return;
  const writeWord = (word: string) => {
    for (let i = 0; i < 5; i++) spans[i].textContent = word[i] ?? "";
  };
  writeWord(DEMO_WORDS[demoIndex]);
  // Each cell swaps its OWN letter on its OWN cycle wrap. Cells are
  // animation-delayed (110ms × index), so cell 0 wraps first and bumps
  // demoIndex; cells 1–4 each wrap a stagger-step later and read that
  // new index, fetching the matching letter for their position. This
  // means at every individual cell's wrap, that cell is fully empty
  // and the new letter takes effect cleanly — no residual green from
  // the previous word leaking into the new typing pass.
  type Bound = { el: HTMLElement; fn: () => void };
  const bound: Bound[] = [];
  for (let i = 0; i < 5; i++) {
    const span = spans[i];
    const fn = () => {
      if (i === 0) demoIndex = (demoIndex + 1) % DEMO_WORDS.length;
      span.textContent = DEMO_WORDS[demoIndex][i] ?? "";
    };
    span.addEventListener("animationiteration", fn);
    bound.push({ el: span, fn });
  }
  demoCleanup = () => {
    for (const { el, fn } of bound) el.removeEventListener("animationiteration", fn);
  };
}

function stopDemoCycle() {
  if (demoCleanup) {
    demoCleanup();
    demoCleanup = null;
  }
}

function renderHeader(): string {
  return `
    <header class="site-header">
      <h1 class="wordmark">z<span class="accent">o</span>rdle</h1>
    </header>
  `;
}

function renderRemainingCarousel(): string {
  if (state.phase !== "playing") return "";

  // Surviving candidates (the contract bitmap), with a count label above
  // the scrolling track. Track duration scales with count so the visible
  // px/sec stays constant turn over turn (~400 px/s ≈ 5 words/sec).
  const remaining = state.remainingWords;
  const count = remaining.length;
  if (count === 0) {
    return `
      <section class="candidate-strip" aria-hidden="true">
        <div class="candidate-label"><span class="count">···</span> remaining</div>
        <div class="candidate-window">
          <div class="candidate-track static"></div>
        </div>
      </section>
    `;
  }

  const words = remaining
    .map((word) => `<span class="candidate-word">${word}</span>`)
    .join("");
  // Single copy of words, no duplication. Animation slides the track from
  // off-screen-right to off-screen-left (using container query units so
  // CSS knows the viewport width). At ~80 px/sec, with avg word ≈ 80 px
  // wide, this scrolls about one word per second regardless of count;
  // the loop reset happens off-screen so it's seamless.
  const trackClass = count > 3 ? "candidate-track" : "candidate-track static";
  const PX_PER_SEC = 80;
  const AVG_WORD_PX = 80;
  const VIEWPORT_PX = 320;
  const duration = Math.round(((count * AVG_WORD_PX + VIEWPORT_PX) / PX_PER_SEC) * 1000);
  return `
    <section class="candidate-strip" aria-label="surviving candidate words">
      <div class="candidate-label"><span class="count">${count.toLocaleString()}</span> remaining</div>
      <div class="candidate-window">
        <div class="${trackClass}" style="--track-duration:${duration}ms">${words}</div>
      </div>
    </section>
  `;
}

async function refreshRemainingWords() {
  if (state.gameId === null) return;

  const remaining: string[] = [];
  for (let chunkIndex = 0; chunkIndex < CANDIDATE_CHUNKS; chunkIndex += 1) {
    let bits = await getCandidateChunk(state.gameId, chunkIndex);
    let bit = 0;
    while (bits > 0n) {
      if ((bits & 1n) === 1n) {
        const wordId = chunkIndex * 256 + bit;
        const word = state.words[wordId];
        if (word) remaining.push(word);
      }
      bits >>= 1n;
      bit += 1;
    }
  }

  state.remainingWords = remaining;
  saveRun();
}

type SyncResult = "missing" | "playing" | "ended";

async function syncGameFromChain(): Promise<SyncResult> {
  if (state.gameId === null) return "missing";

  const game = await getGame(state.gameId);
  if (game.startedAt === 0n) {
    // Stale localStorage gameId — the world was migrated or the game id
    // never landed. Drop it so the caller can fall through to splash.
    clearRun();
    state.gameId = null;
    return "missing";
  }

  const past: PastGuess[] = [];
  for (let index = 0; index < game.guessesUsed; index += 1) {
    const guess = await getGuess(state.gameId, index);
    past.push({
      word: state.words[guess.wordId] ?? "?????",
      pattern: guess.pattern,
    });
  }

  state.past = past;
  state.active = "";
  state.txPending = false;

  if (game.endedAt !== 0n) {
    state.won = game.won;
    state.finalWord = state.words[game.finalWordId] ?? "?????";
    state.message = game.won ? "you won" : "game over";
    state.phase = "ending";
    state.remainingWords = [];
    clearRun();
    return "ended";
  }

  state.phase = "playing";
  return "playing";
}

async function restoreRunAndRefresh(): Promise<boolean> {
  if (!restoreRun()) return false;
  render();
  try {
    const result = await syncGameFromChain();
    if (result === "missing") return false;
    if (result === "ended") {
      render();
      return true;
    }
    await refreshRemainingWords();
    render();
  } catch (err) {
    console.warn("[zordle/ui] failed to sync game state", err);
  }
  return true;
}

function render() {
  // The splash demo uses a setInterval; tear it down on phase change.
  if (state.phase !== "splash") stopDemoCycle();
  switch (state.phase) {
    case "loading":
      root.innerHTML = `${renderHeader()}<p class="boot-loading">syncing chain</p>`;
      return;
    case "splash":
      root.innerHTML = `
        ${renderHeader()}
        <section class="splash">
          <div class="demo" aria-hidden="true">
            <div class="demo-row">
              <div class="demo-cell" style="--i:0"><span></span></div>
              <div class="demo-cell" style="--i:1"><span></span></div>
              <div class="demo-cell" style="--i:2"><span></span></div>
              <div class="demo-cell" style="--i:3"><span></span></div>
              <div class="demo-cell" style="--i:4"><span></span></div>
            </div>
          </div>
          <button id="start" class="btn-primary">Start game</button>
          <p class="splash-meta"><strong>2,315</strong> words · <span class="accent">1</span> answer · zkorp</p>
        </section>
      `;
      document
        .getElementById("start")!
        .addEventListener("click", onStart);
      startDemoCycle();
      return;
    case "playing":
      root.innerHTML = `
        ${renderHeader()}
        ${renderBoard(state.past, state.active, state.message, flipOnce, state.txPending)}
        ${renderRemainingCarousel()}
        ${renderKeyboard(state.past)}
      `;
      flipOnce = -1;
      bindKeyboard();
      return;
    case "ending": {
      const score = state.won ? `${state.past.length}/6` : "X/6";
      root.innerHTML = `
        ${renderHeader()}
        ${renderBoard(state.past, "", `score · <span class="accent">${score}</span>`, flipOnce, false)}
        ${renderEnd(state.won, state.finalWord)}
      `;
      flipOnce = -1;
      document
        .getElementById("play-again")!
        .addEventListener("click", onStart);
      document
        .getElementById("share-result")!
        .addEventListener("click", onShare);
      return;
    }
  }
}

function bindKeyboard() {
  document.querySelectorAll(".key").forEach((el) => {
    el.addEventListener("click", () => {
      const k = (el as HTMLElement).dataset.key!;
      handleKey(k);
    });
  });
}

document.addEventListener("keydown", (e) => {
  if (state.phase !== "playing") return;
  const k = normalizeKey(e.key);
  if (k) {
    e.preventDefault();
    handleKey(k);
  }
});

// Touch only the 5 cells of the active row. Avoids re-rendering the whole
// app (header + 6 rows + 1.2K-span carousel + 33-key keyboard) on every
// keystroke, which is what was causing the typing lag.
function updateActiveRow() {
  const rows = document.querySelectorAll<HTMLElement>(".board > .row");
  const row = rows[state.past.length];
  if (!row) return;
  const cells = row.children;
  for (let i = 0; i < 5; i++) {
    const cell = cells[i] as HTMLElement | undefined;
    if (!cell) continue;
    const letter = (state.active[i] ?? "").toUpperCase();
    if (cell.textContent !== letter) cell.textContent = letter;
    cell.classList.toggle("filled", letter.length > 0);
  }
}

function handleKey(key: string) {
  if (state.txPending) return;

  if (key === "ENTER") {
    void onSubmit();
    return;
  }
  if (key === "BACK") {
    if (state.active.length > 0) {
      state.active = state.active.slice(0, -1);
      saveRun();
      updateActiveRow();
    }
    return;
  }
  if (key.startsWith("letter:") && state.active.length < 5) {
    state.active += key.slice("letter:".length);
    saveRun();
    updateActiveRow();
  }
}

async function onStart() {
  if (await restoreRunAndRefresh()) {
    return;
  }

  state.gameId = randomFelt();
  state.past = [];
  state.active = "";
  state.message = `guess <span class="accent">1</span> of 6 · starting<span class="dots"></span>`;
  state.phase = "playing";
  state.won = false;
  state.finalWord = "";
  state.txPending = true;
  state.remainingWords = [];
  saveRun();
  render();
  try {
    await startGame(state.gameId);
    state.message = `guess <span class="accent">1</span> of 6`;
    await refreshRemainingWords();
  } catch (err) {
    state.message = `Error: ${(err as Error).message}`;
  } finally {
    state.txPending = false;
    saveRun();
    render();
  }
}

async function onShare() {
  try {
    await navigator.clipboard.writeText(shareText());
    state.message = "Copied result";
  } catch (err) {
    console.error("[zordle/ui] share failed", err);
    state.message = "Share failed";
  }
  render();
}

async function onSubmit() {
  console.log(`[zordle/ui] onSubmit`, { active: state.active, gameId: state.gameId?.toString(16) });
  if (state.active.length !== 5) {
    state.message = "Need 5 letters";
    render();
    return;
  }
  const wordId = state.wordIndex.get(state.active.toLowerCase());
  if (wordId === undefined) {
    state.message = `"${state.active.toUpperCase()}" not in dictionary`;
    render();
    return;
  }
  const submitted = state.active;
  // The "next" guess number = current past.length + 1. Persists through
  // the tx so the user keeps seeing what they're submitting + a live
  // animated dots indicator while the receipt is in flight.
  const nextGuess = state.past.length + 1;
  state.message = `guess <span class="accent">${nextGuess}</span> of 6 · processing<span class="dots"></span>`;
  state.txPending = true;
  saveRun();
  render();
  try {
    console.log(`[zordle/ui] submitGuess`, { wordId, word: submitted });
    const parsed = await submitGuess(state.gameId!, wordId);
    console.log(`[zordle/ui] back from submitGuess`, parsed);
    const { game, guess } = parsed;
    if (!guess || !game) {
      state.message = `Receipt parse failed (game=${!!game}, guess=${!!guess}); see console`;
      state.txPending = false;
      saveRun();
      render();
      return;
    }
    state.active = "";
    state.past.push({ word: submitted, pattern: guess.pattern });
    flipOnce = state.past.length - 1;
    state.message = `guess <span class="accent">${state.past.length}</span> of 6`;
    state.txPending = false;
    if (game.endedAt !== 0n) {
      state.won = game.won;
      state.finalWord = state.words[game.finalWordId] ?? "?????";
      state.message = game.won ? "you won" : "game over";
      state.phase = "ending";
      clearRun();
    } else {
      await refreshRemainingWords();
      saveRun();
    }
    render();
  } catch (err) {
    console.error(`[zordle/ui] onSubmit error`, err);
    try {
      const result = await syncGameFromChain();
      if (result === "ended" || result === "playing") {
        render();
        return;
      }
    } catch (syncErr) {
      console.warn("[zordle/ui] failed to recover game state", syncErr);
    }
    state.message = `Error: ${(err as Error).message}`;
    state.active = submitted;
    state.txPending = false;
    saveRun();
    render();
  }
}

async function bootstrap() {
  // Fetch words from /words.txt (served by dev_up.sh).
  try {
    const res = await fetch("/words.txt");
    const text = await res.text();
    const words = text
      .split("\n")
      .map((w) => w.trim().toLowerCase())
      .filter((w) => /^[a-z]{5}$/.test(w));
    state.words = words;
    state.wordIndex = new Map(words.map((w, i) => [w, i]));
  } catch (err) {
    console.error("Failed to load words.txt", err);
  }

  // Sanity check the on-chain dictionary matches.
  try {
    const dict = await getDictionary();
    if (!dict.loaded) {
      root.innerHTML = `${renderHeader()}<p>Dictionary not loaded on-chain. Run scripts/load_dictionary.mjs.</p>`;
      return;
    }
    if (dict.wordCount !== state.words.length) {
      console.warn(
        `On-chain word count (${dict.wordCount}) != local words.txt (${state.words.length}).`,
      );
    }
    if (!(await restoreRunAndRefresh())) {
      state.phase = "splash";
      render();
    }
  } catch (err) {
    root.innerHTML = `${renderHeader()}<p>Failed to reach contract: ${(err as Error).message}</p>`;
  }
}

bootstrap();
