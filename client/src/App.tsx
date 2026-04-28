// React app shell — Cartridge Controller connect + dual-mode Zordle.
//
// Modes:
//   practice : loginless play on a slot, no EGC token. Unfinished runs
//              resume; finished runs can be replaced with a fresh run.
//   nft   : Denshokan token-bound game, replayable per-token. salt
//           derived from poseidon(token_id, turn, word). Shareable via
//           a /nft/<id> deep link.
//
// Routes:
//   /             splash — connect + pick a mode
//   /play         loginless practice for the current browser account
//   /play/<id>    NFT game for the given token_id (hex felt)
//
// Phase machine within a route:
//   loading | playing | ending

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useDisconnect,
} from "@starknet-react/core";
import { num, type AccountInterface } from "starknet";

import { decodePattern, type Trit } from "./chain/state";
import {
  getActiveGameId,
  getDictionary,
  getGame,
  getGuess,
} from "./chain/views";
import { filterVocabByFeedback } from "./wordle";
import {
  startPractice,
  startNftGame,
  submitGuess,
} from "./chain/contractSystems";
import { useGameAccount } from "./gameAccount";
import { networkForMode, type ZordleNetwork } from "./networkConfig";

// ---------- types ---------------------------------------------------------

type Route =
  | { kind: "splash" }
  | { kind: "play"; mode: "practice" }
  | { kind: "play"; mode: "nft"; tokenId: bigint };

type Phase = "loading" | "playing" | "ending";

type PastGuess = {
  word: string;
  pattern: number;
};

type Toast = {
  id: number;
  message: string;
  kind: "error" | "info";
};

const MAX_GUESSES = 6;
const DEFAULT_WORD_COUNT = 14855;

const DEMO_WORDS = [
  "crane", "stark", "prove", "block", "chain",
  "trace", "valid", "token", "crypt", "forge",
];

// ---------- routing -------------------------------------------------------

const parseRoute = (pathname: string): Route => {
  // Strip trailing slash.
  const path = pathname.replace(/\/$/, "");
  if (path === "" || path === "/") return { kind: "splash" };
  if (path === "/play") return { kind: "play", mode: "practice" };
  const m = path.match(/^\/play\/(0x[0-9a-fA-F]+|[0-9]+)$/);
  if (m) {
    try {
      return { kind: "play", mode: "nft", tokenId: BigInt(m[1]) };
    } catch {
      return { kind: "splash" };
    }
  }
  return { kind: "splash" };
};

const routeToPath = (r: Route): string => {
  if (r.kind === "splash") return "/";
  if (r.mode === "practice") return "/play";
  return `/play/${num.toHex(r.tokenId)}`;
};

// ---------- helpers -------------------------------------------------------

const normalizeKey = (raw: string): string | null => {
  const lower = raw.toLowerCase();
  if (lower === "enter") return "ENTER";
  if (lower === "backspace" || lower === "back") return "BACK";
  if (lower.length === 1 && lower >= "a" && lower <= "z") return `letter:${lower}`;
  return null;
};

const letterStatus = (past: PastGuess[]): Map<string, Trit> => {
  const rank: Record<Trit, number> = { grey: 0, yellow: 1, green: 2 };
  const map = new Map<string, Trit>();
  for (const g of past) {
    const trits = decodePattern(g.pattern);
    for (let i = 0; i < 5; i += 1) {
      const letter = g.word[i].toLowerCase();
      const cur = map.get(letter);
      if (!cur || rank[trits[i]] > rank[cur]) {
        map.set(letter, trits[i]);
      }
    }
  }
  return map;
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const anyErr = err as any;
    return (
      anyErr.message ??
      anyErr.revert_reason ??
      anyErr.revertReason ??
      anyErr.execution_error ??
      JSON.stringify(err)
    );
  }
  return String(err);
};

const waitForSuccess = async (account: AccountInterface, transactionHash: string) => {
  const receipt = await account.waitForTransaction(transactionHash);
  const status = (receipt as any)?.execution_status ?? (receipt as any)?.executionStatus;
  if (status && status !== "SUCCEEDED") {
    console.error("transaction failed", { transactionHash, receipt });
    const reason =
      (receipt as any)?.revert_reason ??
      (receipt as any)?.revertReason ??
      (receipt as any)?.execution_error ??
      (receipt as any)?.finality_status ??
      status;
    throw new Error(`transaction ${status.toLowerCase()}: ${reason}`);
  }
  return receipt;
};

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`toast ${toast.kind}`}
          onClick={() => onDismiss(toast.id)}
          type="button"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}

