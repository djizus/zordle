import {
  getDictionary,
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
};

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
};

const root = document.getElementById("app")!;

function render() {
  switch (state.phase) {
    case "loading":
      root.innerHTML = `<h1>ZORDLE</h1><p>loading…</p>`;
      return;
    case "splash":
      root.innerHTML = `
        <h1>ZORDLE</h1>
        <p class="subtitle">Lazy adversarial Wordle on Dojo. ${state.words.length} words.</p>
        <button id="start">Start game</button>
      `;
      document
        .getElementById("start")!
        .addEventListener("click", onStart);
      return;
    case "playing":
      root.innerHTML = `
        <h1>ZORDLE</h1>
        ${renderBoard(state.past, state.active, state.message)}
        ${renderKeyboard(state.past)}
      `;
      bindKeyboard();
      return;
    case "ending":
      root.innerHTML = `
        <h1>ZORDLE</h1>
        ${renderBoard(state.past, "", state.message)}
        ${renderEnd(state.won, state.finalWord)}
      `;
      document
        .getElementById("play-again")!
        .addEventListener("click", onStart);
      return;
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
  if (key === "ENTER") {
    void onSubmit();
    return;
  }
  if (key === "BACK") {
    if (state.active.length > 0) {
      state.active = state.active.slice(0, -1);
      render();
    }
    return;
  }
  if (key.startsWith("letter:") && state.active.length < 5) {
    state.active += key.slice("letter:".length);
    render();
  }
}

async function onStart() {
  state.gameId = randomFelt();
  state.past = [];
  state.active = "";
  state.message = "Starting…";
  state.phase = "playing";
  state.won = false;
  state.finalWord = "";
  render();
  try {
    await startGame(state.gameId);
    state.message = `${state.words.length} words remaining`;
    render();
  } catch (err) {
    state.message = `Error: ${(err as Error).message}`;
    render();
  }
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
  state.active = "";
  state.message = "Submitting…";
  render();
  try {
    console.log(`[zordle/ui] submitGuess`, { wordId, word: submitted });
    const parsed = await submitGuess(state.gameId!, wordId);
    console.log(`[zordle/ui] back from submitGuess`, parsed);
    const { game, guess } = parsed;
    if (!guess || !game) {
      state.message = `Receipt parse failed (game=${!!game}, guess=${!!guess}); see console`;
      render();
      return;
    }
    state.past.push({ word: submitted, pattern: guess.pattern });
    state.message = `${guess.candidatesRemaining} words remaining`;
    if (game.endedAt !== 0n) {
      state.won = game.won;
      state.finalWord = state.words[game.finalWordId] ?? "?????";
      state.phase = "ending";
    }
    render();
  } catch (err) {
    console.error(`[zordle/ui] onSubmit error`, err);
    state.message = `Error: ${(err as Error).message}`;
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
      root.innerHTML = `<h1>ZORDLE</h1><p>Dictionary not loaded on-chain. Run scripts/load_dictionary.mjs.</p>`;
      return;
    }
    if (dict.wordCount !== state.words.length) {
      console.warn(
        `On-chain word count (${dict.wordCount}) != local words.txt (${state.words.length}).`,
      );
    }
    state.phase = "splash";
    render();
  } catch (err) {
    root.innerHTML = `<h1>ZORDLE</h1><p>Failed to reach contract: ${(err as Error).message}</p>`;
  }
}

bootstrap();
