import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from "motion/react";
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
import { connect, detectProviders, subscribeProvidersChanged, type Wallet } from "./wallet";
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
import { Icon } from "./Icon";
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
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [hash]);
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
  const viewName = auditMatch ? "Reconciliation" : receiptMatch ? "Transaction receipt" : "New payout";

  return (
    <MotionConfig reducedMotion="user"><div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#make" aria-label="Cookie Payouts home">
          <span className="brand-mark"><Icon name="receipt" size={24} /></span>
          <span className="brand-name">cookie<small>payouts</small></span>
        </a>
        <p className="nav-label">Your workspace</p>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#make" className={!auditMatch && !receiptMatch ? "active" : ""} aria-current={!auditMatch && !receiptMatch ? "page" : undefined}><Icon name="send" size={18} />New payout<Icon name="chevron" size={14} className="nav-arrow" /></a>
          <a href="#/audit" className={auditMatch ? "active" : ""} aria-current={auditMatch ? "page" : undefined}><Icon name="compare" size={18} />Reconcile<Icon name="chevron" size={14} className="nav-arrow" /></a>
          {receiptMatch && <a href={hash} className="active" aria-current="page"><Icon name="receipt" size={18} />Receipt</a>}
        </nav>
        <div className="rail-guide">
          <Icon name="shield" size={24} />
          <h2>Close the loop.</h2>
          <p>Check every recipient and amount against the chain. No wallet needed.</p>
          <a href="#/audit">Explore reconciliation <Icon name="arrow" size={15} /></a>
        </div>
        <div className="rail-resources">
          <a href="https://docs.cookiechain.wtf/wallets" target="_blank" rel="noreferrer"><Icon name="wallet" size={15} />Wallet setup<Icon name="external" size={12} className="nav-arrow" /></a>
          <a href="https://github.com/EazyHood/cookie-payouts" target="_blank" rel="noreferrer"><Icon name="file" size={15} />Source & documentation<Icon name="external" size={12} className="nav-arrow" /></a>
        </div>
        <div className="rail-bottom"><span className="dot" />BUILT ON COOKIE CHAIN</div>
      </aside>
      <div className="workspace-shell">
        <header className="workspace-bar">
          <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={12} /><strong>{viewName}</strong></div>
          <div className="workspace-network"><span className="network-label">NATIVE COOK</span>
            <details className="network-details"><summary><span className="visually-hidden">Network details: </span><ChainBadge facts={facts} ok={genesisOk} /><Icon name="chevron" size={12} /></summary>
              <div className="network-popover"><p className="eyebrow">Current session</p><h2>Network snapshot</h2>
                <dl className="kv"><dt>Network</dt><dd>{genesisOk ? "Cookie Chain" : "Not verified"}</dd><dt>Slot</dt><dd className="mono">{facts?.slot?.toLocaleString("en-US") ?? "—"}</dd><dt>Transactions</dt><dd className="mono">{facts?.transactionCount?.toLocaleString("en-US") ?? "—"}</dd><dt>Rent exempt minimum</dt><dd className="mono">{facts?.rent != null ? `${formatCook(facts.rent)} COOK` : "—"}</dd></dl>
                <p className="network-genesis">Genesis<span className="mono">{facts?.genesis ?? "Reading network…"}</span></p><a href={RPC_URL} target="_blank" rel="noreferrer">Public RPC <Icon name="external" size={12} /></a>
              </div>
            </details>
          </div>
        </header>

      {auditMatch ? (
        <AuditView key={hash} initialSignatures={auditMatch[1] ? decodeReceipt(safeDecode(auditMatch[1])) : []} />
      ) : receiptMatch ? (
        <ReceiptView key={receiptMatch[1]} encoded={safeDecode(receiptMatch[1])} />
      ) : (
        <PayoutView chainOk={genesisOk} />
      )}

      <footer className="foot">
        <p>
          Native COOK · Read at confirmed commitment. Comparison plans are supplied by the reader;
          a chain observation does not prove identity or a prior agreement.
        </p>
        <p>
          <a href="https://github.com/EazyHood/cookie-payouts" target="_blank" rel="noreferrer">
            Open source <Icon name="external" size={12} />
          </a>
        </p>
      </footer>
      </div>
    </div></MotionConfig>
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
  const [providers, setProviders] = useState(() => detectProviders());
  useEffect(() => {
    const refresh = () => setProviders(detectProviders());
    const stop = subscribeProvidersChanged(refresh);
    refresh();
    return stop;
  }, []);
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
      const message = e instanceof Error ? e.message : String(e);
      setWalletError(`${entry.name}: ${message}${message.includes("501") ? " — Select a Solana/SVM signing account in that wallet and reconnect." : ""}`);
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
    <main className="instrument payout-workspace" id="make">
      <div className="workspace-heading">
        <div className="page-intro"><p className="eyebrow">Payment operations</p><h1>Pay your people.</h1>
          <p>One list for your contributors. Every amount accounted for.</p></div>
        <a href="#/audit" className="button-link"><Icon name="compare" size={17} />Reconcile a payout</a>
      </div>
      <div className="flow-strip" aria-label="Payout preparation">
        <span className={`flow-step ${parsed.recipients.length && !parsed.errors.length ? "done" : "active"}`}><b>{parsed.recipients.length && !parsed.errors.length ? <Icon name="check" size={12} /> : "1"}</b>Prepare your list</span><span className="flow-line" />
        <span className={`flow-step ${wallet ? "done" : ""}`}><b>{wallet ? <Icon name="check" size={12} /> : "2"}</b>Connect wallet</span><span className="flow-line" />
        <span className={`flow-step ${!blocker ? "active" : ""}`}><b>3</b>Review & pay</span>
      </div>
      {savedRun && <section className="card saved-run">
        <h2><Icon name="clock" size={20} />Previous run saved on this device</h2>
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
      <div className="grid payout-grid">
        <section className="card recipients-panel">
          <div className="card-heading"><h2><span className="icon-box"><Icon name="users" size={18} /></span>Recipients</h2><span className="card-caption">01 / PREPARE</span></div>
          <label className="editor-label" htmlFor="payout-list">Your payout list<span>Up to 200 recipients</span></label>
          <textarea
            className="recipient-editor"
            value={text}
            id="payout-list"
            disabled={running || !!savedRun}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder="Wallet address, amount in COOK"
          />
          <p className="editor-help"><Icon name="info" size={14} />One wallet address and COOK amount per line, separated by a comma. Every rejected row must be fixed.</p>
          <div className="btnrow"><button className="quiet" disabled={!wallet || !!parsed.errors.length || !parsed.recipients.length || running}
            onClick={() => wallet && downloadText("cookie-payout-plan.json", planJson({ sender: wallet.publicKey.toBase58(), recipients: parsed.recipients }), "application/json")}><Icon name="download" size={15} />Download plan before paying</button></div>
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
          <div className="recipient-preview">
            <div className="preview-title"><strong>List preview</strong><span>{parsed.recipients.length ? `${parsed.recipients.length} valid row${parsed.recipients.length === 1 ? "" : "s"}` : "Awaiting your list"}</span></div>
            {parsed.recipients.length ? <>
              <ul className="preview-list">{parsed.recipients.slice(0,5).map((recipient,index) => <li key={recipient.address}>
                <span className="recipient-person"><span className="recipient-avatar">{String(index+1).padStart(2,"0")}</span><span className="mono" title={recipient.address}>{short(recipient.address,6,6)}</span></span>
                <strong>{formatCook(recipient.units)} <span className="muted">COOK</span></strong>
              </li>)}</ul>
              {parsed.recipients.length > 5 && <p className="hint">+ {parsed.recipients.length-5} more recipients in the list above.</p>}
            </> : <div className="recipient-empty"><Icon name="file" size={27} /><span><strong>Your recipients will appear here</strong>Paste a list above to review addresses and amounts.</span></div>}
          </div>
        </section>

        <section className="card wallet-panel">
          <div className="card-heading"><h2><span className="icon-box"><Icon name="wallet" size={18} /></span>Funding wallet</h2><span className="card-caption">02 / CONNECT</span></div>
          {!wallet ? (
            <>
              <div className="wallet-illustration"><span className="wallet-symbol"><Icon name="wallet" size={23} /></span><span><strong>Make it your payout</strong><small>Connect a Nightly SVM account</small></span></div>
              <p className="hint">
                Your wallet signs the transactions. Larger payouts may need more than one approval.
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
                      <Icon name="wallet" size={16} />{connecting ? "Connecting…" : `Connect ${p.name}`}
                    </button>
                  ))}
                </div>
              )}
              {providers.length > 0 && !providers.some(p => p.kind === "nightly") && (
                <p className="note">Nightly is not detected in this browser. <a href="https://nightly.app/" target="_blank" rel="noreferrer">Install or enable Nightly</a> to connect with it.</p>
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
          <div className="wallet-guides"><a href="https://docs.cookiechain.wtf/wallets" target="_blank" rel="noreferrer">Wallet setup <Icon name="external" size={12} /></a><a href="https://docs.cookiechain.wtf/bridge" target="_blank" rel="noreferrer">Get native COOK <Icon name="external" size={12} /></a></div>
          {walletError && <p className="note bad" role="alert">{walletError}</p>}
          {previewError && <p className="note bad" role="alert">{previewError}</p>}
        </section>

        <section className="card send-panel">
          <div className="card-heading"><h2><span className="icon-box"><Icon name="send" size={18} /></span>Review & pay</h2><span className="card-caption">03 / APPROVE</span></div>
          <div className="payment-total"><span>{fee !== null ? "Total including network fee" : "Payout amount · fee pending"}</span><strong>{formatCook(fee !== null ? needed : total)} <small>COOK</small></strong></div>
          <motion.button
            className="primary big"
            disabled={!!blocker}
            aria-describedby="payout-blocker"
            onClick={onSend}
            whileTap={{ scale: 0.995 }}
          >
            <Icon name="send" size={17} />
            {running
              ? "Sending…"
              : `Pay ${parsed.recipients.length} recipient${parsed.recipients.length === 1 ? "" : "s"}`}
          </motion.button>
          <p className="hint" id="payout-blocker" style={{ marginTop: 12 }}>{blocker ?? "Review the full list, total and fee above. You approve each required transaction in your wallet."}</p>
          <div className="payment-security"><Icon name="shield" size={14} />You approve each required transaction in your wallet.</div>

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
    <main className="instrument receipt-page">
      <div className="workspace-heading"><div><p className="eyebrow">Payment evidence</p><h1>A receipt you can check.</h1><p>Native transfers, read directly from Cookie Chain.</p></div><a className="button-link" href={`#/audit/${signatures.join(".")}`}><Icon name="compare" size={17} />Compare with a plan</a></div>
      {readError && <p className="note bad" role="alert">{readError} <button onClick={() => { setTxs(null); setReadError(null); setReadAttempt(n => n + 1); }}>Read again</button></p>}

      <motion.div
        className="sheet-wrap receipt-stage"
        hidden={!!readError}
        initial={reduce ? {} : { opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
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

          {txs && <span className={`stamp ${allGood ? "pos" : "neg"}`}><Icon name={allGood ? "check" : "info"} size={14} />{allGood ? "Observed on chain" : "Review required"}</span>}
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