// ---------- splash demo ---------------------------------------------------

function SplashDemo() {
  const cellsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = cellsRef.current;
    if (!root) return;
    const spans = Array.from(root.querySelectorAll("span"));
    if (spans.length !== 5) return;

    let demoIndex = 0;
    const writeWord = (word: string) => {
      for (let i = 0; i < 5; i += 1) spans[i].textContent = word[i] ?? "";
    };
    writeWord(DEMO_WORDS[demoIndex]);

    const handlers: Array<{ el: HTMLElement; fn: () => void }> = [];
    for (let i = 0; i < 5; i += 1) {
      const span = spans[i];
      const fn = () => {
        if (i === 0) demoIndex = (demoIndex + 1) % DEMO_WORDS.length;
        span.textContent = DEMO_WORDS[demoIndex][i] ?? "";
      };
      span.addEventListener("animationiteration", fn);
      handlers.push({ el: span, fn });
    }
    return () => {
      for (const { el, fn } of handlers) {
        el.removeEventListener("animationiteration", fn);
      }
    };
  }, []);

  return (
    <div className="demo" aria-hidden="true">
      <div className="demo-row" ref={cellsRef}>
        <div className="demo-cell" style={{ ["--i" as any]: 0 }}><span></span></div>
        <div className="demo-cell" style={{ ["--i" as any]: 1 }}><span></span></div>
        <div className="demo-cell" style={{ ["--i" as any]: 2 }}><span></span></div>
        <div className="demo-cell" style={{ ["--i" as any]: 3 }}><span></span></div>
        <div className="demo-cell" style={{ ["--i" as any]: 4 }}><span></span></div>
      </div>
    </div>
  );
}

// ---------- header --------------------------------------------------------

function Header() {
  return (
    <header className="site-header">
      <h1
        className="wordmark"
        role="link"
        tabIndex={0}
        onClick={() => navigate({ kind: "splash" })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate({ kind: "splash" });
          }
        }}
      >
        z<span className="accent">o</span>rdle
      </h1>
    </header>
  );
}

// ---------- board ---------------------------------------------------------

function Cell({ letter, trit, filled }: { letter: string; trit?: Trit; filled?: boolean }) {
  const cls = trit ? `cell ${trit}` : filled ? "cell filled" : "cell";
  return <div className={cls}>{letter}</div>;
}

function Row({
  letters,
  trits,
  fresh,
}: {
  letters: string[];
  trits?: Trit[];
  fresh?: boolean;
}) {
  return (
    <div className={fresh ? "row fresh" : "row"}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Cell
          key={i}
          letter={(letters[i] ?? "").toUpperCase()}
          trit={trits?.[i]}
          filled={!trits && !!letters[i]}
        />
      ))}
    </div>
  );
}

function Board({
  past,
  active,
  flipRowIndex,
  pending,
  status,
}: {
  past: PastGuess[];
  active: string;
  flipRowIndex: number;
  pending: boolean;
  status: React.ReactNode;
}) {
  const rows: React.ReactNode[] = [];
  for (let r = 0; r < MAX_GUESSES; r += 1) {
    if (r < past.length) {
      const g = past[r];
      rows.push(
        <Row
          key={`p-${r}`}
          letters={g.word.split("")}
          trits={decodePattern(g.pattern)}
          fresh={r === flipRowIndex}
        />,
      );
    } else if (r === past.length) {
      rows.push(<Row key="active" letters={active.split("")} />);
    } else {
      rows.push(<Row key={`e-${r}`} letters={[]} />);
    }
  }
  return (
    <>
      <div className="status">{status}</div>
      <div className={pending ? "board-wrap loading" : "board-wrap"}>
        <div className="board">{rows}</div>
        <svg
          className="board-loader"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect
            x="3"
            y="3"
            width="94"
            height="94"
            rx="4"
            ry="4"
            pathLength="100"
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="butt"
            strokeLinejoin="round"
            strokeDasharray="18 82"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </>
  );
}

