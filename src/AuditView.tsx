import { useMemo, useRef, useState } from "react";
import { explorerTx, formatCook, isValidAddress, verifyChain } from "./chain";
import { parseRecipients } from "./payout";
import { MAX_RECEIPT_CHARACTERS, receiptUrl, validateReceiptSignatures, verifyAll, type VerifiedTx } from "./receipt";
import { reconcilePayout, reconciliationCsv, type PayoutPlan } from "./reconcile";
import { downloadText, planJson, readPlan } from "./plan";

// Public chain reference, NOT a payout created by this application.
const REFERENCE = {
  signature: "LiNmNJa4WxS7DG1zCZR7q6pwtiHRtM3zdXemP4Nkrk9crp2Cy4yZCFSLSoLTW95xX45wzccn74pUjejdArQv7aQ",
  sender: "BwwXgbiHMWqukbxzTjK9QJcp8EPBLc7hWo2A2e9xEsGt",
  recipient: "33n68Rpis2dGYv36xTHaxeMGvkwXDRJnxAHLmFn2o3J3",
};

export default function AuditView({ initialSignatures = [] }: { initialSignatures?: string[] }) {
  const [sender, setSender] = useState("");
  const [list, setList] = useState("");
  const [signaturesText, setSignaturesText] = useState(initialSignatures.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [example, setExample] = useState(false);
  const [result, setResult] = useState<{ plan: PayoutPlan; txs: VerifiedTx[]; readAt: string } | null>(null);
  const importedFile = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseRecipients(list), [list]);
  const reconciliation = useMemo(() => result ? reconcilePayout(result.plan, result.txs) : null, [result]);

  function changed() { setResult(null); setError(null); }
  function loadReference() {
    changed();
    setExample(true);
    setSender(REFERENCE.sender);
    setList(`${REFERENCE.recipient}, 100`);
    setSignaturesText(REFERENCE.signature);
  }

  async function audit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setResult(null);
    if (!isValidAddress(sender.trim())) { setError("Enter the expected sender's complete address."); return; }
    if (!parsed.recipients.length || parsed.errors.length) { setError("Fix the recipient list before checking the chain."); return; }
    let signatures: string[];
    try {
      if (signaturesText.length > MAX_RECEIPT_CHARACTERS) throw new Error("Signature input exceeds 5,000 characters. Check at most 50 transactions at a time.");
      signatures = validateReceiptSignatures(signaturesText.trim().split(/[\s,.]+/).filter(Boolean));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enter 1–50 complete transaction signatures.");
      return;
    }
    const plan: PayoutPlan = { sender: sender.trim(), recipients: parsed.recipients };
    setBusy(true);
    try {
      const chain = await verifyChain();
      if (!chain.ok) throw new Error("Could not verify Cookie Chain. Your inputs are preserved; try again.");
      const txs = await verifyAll(signatures);
      setResult({ plan, txs, readAt: new Date().toISOString() });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return <main className="instrument audit-workspace">
    <p className="rule">Payout reconciliation · no wallet required</p>
    <h1 className="audit-title">Did the right people get <em>the right amounts?</em></h1>
    <p className="lede">Compare the original list with native COOK transfers read from Cookie Chain.
      Find missing amounts, extra transfers and payments from a different sender before closing the books.</p>
    <div className="btnrow audit-actions">
      <button onClick={loadReference} disabled={busy}>Load a public chain example</button>
      <button onClick={() => importedFile.current?.click()} disabled={busy}>Import payout plan</button>
      <input ref={importedFile} className="visually-hidden" type="file" accept=".json,application/json" aria-label="Import payout plan JSON"
        onChange={async e => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!file) return;
          changed();
          try {
            if (file.size > 50_000) throw new Error("Plan file is too large (50 KB maximum).");
            const plan = readPlan(await file.text());
            setSender(plan.sender); setList(plan.recipientsText); setExample(false);
          } catch (e) { setError(e instanceof Error ? e.message : "Could not read the plan."); }
        }} />
    </div>
    {example && <p className="note reference-note">
      <strong>External reference, not an app-generated payout.</strong> This public transaction contains a native
      transfer of 100 COOK. Its purpose and authorship are not asserted here. Try checking 100, then change the
      expected amount to 101 to reveal a shortfall. <a href={explorerTx(REFERENCE.signature)} target="_blank" rel="noreferrer">View the original transaction →</a>
    </p>}

    <form onSubmit={audit} className="grid audit-form" aria-busy={busy}>
      <section className="card">
        <h2><span className="step">01</span> What should have been paid</h2>
        <label htmlFor="audit-sender">Expected sender</label>
        <input id="audit-sender" autoComplete="off" spellCheck={false} value={sender} disabled={busy}
          onChange={e => { setSender(e.target.value); changed(); }} placeholder="Full Cookie Chain address" />
        <label htmlFor="audit-list">Expected recipients and COOK amounts</label>
        <textarea id="audit-list" rows={6} spellCheck={false} autoComplete="off" value={list} disabled={busy}
          placeholder="address, amount" aria-describedby="audit-list-help"
          onChange={e => { setList(e.target.value); changed(); }} />
        <p className="hint" id="audit-list-help">One address and amount per line. This is your comparison plan, not a promise authenticated by the chain.</p>
        {!!list && parsed.errors.length > 0 && <ul className="errors">{parsed.errors.map(e => <li key={e.line}>Line {e.line}: {e.reason}</li>)}</ul>}
      </section>
      <section className="card">
        <h2><span className="step">02</span> What to read from the chain</h2>
        <label htmlFor="audit-signatures">Transaction signatures</label>
        <textarea id="audit-signatures" rows={8} spellCheck={false} autoComplete="off" value={signaturesText} disabled={busy}
          placeholder="One signature per line" onChange={e => { setSignaturesText(e.target.value); changed(); }} />
        <p className="hint">Reads only. No signing, transfers or wallet connection. The RPC receives the signatures you check.</p>
        <button type="submit" className="primary big" disabled={busy}>{busy ? "Reading Cookie Chain…" : "Compare with the chain"}</button>
      </section>
    </form>
    {error && <p className="note bad" role="alert">{error}</p>}
    {busy && <p className="note" role="status">Checking the network and reading each transaction. Keep this page open.</p>}

    {result && reconciliation && <section className="card audit-report" aria-live="polite">
      <div className="report-heading">
        <div><p className="eyebrow">Reconciliation result</p><h2>{reconciliation.complete ? "Native transfers match this plan" : "This payout needs review"}</h2></div>
        <span className={`badge ${reconciliation.complete ? "ok" : "bad"}`}>{reconciliation.complete ? "Match" : "Review required"}</span>
      </div>
      <div className="tally">
        <div><span className="n">{formatCook(reconciliation.totals.expected)}</span><span className="l">COOK expected</span></div>
        <div><span className="n">{formatCook(reconciliation.totals.paid)}</span><span className="l">COOK from this sender</span></div>
        <div><span className="n">{reconciliation.unresolved}</span><span className="l">unresolved transactions</span></div>
        <div><span className="n">{reconciliation.failed}</span><span className="l">failed transactions</span></div>
      </div>
      <div className="table-scroll"><table>
        <caption className="visually-hidden">Expected and observed transfers by recipient</caption>
        <thead><tr><th>Recipient</th><th className="num">Expected COOK</th><th className="num">Observed COOK</th><th>Status</th></tr></thead>
        <tbody>{reconciliation.rows.map(row => <tr key={row.address}>
          <td className="mono" title={row.address}>{row.address.slice(0,8)}…{row.address.slice(-8)}</td>
          <td className="num">{formatCook(row.expected)}</td><td className="num">{formatCook(row.paid)}</td>
          <td><span className={`result-status ${row.status === "paid" ? "ok" : "bad"}`}>{row.status === "paid" ? "matches" : row.status}</span></td>
        </tr>)}</tbody>
      </table></div>
      {reconciliation.unresolved > 0 && <p className="note bad">Some transactions are missing or could not be read. Listed amounts are partial observations; do not resend until those transactions are resolved.</p>}
      {!!reconciliation.ignoredTransfers && <p className="note">{reconciliation.ignoredTransfers} transfer(s) from other senders were excluded.</p>}
      <p className="hint">Read {new Date(result.readAt).toUTCString()} at confirmed commitment. This compares native transfer instructions, not net account balance changes, identity or an authenticated prior agreement. Finality may still change.</p>
      <div className="btnrow">
        <button onClick={() => downloadText("cookie-payout-reconciliation.csv", reconciliationCsv(reconciliation), "text/csv;charset=utf-8")}>Export reconciliation CSV</button>
        <button onClick={() => downloadText("cookie-payout-plan.json", planJson(result.plan), "application/json")}>Download comparison plan</button>
        <a className="button-link" href={receiptUrl(result.txs.map(t => t.signature))}>Open transaction receipt →</a>
      </div>
    </section>}
    <p className="note scope-note">Native COOK only. The public example tests reading and reconciliation; it does not demonstrate Nightly signing or an end-to-end payment by this app.</p>
  </main>;
}
