// React app shell — Cartridge Controller connect + Zordle game flow.
//
// Phase machine:
//   loading    — still hydrating dictionary / restoring active run
//   splash     — connect wallet OR start game
//   playing    — typing + submitting guesses
//   ending     — final reveal + share + play again

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
} from "@starknet-react/core";
import { num } from "starknet";

import { decodePattern, type Trit } from "./chain/state";
import { getCandidateChunk, getDictionary, getGame, getGuess } from "./chain/views";
import {
  mintGame,
  startGame,
  submitGuess,
} from "./chain/contractSystems";

// ---------- types ---------------------------------------------------------

type Phase = "loading" | "splash" | "playing" | "ending";

type PastGuess = {
  word: string;
  pattern: number;
};

type SavedRun = {
  tokenId: string;
  past: PastGuess[];
  active: string;
  remainingWords?: string[];
};

const RUN_KEY = "zordle:active-run:v2";
const CANDIDATE_CHUNKS = 10;
const MAX_GUESSES = 6;

const DEMO_WORDS = [
  "crane", "stark", "cairo", "prove",
  "block", "nonce", "chain", "trace",
];

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

// Pull the freshly-minted token_id out of the mint_game receipt. Denshokan
// is an ERC-721, so `mint` emits a Transfer(from=0, to=owner, token_id).
// We pick the LAST transfer matching to=our address.
const extractTokenIdFromReceipt = (
  receipt: any,
  ownerAddress: string,
): bigint | null => {
  const events: Array<{ keys?: string[]; data?: string[]; from_address?: string }> =
    receipt?.events ?? [];
  const ownerNorm = num.toBigInt(ownerAddress);
  // Transfer event selector = selector!("Transfer")
  // (0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9 is the
  // canonical OZ ERC721 Transfer key.)
  const TRANSFER_SELECTOR = num.toBigInt(
    "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9",
  );
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e.keys || e.keys.length < 4) continue;
    if (num.toBigInt(e.keys[0]) !== TRANSFER_SELECTOR) continue;
    const to = num.toBigInt(e.keys[2]);
    if (to !== ownerNorm) continue;
    // keys[3] = low(token_id), keys[4]? = high. ERC721 token_id is u256
    // packed as two felts.
    const low = num.toBigInt(e.keys[3]);
    const high = e.keys[4] ? num.toBigInt(e.keys[4]) : 0n;
    return low + (high << 128n);
  }
  return null;
};

// ---------- splash demo ---------------------------------------------------

function SplashDemo() {
  // CSS animation does most of the work; we just rotate the letter content
  // on each cell's animationiteration.
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
      <h1 className="wordmark">z<span className="accent">o</span>rdle</h1>
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
            x={0}
            y={0}
            width={100}
            height={100}
            pathLength={100}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="18 82"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </>
  );
}

// ---------- candidate strip ----------------------------------------------