function LoadingState({ message }: { message: React.ReactNode }) {
  return (
    <section className="loading-state" aria-live="polite">
      <div className="spinner" aria-hidden="true"></div>
      <p className="boot-loading">{message}</p>
    </section>
  );
}

// ---------- candidate strip ----------------------------------------------

// Cap the carousel at this many DOM nodes. The label still shows the full
// count, but rendering all 14,855 spans (the unfiltered vocab on turn 0)
// causes ~50ms input lag per keystroke from React reconciliation.
const STRIP_MAX_WORDS = 100;

const CandidateStrip = memo(function CandidateStrip({
  remaining,
}: {
  remaining: string[];
}) {
  const count = remaining.length;
  if (count === 0) {
    return (
      <section className="candidate-strip" aria-hidden="true">
        <div className="candidate-label"><span className="count">···</span> remaining</div>
        <div className="candidate-window">
          <div className="candidate-track static"></div>
        </div>
      </section>
    );
  }
  const displayed =
    count > STRIP_MAX_WORDS ? remaining.slice(0, STRIP_MAX_WORDS) : remaining;
  const trackClass = displayed.length > 3 ? "candidate-track" : "candidate-track static";
  const duration = Math.round(((displayed.length * 80 + 320) / 80) * 1000);
  return (
    <section className="candidate-strip" aria-label="valid guesses consistent with feedback">
      <div className="candidate-label">
        <span className="count">{count.toLocaleString()}</span> remaining
      </div>
      <div className="candidate-window">
        <div
          className={trackClass}
          style={{ ["--track-duration" as any]: `${duration}ms` }}
        >
          {displayed.map((w, i) => (
            <span key={i} className="candidate-word">{w}</span>
          ))}
        </div>
      </div>
    </section>
  );
});

// ---------- keyboard ------------------------------------------------------

const KB_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

