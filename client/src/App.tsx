// React app shell — Cartridge Controller connect + dual-mode Zordle.
//
// Modes:
//   daily : one game per account per day, no EGC token. salt derived
//           from poseidon(day, turn, word). All accounts on day X share
//           the same lazy-boss tree.
//   nft   : Denshokan token-bound game, replayable per-token. salt
//           derived from poseidon(token_id, turn, word). Shareable via
//           a /nft/<id> deep link.
//
// Routes:
//   /             splash — connect + pick a mode
//   /play         daily challenge for the connected account
//   /play/<id>    NFT game for the given token_id (hex felt)
//
// Phase machine within a route:
//   loading | playing | ending

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
} from "@starknet-react/core";
import { num } from "starknet";

import { decodePattern, type Trit } from "./chain/state";
import {
  getCandidateChunk,
  getDailyGameId,
  getDictionary,
  getGame,
  getGuess,
} from "./chain/views";
import {
  mintGame,
  startDaily,
  startNftGame,
  submitGuess,
} from "./chain/contractSystems";

// ---------- types ---------------------------------------------------------

type Route =
  | { kind: "splash" }
  | { kind: "play"; mode: "daily" }
  | { kind: "play"; mode: "nft"; tokenId: bigint };

type Phase = "loading" | "playing" | "ending";

type PastGuess = {
  word: string;
  pattern: number;
};

const CANDIDATE_CHUNKS = 10;
const MAX_GUESSES = 6;

const DEMO_WORDS = [
  "crane", "stark", "cairo", "prove",
  "block", "nonce", "chain", "trace",
];

// ---------- routing -------------------------------------------------------

const parseRoute = (pathname: string): Route => {
  // Strip trailing slash.
  const path = pathname.replace(/\/$/, "");
  if (path === "" || path === "/") return { kind: "splash" };
  if (path === "/play") return { kind: "play", mode: "daily" };
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
  if (r.mode === "daily") return "/play";
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

const TRANSFER_SELECTOR = num.toBigInt(
  "0x99cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9",
);

// Pull the freshly-minted token_id out of the mint_game receipt by finding
// the ERC721 Transfer(0x0, our address, token_id) event.
const extractTokenIdFromReceipt = (
  receipt: any,
  ownerAddress: string,
): bigint | null => {
  const events: Array<{ keys?: string[]; data?: string[] }> = receipt?.events ?? [];
  const ownerNorm = num.toBigInt(ownerAddress);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e.keys || e.keys.length < 4) continue;
    if (num.toBigInt(e.keys[0]) !== TRANSFER_SELECTOR) continue;
    const to = num.toBigInt(e.keys[2]);
    if (to !== ownerNorm) continue;
    const low = num.toBigInt(e.keys[3]);
    const high = e.keys[4] ? num.toBigInt(e.keys[4]) : 0n;
    return low + (high << 128n);
  }
  return null;
};

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
        <button className="btn-primary" onClick={onPlayAgain}>Play again</button>
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
  const { account, address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  const handleConnect = useCallback(() => {
    const ctrl = connectors.find((c) => c.id === "controller") ?? connectors[0];
    if (ctrl) connect({ connector: ctrl });
  }, [connect, connectors]);

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
        if (!dict.loaded) return;
        setBootPhase("ready");
      } catch {
        // Stay on loading; user sees "syncing chain".
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
        <p className="boot-loading">syncing chain</p>
      </>
    );
  }

  if (route.kind === "splash") {
    return (
      <Splash
        isConnected={!!isConnected}
        address={address}
        onConnect={handleConnect}
        onDisconnect={() => disconnect()}
        onPlayDaily={() => navigate({ kind: "play", mode: "daily" })}
        onMintNft={async () => {
          if (!account || !address) return;
          // Mint then navigate. The Play screen will pick up where we left.
          try {
            const tx = await mintGame(account);
            const r: any = await account.waitForTransaction(tx.transaction_hash);
            const newId = extractTokenIdFromReceipt(r, address);
            if (newId === null) throw new Error("token_id missing in mint receipt");
            navigate({ kind: "play", mode: "nft", tokenId: newId });
          } catch (err) {
            // Surface to console; splash stays put.
            console.error("[zordle] mint failed", err);
          }
        }}
      />
    );
  }

  // Play route.
  return (
    <Play
      key={route.mode === "nft" ? `nft-${route.tokenId.toString()}` : "daily"}
      route={route}
      account={account ?? null}
      address={address ?? null}
      isConnected={!!isConnected}
      onConnect={handleConnect}
      words={words}
      wordIndex={wordIndex}
      onPlayAgain={() => navigate({ kind: "splash" })}
    />
  );
}

// ---------- splash --------------------------------------------------------

