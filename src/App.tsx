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
  verifyChain,
} from "./chain";
import { connect, detectProviders, type Wallet } from "./wallet";
import {
  buildBatches,
  estimateFee,
  parseRecipients,
  getPayoutBlocker,
  type Batch,
  type BatchStatus,
} from "./payout";
import {
  decodeReceipt,
  encodeReceipt,
  receiptUrl,
  summarize,
  verifyAll,
  type VerifiedTx,
} from "./receipt";
import AuditView from "./AuditView";
import { downloadText, planJson } from "./plan";
import { submitSignedBatches } from "./send";
import "./App.css";

const SAMPLE = `# Add your recipients: address, amount in COOK
# Use Reconcile for a read-only public example.`;

const RUN_KEY = "cookie-payouts-last-run-v1";
interface SavedRun { sender: string; list: string; signatures: string[]; createdAt: string }
function loadRun(): SavedRun | null {
  try {
    const run = JSON.parse(localStorage.getItem(RUN_KEY) ?? "null");
    if (!run || typeof run.sender !== "string" || typeof run.list !== "string" || typeof run.createdAt !== "string" || !Array.isArray(run.signatures)) return null;
    if (!encodeReceipt(run.signatures)) return null;
    const parsed = parseRecipients(run.list);
    if (parsed.errors.length || !parsed.recipients.length) return null;
    new PublicKey(run.sender);
    return run;
  } catch { return null; }
}