function Keyboard({
  past,
  onKey,
}: {
  past: PastGuess[];
  onKey: (k: string) => void;
}) {
  const status = useMemo(() => letterStatus(past), [past]);
  return (
    <div className="keyboard">
      {KB_ROWS.map((row, r) => (
        <div key={r} className="kb-row">
          {r === 2 && (
            <button className="key wide enter" onClick={() => onKey("ENTER")}>
              Enter
            </button>
          )}
          {Array.from(row).map((ch) => {
            const cls = status.get(ch) ?? "";
            return (
              <button
                key={ch}
                className={`key ${cls}`}
                onClick={() => onKey(`letter:${ch}`)}
              >
                {ch}
              </button>
            );
          })}
          {r === 2 && (
            <button
              className="key wide del"
              onClick={() => onKey("BACK")}
              aria-label="Delete"
            >
              ⌫
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- end screen ----------------------------------------------------

function EndScreen({
  won,
  finalWord,
  onPlayAgain,
  onShare,
}: {
  won: boolean;
  finalWord: string;
  onPlayAgain: () => void;
  onShare: () => void;
}) {
  return (
    <div className="end">
      <p className={`verdict ${won ? "win" : "lose"}`}>
        {won ? "You won" : "Game over"}
      </p>
      <div className={`reveal ${won ? "win" : "lose"}`}>{finalWord.toLowerCase()}</div>
      <div className="end-actions">
        <button className="btn-ghost" onClick={onShare}>Share</button>
        <button className="btn-primary play-again" onClick={onPlayAgain}>
          Play again
        </button>
      </div>
    </div>
  );
}

// ---------- main app ------------------------------------------------------

const navigate = (route: Route) => {
  const path = routeToPath(route);
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    // Trigger a popstate-like event so the app re-reads the route.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
};

export default function App() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((message: string, kind: Toast["kind"] = "error") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((items) => [...items.slice(-2), { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  // Route from URL.
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const handler = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Boot state.
  const [bootPhase, setBootPhase] = useState<"loading" | "ready">("loading");
  const [words, setWords] = useState<string[]>([]);
  const [wordIndex, setWordIndex] = useState<Map<string, number>>(new Map());
  const [wordCount, setWordCount] = useState(DEFAULT_WORD_COUNT);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/words.txt");
        const text = await res.text();
        const list = text
          .split("\n")
          .map((w) => w.trim().toLowerCase())
          .filter((w) => /^[a-z]{5}$/.test(w));
        if (cancelled) return;
        setWords(list);
        setWordIndex(new Map(list.map((w, i) => [w, i])));
        try {
          const dict = await getDictionary(networkForMode("practice"));
          if (!cancelled && dict.wordCount > 0) setWordCount(dict.wordCount);
        } catch {
          // Keep the bundled dictionary fallback for splash metadata.
        }
        setBootPhase("ready");
      } catch {
        // Stay on loading; user sees "loading".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (bootPhase === "loading") {
    return (
      <>
        <Header />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        <p className="boot-loading">loading</p>
      </>
    );
  }

  if (route.kind === "splash") {
    return (
      <Splash
        isConnected={!!isConnected}
        address={address}
        onDisconnect={() => disconnect()}
        toasts={toasts}
        onDismissToast={dismissToast}
        onPlayPractice={() => navigate({ kind: "play", mode: "practice" })}
        wordCount={wordCount}
      />
    );
  }

  // Play route.
  const playNetwork = networkForMode(route.mode);
  return (
    <Play
      key={
        route.mode === "nft"
          ? `nft-${playNetwork.chainId}-${playNetwork.actionsAddress}-${route.tokenId.toString()}`
          : `practice-${playNetwork.chainId}-${playNetwork.actionsAddress}`
      }
      route={route}
      network={playNetwork}
      words={words}
      wordIndex={wordIndex}
      onToast={pushToast}
      toasts={toasts}
      onDismissToast={dismissToast}
      onPlayAgain={() => navigate({ kind: "splash" })}
    />
  );
}

// ---------- splash --------------------------------------------------------

function Splash({
  isConnected,
  address,
  onDisconnect,
  toasts,
  onDismissToast,
  onPlayPractice,
  wordCount,
}: {
  isConnected: boolean;
  address?: string;
  onDisconnect: () => void;
  toasts: Toast[];
  onDismissToast: (id: number) => void;
  onPlayPractice: () => void;
  wordCount: number;
}) {
  return (
    <>
      <Header />
      <ToastStack toasts={toasts} onDismiss={onDismissToast} />
      <section className="splash">
        <SplashDemo />
        <div className="splash-actions">
          <button className="btn-primary" onClick={onPlayPractice}>
            Play
          </button>
          <a
            className="btn-ghost"
            href="https://beta.midgard.game/play"
            target="_blank"
            rel="noreferrer"
          >
            Midgard
          </a>
        </div>
        {isConnected && (
          <>
            <p className="splash-meta">
              connected ·{" "}
              <span className="accent">
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
              </span>{" "}
              ·{" "}
              <button
                onClick={onDisconnect}
                style={{
                  background: "none",
                  border: "none",
                  color: "inherit",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  letterSpacing: "inherit",
                }}
              >
                disconnect
              </button>
            </p>
          </>
        )}
        <p className="splash-meta">
          <strong>{wordCount.toLocaleString()}</strong> words · <span className="accent">1</span> answer · zkorp
        </p>
      </section>
    </>
  );
}

// ---------- play (game in progress) --------------------------------------

function Play({
  route,
  network,
  words,
  wordIndex,
  onToast,
  toasts,
  onDismissToast,
  onPlayAgain,
}: {
  route: { kind: "play"; mode: "practice" } | { kind: "play"; mode: "nft"; tokenId: bigint };
  network: ZordleNetwork;
  words: string[];
  wordIndex: Map<string, number>;
  onToast: (message: string, kind?: Toast["kind"]) => void;
  toasts: Toast[];
  onDismissToast: (id: number) => void;
  onPlayAgain: () => void;
}) {
  const { account, address, error, isConnected, isReady, isPending, login } = useGameAccount(
    route.mode,
    network,
  );
  const [phase, setPhase] = useState<Phase>("loading");
  const [gameId, setGameId] = useState<bigint | null>(null);
  const [past, setPast] = useState<PastGuess[]>([]);
  const [active, setActive] = useState("");
  const [message, setMessage] = useState<React.ReactNode>("");
  const [won, setWon] = useState(false);
  const [finalWord, setFinalWord] = useState("");
  const [txPending, setTxPending] = useState(false);
  const [flipRowIndex, setFlipRowIndex] = useState(-1);
  const [restartNonce, setRestartNonce] = useState(0);

  // Live narrowing of the full 14855-word guess vocab against past feedback.
  // We deliberately don't read the on-chain answer-pool candidate bitmap
  // here — that would tell the player exactly which 2315-pool words are
  // still possible, which is too much hand-holding. The strip below shows
  // "valid guesses consistent with your feedback" instead, computed locally.
  const remainingWords = useMemo(
    () => filterVocabByFeedback(words, past),
    [words, past],
  );

  const tokenId: bigint | null = route.mode === "nft" ? route.tokenId : null;

  // Resolve the on-chain game_id for this route + start it if needed.
  useEffect(() => {
    if (error) {
      onToast(error.message);
      setMessage("loading");
      setPhase("loading");
      return;
    }
    if (!isReady || !account || !address) {
      setMessage(route.mode === "practice" ? "loading" : "connect wallet to play");
      setPhase("loading");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let id: bigint;
        if (route.mode === "nft") {
          id = route.tokenId;
        } else {
          id = await getActiveGameId(network, address);
          if (id === 0n) {
            setMessage(<>starting<span className="dots"></span></>);
            setTxPending(true);
            const tx = await startPractice(network, account);
            await waitForSuccess(account, tx.transaction_hash);
            if (cancelled) return;
            id = await getActiveGameId(network, address);
            if (id === 0n) throw new Error("practice game did not start");
            setTxPending(false);
          }
        }
        if (cancelled) return;
        setGameId(id);

        // Fetch existing game state.
        const game = await getGame(network, id);
        if (cancelled) return;
        const dict = await getDictionary(network);
        if (cancelled) return;

        if (game.startedAt === 0n) {
          // Not started — kick off the start tx.
          setMessage(<>starting<span className="dots"></span></>);
          setTxPending(true);
          setPhase("playing");
          try {
            if (tokenId === null) throw new Error("missing NFT token id");
            const tx = await startNftGame(network, account, tokenId);
            await waitForSuccess(account, tx.transaction_hash);
            setMessage(<>guess <span className="accent">1</span> of 6</>);
          } catch (err) {
            console.error("start game failed", err);
            onToast(errorMessage(err));
          } finally {
            if (!cancelled) setTxPending(false);
          }
          return;
        }

        if (game.answerCount !== 0 && game.answerCount !== dict.answerCount) {
          setMessage("dictionary changed · start a fresh game");
          setPhase("loading");
          return;
        }

        // Already started — load past guesses.
        const pastGuesses: PastGuess[] = [];
        for (let i = 0; i < game.guessesUsed; i += 1) {
          const g = await getGuess(network, id, i);
          pastGuesses.push({
            word: words[g.wordId] ?? "?????",
            pattern: g.pattern,
          });
        }
        if (cancelled) return;
        setPast(pastGuesses);
        if (game.endedAt !== 0n) {
          setWon(game.won);
          setFinalWord(words[game.finalWordId] ?? "?????");
          setPhase("ending");
        } else {
          setMessage(<>guess <span className="accent">{game.guessesUsed + 1}</span> of 6</>);
          setPhase("playing");
        }
      } catch (err) {
        if (!cancelled) onToast(errorMessage(err));
      } finally {
        if (!cancelled) setTxPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isReady,
    address,
    route.mode,
    tokenId?.toString(),
    words.length,
    network.rpcUrl,
    network.actionsAddress,
    account,
    error,
    onToast,
    restartNonce,
  ]);

  const handleSubmit = useCallback(async () => {
    if (!account || !gameId || active.length !== 5) {
      if (active.length !== 5) onToast("need 5 letters", "info");
      return;
    }
    const wid = wordIndex.get(active.toLowerCase());
    if (wid === undefined) {
      onToast(`"${active.toUpperCase()}" not in dictionary`);
      return;
    }
    const submitted = active;
    const guessesUsed = past.length;
    setMessage(<>guess <span className="accent">{guessesUsed + 1}</span> of 6 · processing<span className="dots"></span></>);
    setTxPending(true);
    try {
      const tx = await submitGuess(network, account, gameId, tokenId, guessesUsed, wid);
      await waitForSuccess(account, tx.transaction_hash);
      const g = await getGuess(network, gameId, guessesUsed);
      if (g.gameId !== gameId || g.index !== guessesUsed || g.wordId !== wid) {
        throw new Error("guess transaction did not update game state");
      }
      const game = await getGame(network, gameId);
      const newPast = [...past, { word: submitted, pattern: g.pattern }];
      setPast(newPast);
      setActive("");
      setFlipRowIndex(newPast.length - 1);
      setMessage(<>guess <span className="accent">{newPast.length}</span> of 6</>);
      if (game.endedAt !== 0n) {
        setWon(game.won);
        setFinalWord(words[game.finalWordId] ?? "?????");
        setPhase("ending");
      }
    } catch (err) {
      console.error("submit guess failed", err);
      onToast(errorMessage(err));
    } finally {
      setTxPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, gameId, tokenId, active, past, wordIndex, words, network, onToast]);

  const handleKey = useCallback(
    (key: string) => {
      if (txPending) return;
      if (key === "ENTER") {
        void handleSubmit();
        return;
      }
      if (key === "BACK") {
        setActive((a) => a.slice(0, -1));
        return;
      }
      if (key.startsWith("letter:")) {
        setActive((a) => (a.length < 5 ? a + key.slice("letter:".length) : a));
      }
    },
    [txPending, handleSubmit],
  );

  useEffect(() => {
    if (phase !== "playing") return;
    const onKeyDown = (e: KeyboardEvent) => {
      const k = normalizeKey(e.key);
      if (k) {
        e.preventDefault();
        handleKey(k);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [phase, handleKey]);

  const handleShare = useCallback(async () => {
    const score = won ? `${past.length}/6` : "X/6";
    const rows = past
      .map((g) => {
        let p = g.pattern;
        let row = "";
        for (let i = 0; i < 5; i += 1) {
          const trit = p % 3;
          row += trit === 2 ? "🟩" : trit === 1 ? "🟧" : "⬜";
          p = Math.floor(p / 3);
        }
        return row;
      })
      .join("\n");
    const link =
      route.mode === "nft"
        ? `${window.location.origin}/play/${num.toHex(route.tokenId)}`
        : `${window.location.origin}/play`;
    const text = [`zordle ${score}`, rows, link].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onToast("copied result", "info");
    } catch {
      onToast("share failed");
    }
  }, [won, past, route, onToast]);

  const handlePlayAgain = useCallback(() => {
    if (route.mode === "nft") {
      onPlayAgain();
      return;
    }
    setPhase("loading");
    setGameId(null);
    setPast([]);
    setActive("");
    setMessage("loading");
    setWon(false);
    setFinalWord("");
    setTxPending(false);
    setFlipRowIndex(-1);
    setRestartNonce((n) => n + 1);
  }, [route.mode, onPlayAgain]);

  if (route.mode === "nft" && !isConnected) {
    return (
      <>
        <Header />
        <ToastStack toasts={toasts} onDismiss={onDismissToast} />
        <section className="splash">
          <p className="splash-meta">connect to continue</p>
          <button className="btn-primary" onClick={login}>
            Connect wallet
          </button>
        </section>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Header />
        <ToastStack toasts={toasts} onDismiss={onDismissToast} />
        <section className="splash">
          <p className="splash-meta">practice is unavailable</p>
        </section>
      </>
    );
  }

  if (phase === "loading" || isPending) {
    return (
      <>
        <Header />
        <ToastStack toasts={toasts} onDismiss={onDismissToast} />
        <LoadingState message={message} />
      </>
    );
  }

  if (phase === "playing") {
    return (
      <>
        <Header />
        <ToastStack toasts={toasts} onDismiss={onDismissToast} />
        <Board
          past={past}
          active={active}
          flipRowIndex={flipRowIndex}
          pending={txPending}
          status={message}
        />
        <CandidateStrip remaining={remainingWords} />
        <Keyboard past={past} onKey={handleKey} />
      </>
    );
  }

  // ending
  const score = won ? `${past.length}/6` : "X/6";
  return (
    <>
      <Header />
      <ToastStack toasts={toasts} onDismiss={onDismissToast} />
      <Board
        past={past}
        active=""
        flipRowIndex={flipRowIndex}
        pending={false}
        status={<>score · <span className="accent">{score}</span></>}
      />
      <EndScreen
        won={won}
        finalWord={finalWord}
        onPlayAgain={handlePlayAgain}
        onShare={handleShare}
      />
    </>
  );
}