function CandidateStrip({ remaining }: { remaining: string[] }) {
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
  const trackClass = count > 3 ? "candidate-track" : "candidate-track static";
  const duration = Math.round(((count * 80 + 320) / 80) * 1000);
  return (
    <section className="candidate-strip" aria-label="surviving candidate words">
      <div className="candidate-label">
        <span className="count">{count.toLocaleString()}</span> remaining
      </div>
      <div className="candidate-window">
        <div
          className={trackClass}
          style={{ ["--track-duration" as any]: `${duration}ms` }}
        >
          {remaining.map((w, i) => (
            <span key={i} className="candidate-word">{w}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

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
            <button
              className="key wide enter"
              onClick={() => onKey("ENTER")}
            >
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
        <button className="btn-primary" onClick={onPlayAgain}>Play again</button>
      </div>
    </div>
  );
}

// ---------- main app ------------------------------------------------------

export default function App() {
  // Cartridge Controller
  const { account, address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const handleConnect = useCallback(() => {
    const ctrl = connectors.find((c) => c.id === "controller") ?? connectors[0];
    if (ctrl) connect({ connector: ctrl });
  }, [connect, connectors]);

  // Bootstrap: dictionary load + restore active run
  const [phase, setPhase] = useState<Phase>("loading");
  const [words, setWords] = useState<string[]>([]);
  const [wordIndex, setWordIndex] = useState<Map<string, number>>(new Map());
  const [tokenId, setTokenId] = useState<bigint | null>(null);
  const [past, setPast] = useState<PastGuess[]>([]);
  const [active, setActive] = useState("");
  const [message, setMessage] = useState<React.ReactNode>("");
  const [won, setWon] = useState(false);
  const [finalWord, setFinalWord] = useState("");
  const [txPending, setTxPending] = useState(false);
  const [remainingWords, setRemainingWords] = useState<string[]>([]);
  const [flipRowIndex, setFlipRowIndex] = useState(-1);

  // ---- bootstrap (dict + restore) ----
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

        const dict = await getDictionary();
        if (cancelled) return;
        if (!dict.loaded) {
          setMessage("dictionary not loaded on-chain");
          return;
        }

        // Try restoring an active run
        const raw = localStorage.getItem(RUN_KEY);
        if (raw) {
          try {
            const saved = JSON.parse(raw) as SavedRun;
            const restoredId = BigInt(saved.tokenId);
            const game = await getGame(restoredId);
            if (game.startedAt !== 0n) {
              const pastGuesses: PastGuess[] = [];
              for (let i = 0; i < game.guessesUsed; i += 1) {
                const g = await getGuess(restoredId, i);
                pastGuesses.push({
                  word: list[g.wordId] ?? "?????",
                  pattern: g.pattern,
                });
              }
              if (cancelled) return;
              setTokenId(restoredId);
              setPast(pastGuesses);
              setActive(saved.active ?? "");
              setRemainingWords(saved.remainingWords ?? []);
              if (game.endedAt !== 0n) {
                setWon(game.won);
                setFinalWord(list[game.finalWordId] ?? "?????");
                setPhase("ending");
                localStorage.removeItem(RUN_KEY);
              } else {
                setPhase("playing");
              }
              return;
            }
            localStorage.removeItem(RUN_KEY);
          } catch {
            localStorage.removeItem(RUN_KEY);
          }
        }
        setPhase("splash");
      } catch (err) {
        if (!cancelled) {
          setMessage(`bootstrap failed: ${(err as Error).message}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist active run to localStorage on changes
  useEffect(() => {
    if (phase !== "playing" || tokenId === null) return;
    const saved: SavedRun = {
      tokenId: tokenId.toString(),
      past,
      active,
      remainingWords,
    };
    localStorage.setItem(RUN_KEY, JSON.stringify(saved));
  }, [phase, tokenId, past, active, remainingWords]);

  // Keyboard listener
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, txPending, active, past, tokenId]);

  const refreshRemainingWords = useCallback(
    async (id: bigint) => {
      const out: string[] = [];
      for (let chunk = 0; chunk < CANDIDATE_CHUNKS; chunk += 1) {
        let bits = await getCandidateChunk(id, chunk);
        let bit = 0;
        while (bits > 0n) {
          if ((bits & 1n) === 1n) {
            const wid = chunk * 256 + bit;
            const w = words[wid];
            if (w) out.push(w);
          }
          bits >>= 1n;
          bit += 1;
        }
      }
      setRemainingWords(out);
    },
    [words],
  );

  const handleStart = useCallback(async () => {
    if (!account || !address) return;
    setMessage(<>starting<span className="dots"></span></>);
    setTxPending(true);
    setPhase("playing");
    setPast([]);
    setActive("");
    setRemainingWords([]);
    setWon(false);
    setFinalWord("");
    try {
      // 1) Mint a Denshokan token
      const mintTx = await mintGame(account);
      const mintReceipt: any = await account.waitForTransaction(mintTx.transaction_hash);
      const newId = extractTokenIdFromReceipt(mintReceipt, address);
      if (newId === null) {
        throw new Error("could not extract token_id from mint_game receipt");
      }
      setTokenId(newId);
      // 2) Initialise the game
      const startTx = await startGame(account, newId);
      await account.waitForTransaction(startTx.transaction_hash);
      await refreshRemainingWords(newId);
      setMessage(<>guess <span className="accent">1</span> of 6</>);
    } catch (err) {
      setMessage(`error: ${(err as Error).message}`);
      setPhase("splash");
    } finally {
      setTxPending(false);
    }
  }, [account, address, refreshRemainingWords]);

  const handleSubmit = useCallback(async () => {
    if (!account || !tokenId || active.length !== 5) {
      setMessage("need 5 letters");
      return;
    }
    const wordId = wordIndex.get(active.toLowerCase());
    if (wordId === undefined) {
      setMessage(`"${active.toUpperCase()}" not in dictionary`);
      return;
    }
    const submitted = active;
    const guessesUsed = past.length;
    const next = guessesUsed + 1;
    setMessage(<>guess <span className="accent">{next}</span> of 6 · processing<span className="dots"></span></>);
    setTxPending(true);
    try {
      const tx = await submitGuess(account, tokenId, guessesUsed, wordId);
      await account.waitForTransaction(tx.transaction_hash);
      // Refetch the on-chain state for the just-submitted guess
      const g = await getGuess(tokenId, guessesUsed);
      const game = await getGame(tokenId);
      const newPast = [
        ...past,
        { word: submitted, pattern: g.pattern },
      ];
      setPast(newPast);
      setActive("");
      setFlipRowIndex(newPast.length - 1);
      setMessage(<>guess <span className="accent">{newPast.length}</span> of 6</>);
      if (game.endedAt !== 0n) {
        setWon(game.won);
        setFinalWord(words[game.finalWordId] ?? "?????");
        setPhase("ending");
        localStorage.removeItem(RUN_KEY);
      } else {
        await refreshRemainingWords(tokenId);
      }
    } catch (err) {
      setMessage(`error: ${(err as Error).message}`);
    } finally {
      setTxPending(false);
    }
  }, [account, tokenId, active, past, wordIndex, words, refreshRemainingWords]);

  function handleKey(key: string) {
    if (txPending) return;
    if (key === "ENTER") {
      void handleSubmit();
      return;
    }
    if (key === "BACK") {
      if (active.length > 0) setActive(active.slice(0, -1));
      return;
    }
    if (key.startsWith("letter:") && active.length < 5) {
      setActive(active + key.slice("letter:".length));
    }
  }

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
    const text = [`zordle ${score}`, rows, "verified · zkorp.xyz/zordle"].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage("copied result");
    } catch {
      setMessage("share failed");
    }
  }, [won, past]);

  const handlePlayAgain = useCallback(() => {
    setPhase("splash");
    setPast([]);
    setActive("");
    setTokenId(null);
    setRemainingWords([]);
    setWon(false);
    setFinalWord("");
    setMessage("");
  }, []);

  // ---- render ----------------------------------------------------------

  if (phase === "loading") {
    return (
      <>
        <Header />
        <p className="boot-loading">syncing chain</p>
      </>
    );
  }

  if (phase === "splash") {
    return (
      <>
        <Header />
        <section className="splash">
          <SplashDemo />
          {!isConnected ? (
            <button className="btn-primary" onClick={handleConnect}>
              Connect wallet
            </button>
          ) : (
            <>
              <button
                className="btn-primary"
                onClick={handleStart}
                disabled={txPending}
              >
                Start game
              </button>
              <p className="splash-meta">
                connected ·{" "}
                <span className="accent">
                  {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ""}
                </span>{" "}
                ·{" "}
                <button
                  className="link-like"
                  onClick={() => disconnect()}
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
            <strong>2,315</strong> words · <span className="accent">1</span> answer · zkorp
          </p>
        </section>
      </>
    );
  }

  if (phase === "playing") {
    return (
      <>
        <Header />
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

  // phase === "ending"
  const score = won ? `${past.length}/6` : "X/6";
  return (
    <>
      <Header />
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
