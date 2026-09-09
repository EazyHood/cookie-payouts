import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  connection,
  explorerAddress,
  explorerTx,
  formatCook,
  verifyChain,
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

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const receiptMatch = hash.match(/^#\/receipt\/(.+)$/);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">Cookie Payouts</span>
          <span className="tag">Pay many, prove it once</span>
        </div>
        <ChainBadge />
      </header>

      {receiptMatch ? (
        <ReceiptView encoded={decodeURIComponent(receiptMatch[1])} />
      ) : (
        <PayoutView />
      )}

      <footer className="foot">
        <p>
          Built on Cookie Chain · RPC <code>{RPC_URL}</code> ·{" "}
          <a href="https://github.com/EazyHood/cookie-payouts" target="_blank" rel="noreferrer">
            source
          </a>
        </p>
        <p className="muted">
          Receipts are verified in your browser straight from the chain. Nothing is stored on a
          server, so there is no copy of these numbers that anyone could have edited.
        </p>
      </footer>
    </div>
  );
}

function ChainBadge() {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    verifyChain().then((r) => {
      if (r.ok) setState({ ok: true, text: "Cookie Chain" });
      else if (r.genesis) setState({ ok: false, text: "wrong chain" });
      else setState({ ok: false, text: "RPC unreachable" });
    });
  }, []);
  if (!state) return <span className="badge pending">checking chain…</span>;
  return (
    <span className={`badge ${state.ok ? "ok" : "bad"}`} title="Verified with getGenesisHash">
      {state.ok ? "✓ " : "✕ "}
      {state.text}
    </span>
  );
}

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

  // Rebuild batches whenever the list or the payer changes, so the count of
  // transactions and the fee shown always describe what pressing send will do.
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
  const short = balance !== null && needed > balance;

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
      // Refresh the blockhash immediately before signing: one taken minutes ago
      // while the operator edited the list may already be too old to land.
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
          // Send the raw signed bytes through the Cookie Chain RPC ourselves —
          // see the note in wallet.ts about wallets that broadcast elsewhere.
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

  const done = statuses.length > 0 && statuses.every((s) => s.state === "confirmed" || s.state === "failed");

  return (
    <main className="grid">
      <section className="card">
        <h2>1 · The list</h2>
        <p className="hint">
          One line per recipient: address, then the amount in COOK. Every line that cannot be read is
          listed below with its number — nothing is skipped quietly.
        </p>
        <textarea
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          rows={12}
          aria-label="Recipients"
        />
        <div className="rowsummary">
          <span>
            <strong>{parsed.recipients.length}</strong> recipients
          </span>
          <span>
            <strong>{formatCook(total)}</strong> COOK
          </span>
          {batches.length > 0 && (
            <span>
              <strong>{batches.length}</strong> transaction{batches.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {parsed.errors.length > 0 && (
          <ul className="errors">
            {parsed.errors.map((e) => (
              <li key={e.line}>
                <span className="ln">line {e.line}</span> {e.reason}
                <code>{e.text.slice(0, 60)}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>2 · The wallet</h2>
        {!wallet ? (
          <>
            {providers.length === 0 ? (
              <p className="hint">
                No Solana wallet detected. This app is built for{" "}
                <a href="https://nightly.app/" target="_blank" rel="noreferrer">
                  Nightly
                </a>
                ; install it and reload.
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
            {walletError && <p className="bad">{walletError}</p>}
          </>
        ) : (
          <>
            <dl className="kv">
              <dt>Connected</dt>
              <dd>
                <a href={explorerAddress(wallet.publicKey.toBase58())} target="_blank" rel="noreferrer">
                  {wallet.publicKey.toBase58()}
                </a>{" "}
                <span className="muted">via {wallet.name}</span>
              </dd>
              <dt>Balance</dt>
              <dd>{balance === null ? "—" : `${formatCook(balance)} COOK`}</dd>
              <dt>Payout</dt>
              <dd>{formatCook(total)} COOK</dd>
              <dt>Network fee</dt>
              <dd>{fee === null ? "estimating…" : `${formatCook(fee)} COOK`}</dd>
            </dl>
            {short && (
              <p className="bad">
                Short by {formatCook(needed - (balance ?? 0n))} COOK. Nothing has been sent.
              </p>
            )}
          </>
        )}
      </section>

      <section className="card wide">
        <h2>3 · Send and prove it</h2>
        <button
          className="primary big"
          disabled={!wallet || batches.length === 0 || running || short}
          onClick={onSend}
        >
          {running
            ? "Sending…"
            : `Pay ${parsed.recipients.length} recipient${parsed.recipients.length === 1 ? "" : "s"}`}
        </button>

        {statuses.length > 0 && (
          <ol className="batches">
            {statuses.map((s, i) => (
              <li key={i} className={s.state}>
                <span className="bn">
                  batch {i + 1} · {batches[i]?.recipients.length ?? 0} transfers
                </span>
                <StatusLabel s={s} />
              </li>
            ))}
          </ol>
        )}

        {done && signatures.length > 0 && <ReceiptLink signatures={signatures} />}
      </section>
    </main>
  );
}

function StatusLabel({ s }: { s: BatchStatus }) {
  switch (s.state) {
    case "waiting":
      return <span className="muted">waiting</span>;
    case "signing":
      return <span className="muted">waiting for your signature…</span>;
    case "sending":
      return <span className="muted">sending…</span>;
    case "confirming":
      return (
        <a href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
          confirming…
        </a>
      );
    case "confirmed":
      return (
        <a className="ok" href={explorerTx(s.signature)} target="_blank" rel="noreferrer">
          ✓ confirmed
        </a>
      );
    case "failed":
      return (
        <span className="bad">
          ✕ {s.error}
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
    <div className="receipt-out">
      <h3>Receipt</h3>
      <p className="hint">
        Anyone who opens this link re-reads these transactions from Cookie Chain in their own
        browser. It is not a screenshot and it is not stored anywhere — it can also come back saying
        a transfer failed.
      </p>
      <div className="copyrow">
        <input ref={ref} readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
            } catch {
              ref.current?.select();
              document.execCommand?.("copy");
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p>
        <a href={url}>Open the receipt →</a>
      </p>
    </div>
  );
}

function ReceiptView({ encoded }: { encoded: string }) {
  const signatures = useMemo(() => decodeReceipt(encoded), [encoded]);
  const [txs, setTxs] = useState<VerifiedTx[] | null>(null);

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

  if (!txs) {
    return (
      <main className="grid">
        <section className="card wide">
          <h2>Verifying against Cookie Chain…</h2>
          <p className="hint">Reading {signatures.length} transaction(s) from {RPC_URL}</p>
        </section>
      </main>
    );
  }

  const s = summarize(txs);
  // `paid` counts confirmed transactions, and a transaction can confirm while
  // moving no COOK at all — the first real transaction I checked did exactly
  // that. Requiring recipients as well is what stops this badge from saying
  // "verified" over a receipt that paid nobody.
  const allGood = s.failed === 0 && s.missing === 0 && s.paid > 0 && s.recipients > 0;

  return (
    <main className="grid">
      <section className="card wide">
        <h2>
          Receipt{" "}
          <span className={`badge ${allGood ? "ok" : "bad"}`}>
            {allGood ? "✓ verified on chain" : "✕ not fully verified"}
          </span>
        </h2>
        <dl className="kv">
          <dt>Paid</dt>
          <dd>
            <strong>{formatCook(s.total)} COOK</strong> to {s.recipients} recipient
            {s.recipients === 1 ? "" : "s"}
          </dd>
          <dt>Transactions</dt>
          <dd>
            {s.paid} confirmed
            {s.failed > 0 && <span className="bad"> · {s.failed} failed</span>}
            {s.missing > 0 && <span className="bad"> · {s.missing} not found on chain</span>}
          </dd>
          <dt>Fees paid</dt>
          <dd>{formatCook(s.fees)} COOK</dd>
        </dl>
        {!allGood && (
          <p className="bad">
            {s.recipients === 0 && s.failed === 0 && s.missing === 0
              ? "These transactions are on chain and confirmed, but none of them moved any COOK. This is not a payout receipt."
              : "This receipt does not fully check out. Every line below was read from the chain just now; treat anything marked failed or missing as unpaid."}
          </p>
        )}
      </section>

      {txs.map((t) => (
        <section className="card wide" key={t.signature}>
          <h3 className={t.found && t.succeeded ? "ok" : "bad"}>
            {t.found ? (t.succeeded ? "✓ confirmed" : "✕ failed on chain") : "✕ not found on chain"}
          </h3>
          <p className="mono small">
            <a href={explorerTx(t.signature)} target="_blank" rel="noreferrer">
              {t.signature}
            </a>
          </p>
          {t.from && (
            <p className="small muted">
              from <a href={explorerAddress(t.from)} target="_blank" rel="noreferrer">{t.from}</a>
              {t.slot ? ` · slot ${t.slot.toLocaleString("en-US")}` : ""}
              {t.blockTime ? ` · ${new Date(t.blockTime * 1000).toUTCString()}` : ""}
            </p>
          )}
          {t.error && <p className="bad small">{t.error}</p>}
          {t.found && t.succeeded && t.transfers.length === 0 && (
            <p className="bad small">
              This transaction confirmed, but it contains no native COOK transfers. It is on chain
              and it paid nobody in COOK — do not read it as a payout.
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
                {t.transfers.map((tr, i) => (
                  <tr key={i}>
                    <td className="mono small">
                      <a href={explorerAddress(tr.to)} target="_blank" rel="noreferrer">
                        {tr.to}
                      </a>
                    </td>
                    <td className="num">{formatCook(tr.units)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      <section className="card wide">
        <a href="#/">← Make another payout</a>
      </section>
    </main>
  );
}
