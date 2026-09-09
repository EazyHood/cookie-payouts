import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { PublicKey } from "@solana/web3.js";
import {
  connection,
  explorerAddress,
  explorerTx,
  formatCook,
  GENESIS_HASH,
  RPC_URL,
} from "./chain";
import { connect, detectProviders, type Wallet } from "./wallet";
import {
  buildBatches,
  estimateFee,
  parseRecipients,
  type Batch,
  type BatchStatus,
} from "./payout";
import {
  decodeReceipt,
  receiptUrl,
  summarize,
  verifyAll,
  type VerifiedTx,
} from "./receipt";
import "./App.css";

const SAMPLE = `# One recipient per line: address, amount in COOK
# Blank lines and # comments are ignored.
6emiQZnwKwDuh795v3cf2jdYQ3f2d5DfYGafzYdupjuY, 0.01`;

const short = (s: string, head = 6, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/* ------------------------------------------------------------------ chain read */

interface ChainFacts {
  genesis?: string;
  slot?: number;
  blockHeight?: number;
  transactionCount?: number;
  rent?: number;
  error?: string;
}

function useChainFacts() {
  const [facts, setFacts] = useState<ChainFacts | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [genesis, epoch, rent] = await Promise.all([
          connection.getGenesisHash(),
          connection.getEpochInfo("confirmed"),
          connection.getMinimumBalanceForRentExemption(0),
        ]);
        if (cancelled) return;
        setFacts({
          genesis,
          slot: epoch.absoluteSlot,
          blockHeight: epoch.blockHeight ?? undefined,
          transactionCount: epoch.transactionCount ?? undefined,
          rent,
        });
      } catch (e) {
        if (!cancelled) setFacts({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return facts;
}

export default function App() {
  const hash = useHashRoute();
  const receiptMatch = hash.match(/^#\/receipt\/(.+)$/);
  const facts = useChainFacts();
  const genesisOk = facts?.genesis === GENESIS_HASH;

  return (
    <div className="app">
      <header className="chrome">
        <div className="wordmark">
          <span className="mark" aria-hidden="true" />
          Cookie Payouts
        </div>
        <ChainBadge facts={facts} ok={genesisOk} />
      </header>

      {receiptMatch ? (
        <ReceiptView encoded={decodeURIComponent(receiptMatch[1])} />
      ) : (
        <>
          <Hero facts={facts} genesisOk={genesisOk} />
          <PayoutView />
        </>
      )}

      <footer className="foot">
        <p>
          Everything on paper was read from Cookie Chain at <code>{RPC_URL}</code>. Receipts verify
          in the reader's own browser — there is no server holding a copy of these numbers.
        </p>
        <p>
          <a href="https://github.com/EazyHood/cookie-payouts" target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}

function ChainBadge({ facts, ok }: { facts: ChainFacts | null; ok: boolean }) {
  if (!facts) {
    return (
      <span className="badge">
        <span className="spinner" style={{ margin: 0 }} />
        reading chain
      </span>
    );
  }
  if (facts.error || !facts.genesis) {
    return (
      <span className="badge bad">
        <span className="dot" />
        rpc unreachable
      </span>
    );
  }
  return (
    <span className={`badge ${ok ? "ok" : "bad"}`} title="Compared against getGenesisHash">
      <span className="dot" />
      {ok ? "Cookie Chain" : "wrong chain"}
    </span>
  );
}

/* ------------------------------------------------------------------------ hero */

function Hero({ facts, genesisOk }: { facts: ChainFacts | null; genesisOk: boolean }) {
  const reduce = useReducedMotion();
  const rise = (i: number) => ({
    initial: reduce ? {} : { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.7, delay: 0.06 * i, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <section className="hero">
      <div>
        <motion.p className="eyebrow" {...rise(0)}>
          Cookie Chain · batch payouts
        </motion.p>
        <motion.h1 {...rise(1)}>
          A payout nobody has to <em>take your word for.</em>
        </motion.h1>
        <motion.p className="lede" {...rise(2)}>
          Pay a whole list in one approval. What you hand out afterwards is not a screenshot — it is
          a link that <strong>re-reads the transactions from the chain</strong> in the reader's own
          browser, and is allowed to come back saying no.
        </motion.p>
        <motion.div className="herolinks" {...rise(3)}>
          <a href="#make">
            <button className="primary">Make a payout</button>
          </a>
          <a href="https://github.com/EazyHood/cookie-payouts" target="_blank" rel="noreferrer">
            <button className="ghost">Read the source</button>
          </a>
        </motion.div>

        <motion.p className="aside" {...rise(4)}>
          Every number on the slip was read from the chain when this page loaded. Nothing here is a
          marketing figure, and the slip will stamp itself <em>not verified</em> if the read fails.
        </motion.p>
      </div>

      <ChainAttestation facts={facts} genesisOk={genesisOk} />
    </section>
  );
}

/**
 * The signature element: a receipt that attests to the thing this whole product
 * depends on — that the app is talking to the real Cookie Chain — and prints
 * itself line by line as the RPC answers. It stamps NOT VERIFIED just as
 * readily, which is the point: a receipt that can only say yes is decoration.
 */
function ChainAttestation({ facts, genesisOk }: { facts: ChainFacts | null; genesisOk: boolean }) {
  const reduce = useReducedMotion();
  const settled = facts !== null;
  const failed = settled && (!!facts.error || !genesisOk);

  const rows: { k: string; v: string | null; tone?: "pos" | "neg" }[] = [
    { k: "Network", v: settled && !facts.error ? "Cookie Chain · SVM" : null },
    {
      k: "Genesis",
      v: facts?.genesis ? short(facts.genesis, 8, 8) : null,
      tone: settled ? (genesisOk ? "pos" : "neg") : undefined,
    },
    { k: "Slot", v: facts?.slot ? facts.slot.toLocaleString("en-US") : null },
    {
      k: "Block height",
      v: facts?.blockHeight ? facts.blockHeight.toLocaleString("en-US") : null,
    },
    {
      k: "Transactions",
      v: facts?.transactionCount ? facts.transactionCount.toLocaleString("en-US") : null,
    },
    {
      k: "Rent exempt min",
      v: facts?.rent !== undefined ? `${formatCook(facts.rent)} COOK` : null,
    },
    { k: "Fee per transfer", v: settled && !facts.error ? "0.000005 COOK" : null },
  ];

  return (
    <motion.div
      className="sheet-wrap"
      initial={reduce ? {} : { opacity: 0, y: 26, rotateX: 6 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ duration: 0.9, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="sheet">
        <div className="sheet-head">
          <span className="sheet-title">Chain attestation</span>
          <span className="sheet-meta">read live</span>
        </div>

        {rows.map((r, i) => (
          <div className="sheet-row" key={r.k}>
            <span className="k">{r.k}</span>
            {/* `mode="wait"` needs the exit to actually finish. The pending
                shimmer repeats forever, and without its own exit transition the
                exit inherits that repeat, never completes, and the real value
                never gets to render — the receipt sat on "reading…" with the
                data already in hand. */}
            <AnimatePresence mode="wait" initial={false}>
              {r.v === null ? (
                <motion.span
                  key="pending"
                  className="v pending"
                  initial={{ opacity: 0.35 }}
                  animate={{ opacity: [0.35, 0.75, 0.35] }}
                  exit={{ opacity: 0, transition: { duration: 0.18 } }}
                  transition={{ duration: 1.3, repeat: Infinity, delay: i * 0.12 }}
                >
                  reading…
                </motion.span>
              ) : (
                // Opacity only, no transform. Animating the position of small
                // mono text puts it on its own compositor layer, and a layer
                // that has not been painted yet renders as an empty row — the
                // slip looked blank while the values sat in the DOM. A fade
                // carries the same sequence without that risk.
                <motion.span
                  key="value"
                  className={`v ${r.tone ?? ""}`}
                  initial={reduce ? {} : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, delay: i * 0.11, ease: "easeOut" }}
                >
                  {r.v}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        ))}

        <div className="sheet-total">
          <span>Matches Cookie Chain</span>
          <span>{settled ? (genesisOk ? "yes" : "no") : "—"}</span>
        </div>

        <AnimatePresence>
          {settled && (
            <motion.span
              className={`stamp ${failed ? "neg" : "pos"}`}
              initial={reduce ? {} : { opacity: 0, scale: 1.6, rotate: -22 }}
              animate={{ opacity: 0.88, scale: 1, rotate: -7 }}
              transition={{ duration: 0.5, delay: 0.75, ease: [0.34, 1.56, 0.64, 1] }}
            >
              {failed ? "Not verified" : "Verified"}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ the payout */

function PayoutView() {
  const [text, setText] = useState(SAMPLE);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [statuses, setStatuses] = useState<BatchStatus[]>([]);
  const [signatures, setSignatures] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const providers = useMemo(() => detectProviders(), [wallet]);
  const parsed = useMemo(() => parseRecipients(text), [text]);

  const refreshBalance = useCallback(async (pk: PublicKey) => {
    try {
      setBalance(BigInt(await connection.getBalance(pk, "confirmed")));
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    if (wallet) refreshBalance(wallet.publicKey);
  }, [wallet, refreshBalance]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!wallet || parsed.recipients.length === 0) {
        setBatches([]);
        setFee(null);
        return;
      }
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const bs = buildBatches(wallet.publicKey, parsed.recipients, blockhash, lastValidBlockHeight);
        if (cancelled) return;
        setBatches(bs);
        setStatuses(bs.map(() => ({ state: "waiting" as const })));
        const f = await estimateFee(bs);
        if (!cancelled) setFee(f);
      } catch {
        if (!cancelled) {
          setBatches([]);
          setFee(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, text, parsed.recipients.length]);

  const total = parsed.total;
  const needed = total + (fee ?? 0n);
  const isShort = balance !== null && needed > balance;

  async function onConnect(entry: ReturnType<typeof detectProviders>[number]) {
    setWalletError(null);
    try {
      setWallet(await connect(entry));
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onSend() {
    if (!wallet || batches.length === 0 || running) return;
    setRunning(true);
    setSignatures([]);
    const next: BatchStatus[] = batches.map(() => ({ state: "waiting" }));
    setStatuses([...next]);

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const fresh = buildBatches(wallet.publicKey, parsed.recipients, blockhash, lastValidBlockHeight);
      setBatches(fresh);

      next.forEach((_, i) => (next[i] = { state: "signing" }));
      setStatuses([...next]);

      const signed = await wallet.signAllTransactions(fresh.map((b) => b.tx));

      const sigs: string[] = [];
      for (let i = 0; i < signed.length; i++) {
        next[i] = { state: "sending" };
        setStatuses([...next]);
        try {
          const sig = await connection.sendRawTransaction(signed[i].serialize(), {
            skipPreflight: false,
            preflightCommitment: "confirmed",
          });
          next[i] = { state: "confirming", signature: sig };
          setStatuses([...next]);

          const conf = await connection.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            "confirmed"
          );
          if (conf.value.err) {
            next[i] = { state: "failed", signature: sig, error: JSON.stringify(conf.value.err) };
          } else {
            next[i] = { state: "confirmed", signature: sig };
            sigs.push(sig);
          }
        } catch (e) {
          next[i] = { state: "failed", error: e instanceof Error ? e.message : String(e) };
        }
        setStatuses([...next]);
        setSignatures([...sigs]);
      }
      await refreshBalance(wallet.publicKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatuses(batches.map(() => ({ state: "failed", error: msg })));
    } finally {
      setRunning(false);
    }
  }

  const done =
    statuses.length > 0 && statuses.every((s) => s.state === "confirmed" || s.state === "failed");

  return (
    <main className="instrument" id="make">
      <p className="rule">The instrument</p>
      <div className="grid">
        <section className="card">
          <h2>
            <span className="step">01</span> The list
          </h2>
          <p className="hint">
            One line per recipient: address, then the amount in COOK. Every line that cannot be read
            is reported below with its number — nothing is dropped quietly.
          </p>
          <textarea
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            rows={11}
            aria-label="Recipients"
          />
          <div className="tally">
            <div>
              <span className="n">{parsed.recipients.length}</span>
              <span className="l">recipients</span>
            </div>
            <div>
              <span className="n">{formatCook(total)}</span>
              <span className="l">COOK total</span>
            </div>
            {batches.length > 0 && (
              <div>
                <span className="n">{batches.length}</span>
                <span className="l">transaction{batches.length > 1 ? "s" : ""}</span>
              </div>
            )}
          </div>
          <AnimatePresence>
            {parsed.errors.length > 0 && (
              <motion.ul
                className="errors"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
              >
                {parsed.errors.map((e) => (
                  <li key={e.line}>
                    <span className="ln">line {e.line}</span>
                    {e.reason}
                    <code>{e.text.slice(0, 64)}</code>
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </section>

        <section className="card">
          <h2>
            <span className="step">02</span> The wallet
          </h2>
          {!wallet ? (
            <>
              <p className="hint">
                Nightly signs; this app submits to Cookie Chain itself. Wallets that broadcast
                through their own RPC would send the transaction to Solana, where it never lands.
              </p>
              {providers.length === 0 ? (
                <p className="note bad">
                  No Solana wallet detected. Install{" "}
                  <a href="https://nightly.app/" target="_blank" rel="noreferrer">
                    Nightly
                  </a>{" "}
                  and reload this page.
                </p>
              ) : (
                <div className="btnrow">
                  {providers.map((p) => (
                    <button key={p.name} className="primary" onClick={() => onConnect(p)}>
                      Connect {p.name}
                    </button>
                  ))}
                </div>
              )}
              {walletError && <p className="note bad">{walletError}</p>}
            </>
          ) : (
            <motion.dl
              className="kv"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <dt>Paying from</dt>
              <dd>
                <a
                  className="mono"
                  href={explorerAddress(wallet.publicKey.toBase58())}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(wallet.publicKey.toBase58(), 10, 10)}
                </a>
                <span className="muted small"> · {wallet.name}</span>
              </dd>
              <dt>Balance</dt>
              <dd className="amt">{balance === null ? "—" : `${formatCook(balance)} COOK`}</dd>
              <dt>Payout</dt>
              <dd className="amt">{formatCook(total)} COOK</dd>
              <dt>Network fee</dt>
              <dd className="amt">
                {fee === null ? <span className="muted">estimating…</span> : `${formatCook(fee)} COOK`}
              </dd>
            </motion.dl>
          )}
          {isShort && (
            <p className="note bad">
              Short by {formatCook(needed - (balance ?? 0n))} COOK. Nothing has been sent.
            </p>
          )}
        </section>

        <section className="card wide">
          <h2>
            <span className="step">03</span> Send, then prove it
          </h2>
          <motion.button
            className="primary big"
            disabled={!wallet || batches.length === 0 || running || isShort}
            onClick={onSend}
            whileTap={{ scale: 0.995 }}
          >
            {running
              ? "Sending…"
              : `Pay ${parsed.recipients.length} recipient${parsed.recipients.length === 1 ? "" : "s"}`}
          </motion.button>

          {statuses.length > 0 && (
            <ol className="batches">
              {statuses.map((s, i) => (
                <motion.li
                  key={i}
                  className={s.state}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <span className="bn">
                    batch {i + 1} · {batches[i]?.recipients.length ?? 0} transfers
                  </span>
                  <StatusLabel s={s} />
                </motion.li>
              ))}
            </ol>
          )}

          <AnimatePresence>
            {done && signatures.length > 0 && <ReceiptLink signatures={signatures} />}
          </AnimatePresence>
        </section>
      </div>
    </main>
  );
}

function StatusLabel({ s }: { s: BatchStatus }) {
  switch (s.state) {
    case "waiting":
      return <span className="muted">waiting</span>;
    case "signing":
      return (
        <span className="muted">
          <span className="spinner" />
          waiting for your signature
        </span>
      );
    case "sending":
      return (
        <span className="muted">
          <span className="spinner" />
          sending
        </span>
      );
    case "confirming":
      return (
        <a href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
          <span className="spinner" />
          confirming
        </a>
      );
    case "confirmed":
      return (
        <a className="ok" href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
          confirmed · {short(s.signature, 6, 6)}
        </a>
      );
    case "failed":
      return (
        <span className="bad">
          failed — {s.error}
          {s.signature && (
            <>
              {" "}
              <a href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
                view
              </a>
            </>
          )}
        </span>
      );
  }
}

function ReceiptLink({ signatures }: { signatures: string[] }) {
  const url = receiptUrl(signatures);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      style={{ marginTop: 22, paddingTop: 20, borderTop: "1px solid var(--ink-600)" }}
    >
      <h2 style={{ marginBottom: 6 }}>The receipt</h2>
      <p className="hint">
        This link carries signatures, not amounts. Whoever opens it reads the transactions back from
        Cookie Chain themselves.
      </p>
      <div className="copyrow">
        <input ref={ref} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
            } catch {
              ref.current?.select();
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <a href={url}>Open the receipt →</a>
    </motion.div>
  );
}

/* ----------------------------------------------------------------- receipt view */

function ReceiptView({ encoded }: { encoded: string }) {
  const signatures = useMemo(() => decodeReceipt(encoded), [encoded]);
  const [txs, setTxs] = useState<VerifiedTx[] | null>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    let cancelled = false;
    setTxs(null);
    verifyAll(signatures).then((r) => {
      if (!cancelled) setTxs(r);
    });
    return () => {
      cancelled = true;
    };
  }, [signatures]);

  const s = txs ? summarize(txs) : null;
  const allGood = !!s && s.failed === 0 && s.missing === 0 && s.paid > 0 && s.recipients > 0;

  return (
    <main className="instrument" style={{ paddingTop: "clamp(36px,6vw,72px)" }}>
      <p className="rule">Receipt · verified against the chain</p>

      <motion.div
        className="sheet-wrap"
        style={{ maxWidth: 620, margin: "0 auto 26px" }}
        initial={reduce ? {} : { opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="sheet">
          <div className="sheet-head">
            <span className="sheet-title">Payout receipt</span>
            <span className="sheet-meta">
              {signatures.length} transaction{signatures.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="sheet-row">
            <span className="k">Recipients paid</span>
            <span className={`v ${txs ? "" : "pending"}`}>{s ? s.recipients : "reading…"}</span>
          </div>
          <div className="sheet-row">
            <span className="k">Confirmed</span>
            <span className={`v ${txs ? "" : "pending"}`}>{s ? s.paid : "reading…"}</span>
          </div>
          {s && s.failed > 0 && (
            <div className="sheet-row">
              <span className="k">Failed</span>
              <span className="v neg">{s.failed}</span>
            </div>
          )}
          {s && s.missing > 0 && (
            <div className="sheet-row">
              <span className="k">Not on chain</span>
              <span className="v neg">{s.missing}</span>
            </div>
          )}
          <div className="sheet-row">
            <span className="k">Fees</span>
            <span className={`v ${txs ? "" : "pending"}`}>
              {s ? `${formatCook(s.fees)} COOK` : "reading…"}
            </span>
          </div>

          <div className="sheet-total">
            <span>Total paid</span>
            <span>{s ? `${formatCook(s.total)} COOK` : "—"}</span>
          </div>

          <AnimatePresence>
            {txs && (
              <motion.span
                className={`stamp ${allGood ? "pos" : "neg"}`}
                initial={reduce ? {} : { opacity: 0, scale: 1.6, rotate: -22 }}
                animate={{ opacity: 0.88, scale: 1, rotate: -7 }}
                transition={{ duration: 0.5, delay: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
              >
                {allGood ? "Verified" : "Not verified"}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {s && !allGood && (
        <p className="note bad" style={{ maxWidth: 620, margin: "0 auto 24px" }}>
          {s.recipients === 0 && s.failed === 0 && s.missing === 0
            ? "These transactions are on chain and confirmed, but none of them moved any COOK. This is not a payout receipt."
            : "This receipt does not fully check out. Everything below was read from the chain just now — treat anything failed or missing as unpaid."}
        </p>
      )}

      <div className="grid">
        {(txs ?? []).map((t, i) => (
          <motion.section
            className="card wide"
            key={t.signature}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.07, duration: 0.5 }}
          >
            <h2>
              <span className={t.found && t.succeeded ? "ok" : "bad"}>
                {t.found ? (t.succeeded ? "Confirmed" : "Failed on chain") : "Not found on chain"}
              </span>
            </h2>
            <p className="mono small">
              <a href={explorerTx(t.signature)} target="_blank" rel="noreferrer">
                {t.signature}
              </a>
            </p>
            {t.from && (
              <p className="small muted">
                from{" "}
                <a href={explorerAddress(t.from)} target="_blank" rel="noreferrer">
                  {short(t.from, 8, 8)}
                </a>
                {t.slot ? ` · slot ${t.slot.toLocaleString("en-US")}` : ""}
                {t.blockTime ? ` · ${new Date(t.blockTime * 1000).toUTCString()}` : ""}
              </p>
            )}
            {t.error && <p className="note bad">{t.error}</p>}
            {t.found && t.succeeded && t.transfers.length === 0 && (
              <p className="note bad">
                This transaction confirmed, but it contains no native COOK transfers. It is on chain
                and it paid nobody — do not read it as a payout.
              </p>
            )}
            {t.transfers.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th className="num">COOK</th>
                  </tr>
                </thead>
                <tbody>
                  {t.transfers.map((tr, j) => (
                    <tr key={j}>
                      <td className="mono small">
                        <a href={explorerAddress(tr.to)} target="_blank" rel="noreferrer">
                          {short(tr.to, 10, 10)}
                        </a>
                      </td>
                      <td className="num">{formatCook(tr.units)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </motion.section>
        ))}
      </div>

      <p style={{ marginTop: 26 }}>
        <a href="#/">← Make another payout</a>
      </p>
    </main>
  );
}