function Splash({
  isConnected,
  address,
  onConnect,
  onDisconnect,
  onPlayDaily,
  onMintNft,
}: {
  isConnected: boolean;
  address?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onPlayDaily: () => void;
  onMintNft: () => void;
}) {
  const [minting, setMinting] = useState(false);
  return (
    <>
      <Header />
      <section className="splash">
        <SplashDemo />
        {!isConnected ? (
          <button className="btn-primary" onClick={onConnect}>
            Connect wallet
          </button>
        ) : (
          <>
            <button className="btn-primary" onClick={onPlayDaily} disabled={minting}>
              Daily challenge
            </button>
            <button
              className="btn-ghost"
              onClick={async () => {
                setMinting(true);
                try {
                  await onMintNft();
                } finally {
                  setMinting(false);
                }
              }}
              disabled={minting}
            >
              {minting ? "Minting…" : "Mint & play"}
            </button>
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
          <strong>2,315</strong> words · <span className="accent">1</span> answer · zkorp
        </p>
      </section>
    </>
  );
}

// ---------- play (game in progress) --------------------------------------

function Play({
  route,
  account,
  address,
  isConnected,
  onConnect,
  words,
  wordIndex,
  onPlayAgain,
}: {
  route: { kind: "play"; mode: "daily" } | { kind: "play"; mode: "nft"; tokenId: bigint };
  account: any | null;
  address: string | null;
  isConnected: boolean;
  onConnect: () => void;
  words: string[];
  wordIndex: Map<string, number>;
  onPlayAgain: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [gameId, setGameId] = useState<bigint | null>(null);
  const [past, setPast] = useState<PastGuess[]>([]);
  const [active, setActive] = useState("");
  const [message, setMessage] = useState<React.ReactNode>("");
  const [won, setWon] = useState(false);
  const [finalWord, setFinalWord] = useState("");
  const [txPending, setTxPending] = useState(false);
  const [remainingWords, setRemainingWords] = useState<string[]>([]);
  const [flipRowIndex, setFlipRowIndex] = useState(-1);

  const tokenId: bigint | null = route.mode === "nft" ? route.tokenId : null;

  // Resolve the on-chain game_id for this route + start it if needed.
  useEffect(() => {
    if (!isConnected || !account || !address) {
      setMessage("connect wallet to play");
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
          id = await getDailyGameId(address);
        }
        if (cancelled) return;
        setGameId(id);

        // Fetch existing game state.
        const game = await getGame(id);
        if (cancelled) return;

        if (game.startedAt === 0n) {
          // Not started — kick off the start tx.
          setMessage(<>starting<span className="dots"></span></>);
          setTxPending(true);
          setPhase("playing");
          try {
            const tx =
              route.mode === "nft"
                ? await startNftGame(account, route.tokenId)
                : await startDaily(account);
            await account.waitForTransaction(tx.transaction_hash);
            await refresh(id);
            setMessage(<>guess <span className="accent">1</span> of 6</>);
          } catch (err) {
            setMessage(`error: ${(err as Error).message}`);
          } finally {
            if (!cancelled) setTxPending(false);
          }
          return;
        }

        // Already started — load past guesses.
        const pastGuesses: PastGuess[] = [];
        for (let i = 0; i < game.guessesUsed; i += 1) {
          const g = await getGuess(id, i);
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
          await refresh(id);
          setPhase("playing");
        }
      } catch (err) {
        if (!cancelled) setMessage(`error: ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, route.mode, tokenId?.toString(), words.length]);

  const refresh = async (id: bigint) => {
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
  };

  const handleSubmit = useCallback(async () => {
    if (!account || !gameId || active.length !== 5) {
      if (active.length !== 5) setMessage("need 5 letters");
      return;
    }
    const wid = wordIndex.get(active.toLowerCase());
    if (wid === undefined) {
      setMessage(`"${active.toUpperCase()}" not in dictionary`);
      return;
    }
    const submitted = active;
    const guessesUsed = past.length;
    setMessage(<>guess <span className="accent">{guessesUsed + 1}</span> of 6 · processing<span className="dots"></span></>);
    setTxPending(true);
    try {
      const tx = await submitGuess(account, gameId, tokenId, guessesUsed, wid);
      await account.waitForTransaction(tx.transaction_hash);
      const g = await getGuess(gameId, guessesUsed);
      const game = await getGame(gameId);
      const newPast = [...past, { word: submitted, pattern: g.pattern }];
      setPast(newPast);
      setActive("");
      setFlipRowIndex(newPast.length - 1);
      setMessage(<>guess <span className="accent">{newPast.length}</span> of 6</>);
      if (game.endedAt !== 0n) {
        setWon(game.won);
        setFinalWord(words[game.finalWordId] ?? "?????");
        setPhase("ending");
      } else {
        await refresh(gameId);
      }
    } catch (err) {
      setMessage(`error: ${(err as Error).message}`);
    } finally {
      setTxPending(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, gameId, tokenId, active, past, wordIndex, words]);

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
      setMessage("copied result");
    } catch {
      setMessage("share failed");
    }
  }, [won, past, route]);

  if (!isConnected) {
    return (
      <>
        <Header />
        <section className="splash">
          <p className="splash-meta">connect to continue</p>
          <button className="btn-primary" onClick={onConnect}>
            Connect wallet
          </button>
        </section>
      </>
    );
  }

  if (phase === "loading") {
    return (
      <>
        <Header />
        <p className="boot-loading">{message}</p>
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

  // ending
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
        onPlayAgain={onPlayAgain}
        onShare={handleShare}
      />
    </>
  );
}
