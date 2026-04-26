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

function renderHeader(): string {
  return `
    <header class="site-header">
      <div class="cube-mark" aria-hidden="true"></div>
      <h1 class="wordmark">z<span class="accent">o</span>rdle</h1>
      <p class="brandline">zkorp<span class="dot">·</span>onchain</p>
    </header>
  `;
}

function renderRemainingCarousel(): string {
  if (state.phase !== "playing" || state.remainingWords.length === 0) {
    return "";
  }

  const words = state.remainingWords
    .map((word) => `<span class="candidate-word">${word}</span>`)
    .join("");
  const trackClass = state.remainingWords.length > 3
    ? "candidate-track"
    : "candidate-track static";
  const trackWords = state.remainingWords.length > 3 ? `${words}${words}` : words;
  return `
    <section class="candidate-strip" aria-label="remaining candidate words">
      <div class="candidate-label"><span class="count">${state.remainingWords.length}</span> remaining</div>
      <div class="candidate-window">
        <div class="${trackClass}">${trackWords}</div>
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
    state.message = game.won ? "proof accepted" : "game over";
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
    console.warn("[zordle/ui] failed to refresh remaining words", err);
  }
  return true;
}

function render() {
  switch (state.phase) {
    case "loading":
      root.innerHTML = `${renderHeader()}<p class="loading">syncing chain</p>`;
      return;
    case "splash":
      root.innerHTML = `
        ${renderHeader()}
        <section class="splash">
          <p class="splash-tagline">A <em>lazy</em> adversary picks the worst feedback you can prove. Six guesses. Onchain.</p>
          <button id="start" class="btn-primary">Start game</button>
          <p class="splash-meta"><strong>${state.words.length.toLocaleString()}</strong> words · 2,315 answers · Dojo + Starknet</p>
        </section>
      `;
      document
        .getElementById("start")!
        .addEventListener("click", onStart);
      return;
    case "playing":
      root.innerHTML = `
        ${renderHeader()}
        ${renderBoard(state.past, state.active, state.message, flipOnce)}
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
        ${renderBoard(state.past, "", `score · <span class="accent">${score}</span>`, flipOnce)}
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
      render();
    }
    return;
  }
  if (key.startsWith("letter:") && state.active.length < 5) {
    state.active += key.slice("letter:".length);
    saveRun();
    render();
  }
}

async function onStart() {
  if (await restoreRunAndRefresh()) {
    return;
  }

  state.gameId = randomFelt();
  state.past = [];
  state.active = "";
  state.message = "Starting…";
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
  state.message = "Submitting…";
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
    state.message = `guess <span class="accent">${state.past.length}</span> of 6 · proof accepted`;
    state.txPending = false;
    if (game.endedAt !== 0n) {
      state.won = game.won;
      state.finalWord = state.words[game.finalWordId] ?? "?????";
      state.message = game.won ? "proof accepted" : "game over";
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