function safeDecode(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

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
  const auditMatch = hash.match(/^#\/audit(?:\/(.+))?$/);
  const facts = useChainFacts();
  const genesisOk = facts?.genesis === GENESIS_HASH;

  return (
    <div className="app">
      <header className="chrome">
        <div className="wordmark">
          <span className="mark" aria-hidden="true" />
          Cookie Payouts
        </div>
        <nav aria-label="Main navigation"><a href="#make">Pay</a><a href="#/audit">Reconcile</a></nav>
        <ChainBadge facts={facts} ok={genesisOk} />
      </header>

      {auditMatch ? (
        <AuditView key={hash} initialSignatures={auditMatch[1] ? decodeReceipt(safeDecode(auditMatch[1])) : []} />
      ) : receiptMatch ? (
        <ReceiptView key={receiptMatch[1]} encoded={safeDecode(receiptMatch[1])} />
      ) : (
        <>
          <Hero facts={facts} genesisOk={genesisOk} />
          <PayoutView chainOk={genesisOk} />
        </>
      )}

      <footer className="foot">
        <p>
          Native transfers are read from Cookie Chain at <code>{RPC_URL}</code> in your browser.
          Comparison plans are supplied by the reader. An RPC response is not proof of identity or a prior agreement.
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
          Cookie Chain · payments and reconciliation
        </motion.p>
        <motion.h1 {...rise(1)}>
          Pay the list. <em>Check every amount.</em>
        </motion.h1>
        <motion.p className="lede" {...rise(2)}>
          Send native COOK to contributors, then compare what was expected with what reached the chain.
          <strong> Find missing, extra and incorrect amounts</strong> by sender and recipient.
          Anyone can check a receipt without connecting a wallet.
        </motion.p>
        <motion.div className="herolinks" {...rise(3)}>
          <a href="#/audit" className="button-link primary-link">Try reconciliation</a>
          <a href="#make" className="button-link">Make a payout</a>
        </motion.div>

        <motion.p className="aside" {...rise(4)}>
          Start with a public chain example, then change the expected amount to see the difference.
          The example is an external transaction, not a payment created by this app.
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

function PayoutView({ chainOk }: { chainOk: boolean }) {
  const [text, setText] = useState(SAMPLE);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [statuses, setStatuses] = useState<BatchStatus[]>([]);
  const [signatures, setSignatures] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [savedRun, setSavedRun] = useState<SavedRun | null>(loadRun);
  const [reviewedRun, setReviewedRun] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const providers = detectProviders();
  const parsed = useMemo(() => parseRecipients(text), [text]);

  const refreshBalance = useCallback(async (pk: PublicKey) => {
    try {
      const raw = await connection.getBalance(pk, "confirmed");
      setBalance(Number.isSafeInteger(raw) ? BigInt(raw) : null);
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    // Synchronize the visible balance with the wallet's external RPC account.
    // eslint-disable-next-line react/set-state-in-effect
    if (wallet) refreshBalance(wallet.publicKey);
  }, [wallet, refreshBalance]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (runningRef.current) return;
      setPreviewReady(false);
      setFee(null);
      setPreviewError(null);
      if (!wallet || parsed.recipients.length === 0 || parsed.errors.length > 0 || savedRun) {
        setBatches([]);
        setFee(null);
        return;
      }
      try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const bs = buildBatches(wallet.publicKey, parsed.recipients, blockhash, lastValidBlockHeight);
        if (cancelled) return;
        setBatches(bs);
        const f = await estimateFee(bs);
        if (!cancelled) { setFee(f); setPreviewReady(f !== null); }
      } catch (e) {
        if (!cancelled) {
          setBatches([]);
          setFee(null);
          setPreviewError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, text, parsed, savedRun]);

  const total = parsed.total;
  const needed = total + (fee ?? 0n);
  const isShort = balance !== null && needed > balance;
  const blocker = savedRun ? "Review the previous run before starting another payout." : getPayoutBlocker({
    chainOk, hasWallet: !!wallet, recipientCount: parsed.recipients.length, errorCount: parsed.errors.length,
    fee: previewReady ? fee : null, balance, batchCount: batches.length, running, total,
  });

  async function onConnect(entry: ReturnType<typeof detectProviders>[number]) {
    setWalletError(null);
    setConnecting(true);
    try {
      setWallet(await connect(entry));
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    } finally { setConnecting(false); }
  }

  async function onSend() {
    if (!navigator.locks) { setWalletError("This browser cannot coordinate safe sending between tabs. Use a current browser over HTTPS."); return; }
    try {
      await navigator.locks.request("cookie-payouts-send", { ifAvailable: true }, async lock => {
        if (!lock) { setWalletError("A payout is already running in another view or tab. Wait for it and check its receipt."); return; }
        const previous = loadRun();
        if (previous) { setSavedRun(previous); setReviewedRun(false); return; }
        if (localStorage.getItem(RUN_KEY)) { setWalletError("The saved run could not be read. Preserve it and check previous transactions before clearing this site's data."); return; }
        await performSend();
      });
    } catch (e) { setWalletError(e instanceof Error ? e.message : String(e)); }
  }

  async function clearReviewedRun() {
    if (!reviewedRun || !savedRun || !navigator.locks) return;
    try {
      await navigator.locks.request("cookie-payouts-send", { ifAvailable: true }, async lock => {
        if (!lock) { setWalletError("A payout is still running. Its recovery record cannot be cleared yet."); return; }
        const current = loadRun();
        if (JSON.stringify(current) !== JSON.stringify(savedRun)) {
          setSavedRun(current); setReviewedRun(false); setWalletError("The run changed in another tab. Review the latest record first."); return;
        }
        localStorage.removeItem(RUN_KEY); setSavedRun(null); setReviewedRun(false);
        setStatuses([]); setSignatures([]); setText(SAMPLE); setWalletError(null);
      });
    } catch (e) { setWalletError(e instanceof Error ? e.message : String(e)); }
  }

  async function performSend() {
    if (!wallet || blocker || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setWalletError(null);
    setSignatures([]);
    let next: BatchStatus[] = batches.map(() => ({ state: "waiting" }));
    setStatuses([...next]);

    try {
      const chain = await verifyChain();
      if (!chain.ok) throw new Error("Cookie Chain could not be verified. Nothing was signed or sent.");
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const fresh = buildBatches(wallet.publicKey, parsed.recipients, blockhash, lastValidBlockHeight);
      setBatches(fresh);
      const [freshFee, rawBalance] = await Promise.all([estimateFee(fresh), connection.getBalance(wallet.publicKey, "confirmed")]);
      const freshBalance = Number.isSafeInteger(rawBalance) ? BigInt(rawBalance) : null;
      setBalance(freshBalance);
      const freshBlocker = getPayoutBlocker({ chainOk: true, hasWallet: true, recipientCount: parsed.recipients.length,
        errorCount: parsed.errors.length, fee: freshFee, balance: freshBalance, batchCount: fresh.length, running: false, total });
      if (freshBlocker) throw new Error(freshBlocker);
      if (freshFee !== fee) { setFee(freshFee); throw new Error("The fee estimate changed. Review the updated fee, then try again."); }
      next = fresh.map(() => ({ state: "signing" }));
      setStatuses([...next]);
      const signed = await wallet.signAllTransactions(fresh.map((b) => b.tx));
      const run: SavedRun = { sender: wallet.publicKey.toBase58(), list: text, signatures: [], createdAt: new Date().toISOString() };
      await submitSignedBatches(signed, blockhash, lastValidBlockHeight, connection,
        (index, status) => { next[index] = status; setStatuses([...next]); },
        signature => {
          run.signatures = [...run.signatures, signature];
          try { localStorage.setItem(RUN_KEY, JSON.stringify(run)); }
          catch { throw new Error("Could not save the run on this device. Broadcast stopped to preserve recovery evidence."); }
          setSavedRun({ ...run });
          setSignatures([...run.signatures]);
        });
      await refreshBalance(wallet.publicKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setWalletError(msg);
      setStatuses(next.map(() => ({ state: "failed", error: msg })));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  const done =
    statuses.length > 0 && statuses.every((s) => ["confirmed", "failed", "uncertain", "skipped"].includes(s.state));

  return (
    <main className="instrument" id="make">
      <p className="rule">The instrument</p>
      {savedRun && <section className="card saved-run">
        <h2>Previous run saved on this device</h2>
        <p className="hint">A broadcast was attempted for {savedRun.signatures.length} transaction(s). Read their current status before making another payout. A timeout does not prove they failed.</p>
        <div className="btnrow">
          <a className="button-link" href={receiptUrl(savedRun.signatures)}>Check saved receipt</a>
          <a className="button-link" href={`#/audit/${savedRun.signatures.join(".")}`}>Reconcile this run</a>
          <button onClick={() => downloadText("cookie-payout-run.json", JSON.stringify(savedRun, null, 2), "application/json")}>Download run record</button>
          <button onClick={() => downloadText("cookie-payout-plan.json", planJson({ sender: savedRun.sender, recipients: parseRecipients(savedRun.list).recipients }), "application/json")}>Download original plan</button>
        </div>
        {!running && <><label className="check-label"><input type="checkbox" checked={reviewedRun} onChange={e => setReviewedRun(e.target.checked)} />I checked this run and understand that paying the same list again can duplicate payments.</label>
          <button disabled={!reviewedRun} onClick={clearReviewedRun}>Start a different payout</button></>}
      </section>}
      <div className="grid">
        <section className="card">
          <h2>
            <span className="step">01</span> The list
          </h2>
          <p className="hint">
            One address and COOK amount per line, up to 200 recipients. Fix every rejected line before sending.
          </p>
          <label className="visually-hidden" htmlFor="payout-list">Recipients</label>
          <textarea
            value={text}
            id="payout-list"
            disabled={running || !!savedRun}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            rows={11}
            aria-label="Recipients"
          />
          <div className="btnrow" style={{ marginTop: 12 }}><button disabled={!wallet || !!parsed.errors.length || !parsed.recipients.length || running}
            onClick={() => wallet && downloadText("cookie-payout-plan.json", planJson({ sender: wallet.publicKey.toBase58(), recipients: parsed.recipients }), "application/json")}>Download plan before paying</button></div>
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
                Connect a Nightly SVM account. The wallet signs; this app submits to Cookie Chain.
                Depending on wallet support, a large payout may require multiple approvals.
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
                    <button key={p.name} className="primary" disabled={connecting || running} onClick={() => onConnect(p)}>
                      {connecting ? "Connecting…" : `Connect ${p.name}`}
                    </button>
                  ))}
                </div>
              )}
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
          <p className="hint" style={{ marginTop: 16 }}>Need a Cookie Chain account or native COOK? <a href="https://docs.cookiechain.wtf/wallets" target="_blank" rel="noreferrer">Wallet setup</a> · <a href="https://docs.cookiechain.wtf/bridge" target="_blank" rel="noreferrer">Bridge guide</a></p>
          {walletError && <p className="note bad" role="alert">{walletError}{walletError.includes("501") && " — Open Nightly and create or select an SVM account, then connect again."}</p>}
          {previewError && <p className="note bad" role="alert">{previewError}</p>}
        </section>

        <section className="card wide">
          <h2>
            <span className="step">03</span> Send, then prove it
          </h2>
          <motion.button
            className="primary big"
            disabled={!!blocker}
            aria-describedby="payout-blocker"
            onClick={onSend}
            whileTap={{ scale: 0.995 }}
          >
            {running
              ? "Sending…"
              : `Pay ${parsed.recipients.length} recipient${parsed.recipients.length === 1 ? "" : "s"}`}
          </motion.button>
          <p className="hint" id="payout-blocker" style={{ marginTop: 12 }}>{blocker ?? "Review the full list, total and fee above. You approve each required transaction in your wallet."}</p>

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
    case "uncertain":
      return <span className="bad">Status unknown — do not resend. <a href={explorerTx(s.signature)} target="_blank" rel="noreferrer">Check transaction</a><span className="small"> · {s.error}</span></span>;
    case "skipped":
      return <span className="muted">Not sent · {s.error}</span>;
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
      <h2 style={{ marginBottom: 6 }}>Run receipt</h2>
      <p className="hint">
        This link includes every attempted broadcast, including uncertain results. Open it to read their current chain status, then compare with the original plan.
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
  const [readError, setReadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const chain = await verifyChain();
        if (!chain.ok) throw new Error("Cookie Chain could not be verified. Try reading again before trusting this receipt.");
        const result = await verifyAll(signatures);
        if (!cancelled) setTxs(result);
      } catch (e) { if (!cancelled) setReadError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => {
      cancelled = true;
    };
  }, [signatures, readAttempt]);

  const s = txs ? summarize(txs) : null;
  const allGood = !!s && s.failed === 0 && s.missing === 0 && s.unresolved === 0 && s.paid > 0 && s.recipients > 0;

  return (
    <main className="instrument" style={{ paddingTop: "clamp(36px,6vw,72px)" }}>
      <p className="rule">Transaction receipt · read from Cookie Chain</p>
      {readError && <p className="note bad" role="alert">{readError} <button onClick={() => { setTxs(null); setReadError(null); setReadAttempt(n => n + 1); }}>Read again</button></p>}

      <motion.div
        className="sheet-wrap"
        hidden={!!readError}
        style={{ maxWidth: 620, margin: "0 auto 26px" }}
        initial={reduce ? {} : { opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="sheet">
          <div className="sheet-head">
            <span className="sheet-title">Native transfer receipt</span>
            <span className="sheet-meta">
              {signatures.length} transaction{signatures.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="sheet-row">
            <span className="k">Unique recipients</span>
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
          {s && s.unresolved > 0 && <div className="sheet-row"><span className="k">Unresolved reads</span><span className="v neg">{s.unresolved}</span></div>}
          <div className="sheet-row">
            <span className="k">Fees</span>
            <span className={`v ${txs ? "" : "pending"}`}>
              {s ? `${formatCook(s.fees)} COOK` : "reading…"}
            </span>
          </div>

          <div className="sheet-total">
            <span>Native transfers</span>
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
                {allGood ? "Observed on chain" : "Review required"}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {s && !allGood && (
        <p className="note bad" style={{ maxWidth: 620, margin: "0 auto 24px" }}>
          {s.recipients === 0 && s.failed === 0 && s.missing === 0 && s.unresolved === 0 && s.paid > 0
            ? "These transactions confirmed, but no native transfer instructions were observed. Other instructions or token movements are outside this receipt's scope."
            : "This receipt is incomplete. A missing transaction or unavailable RPC response does not prove nonpayment. Resolve unknown results before resending."}
        </p>
      )}
      <p className="note scope-note">This receipt reads native transfer instructions at confirmed commitment. It does not prove who controls an address, a prior agreement or final net settlement. <a href={`#/audit/${signatures.join(".")}`}>Compare with your original payout plan →</a></p>

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
                {t.status === "rpc_error" ? "RPC unavailable" : t.status === "unresolved" ? "Incomplete chain evidence" : t.found ? (t.succeeded ? "Confirmed" : "Failed on chain") : "Not found on chain"}
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
                This transaction confirmed, but no native transfer instructions were observed. Other token or account movements are outside this receipt's scope.
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
                        <span className="muted">from {short(tr.from, 6, 6)} → </span>
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
