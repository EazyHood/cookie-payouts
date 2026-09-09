import { useMemo, useRef, useState } from "react";
import { explorerAddress, explorerTx, formatCook, isValidAddress, verifyChain } from "./chain";
import { parseRecipients } from "./payout";
import { MAX_RECEIPT_CHARACTERS, receiptUrl, validateReceiptSignatures, verifyAll, type VerifiedTx } from "./receipt";
import { reconcilePayout, reconciliationCsv, type PayoutPlan } from "./reconcile";
import { downloadText, planJson, readPlan } from "./plan";
import { Icon } from "./Icon";
import "./AuditView.css";

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
  const signatureCount = useMemo(() => signaturesText.length <= MAX_RECEIPT_CHARACTERS
    ? new Set(signaturesText.trim().split(/[\s,.]+/).filter(Boolean)).size : null, [signaturesText]);

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
    <header className="audit-header">
      <div>
        <p className="audit-eyebrow">Payment operations</p>
        <h1 className="audit-title">Reconcile payouts</h1>
        <p className="audit-description">Check the right recipients received the right amounts of COOK.</p>
      </div>
      <div className="audit-header-actions">
        <span className="audit-mode"><Icon name="shield" size={15} /> Read-only workspace</span>
        <button type="button" onClick={() => importedFile.current?.click()} disabled={busy}>
          <Icon name="upload" size={16} /> Import payout plan
        </button>
      </div>
    </header>

    <input ref={importedFile} className="audit-sr-only" type="file" tabIndex={-1} accept=".json,application/json" aria-label="Import payout plan JSON"
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

    <section className={`audit-reference ${example ? "audit-reference-loaded" : ""}`} aria-label="Public chain example">
      <span className="audit-reference-icon"><Icon name="file" size={21} /></span>
      <div className="audit-reference-copy">
        <div className="audit-reference-heading"><h2>Start with a real transaction</h2><span className="audit-tag">External reference</span></div>
        <p>{example ? "Example loaded. Check 100 COOK, then change the expected amount to 101 to reveal a shortfall."
          : "Load a public 100 COOK transfer to see how a comparison works. No wallet needed."}</p>
        {example && <p className="audit-reference-disclosure">Not an app-generated payout; its purpose and authorship are not asserted. <a href={explorerTx(REFERENCE.signature)} target="_blank" rel="noreferrer">Original transaction <Icon name="external" size={12} /></a></p>}
      </div>
      <button type="button" className="audit-reference-button" onClick={loadReference} disabled={busy}>
        {example ? "Reload example" : "Load example"}<Icon name="arrow" size={16} />
      </button>
    </section>

    <form id="audit-form" onSubmit={audit} className="audit-form" aria-busy={busy}>
      <section className="card audit-panel" aria-labelledby="audit-plan-heading">
        <div className="audit-panel-heading">
          <span className="audit-step">01</span>
          <div><h2 id="audit-plan-heading">Comparison plan</h2><p>What should have been paid.</p></div>
          <Icon name="users" size={19} />
        </div>
        <div className="audit-field">
          <label htmlFor="audit-sender">Expected sender <span>Required</span></label>
          <input id="audit-sender" autoComplete="off" spellCheck={false} value={sender} disabled={busy}
            onChange={e => { setSender(e.target.value); changed(); }} placeholder="Full Cookie Chain address" />
        </div>
        <div className="audit-field">
          <label htmlFor="audit-list">Recipients and amounts <span>COOK</span></label>
          <textarea id="audit-list" rows={6} spellCheck={false} autoComplete="off" value={list} disabled={busy}
            placeholder="address, amount" aria-describedby={`audit-list-help${parsed.errors.length ? " audit-list-errors" : ""}`}
            aria-invalid={!!list && parsed.errors.length > 0}
            onChange={e => { setList(e.target.value); changed(); }} />
          <p className="audit-helper" id="audit-list-help">One address and amount per line. Use the list you intended to pay.</p>
          {!!list && parsed.errors.length > 0 && <ul className="audit-errors" id="audit-list-errors">{parsed.errors.map(e => <li key={e.line}>Line {e.line}: {e.reason}</li>)}</ul>}
        </div>
        <div className="audit-plan-totals" aria-label="Parsed comparison plan">
          <div><span>Recipients parsed</span><strong>{list.trim() ? parsed.recipients.length : "—"}</strong></div>
          <div><span>Expected total</span><strong>{list.trim() ? formatCook(parsed.total) : "—"}<small>COOK</small></strong></div>
        </div>
        {parsed.errors.length > 0 && <p className="audit-helper">Totals include valid rows only. Fix every line before comparing.</p>}
      </section>

      <section className="card audit-panel audit-evidence-panel" aria-labelledby="audit-evidence-heading">
        <div className="audit-panel-heading">
          <span className="audit-step">02</span>
          <div><h2 id="audit-evidence-heading">Transaction evidence</h2><p>What to read from Cookie Chain.</p></div>
          <Icon name="receipt" size={19} />
        </div>
        <div className="audit-field audit-signature-field">
          <label htmlFor="audit-signatures">Transaction signatures <span>Up to 50</span></label>
          <textarea id="audit-signatures" rows={8} spellCheck={false} autoComplete="off" value={signaturesText} disabled={busy}
            placeholder="One signature per line" aria-describedby="audit-signatures-help"
            onChange={e => { setSignaturesText(e.target.value); changed(); }} />
          <p className="audit-helper audit-signature-help" id="audit-signatures-help"><span>Repeated signatures count once.</span><span>{signatureCount === null ? "Input too large" : `${signatureCount} entered`}</span></p>
        </div>
        <div className="audit-submit-area">
          <div className="audit-read-assurance"><Icon name="shield" size={17} /><p>No wallet connection or signing. Only the signatures you check are sent to the RPC.</p></div>
          <button type="submit" className="primary audit-submit" disabled={busy}><Icon name={busy ? "clock" : "compare"} size={18} />{busy ? "Reading Cookie Chain…" : "Compare with the chain"}<Icon name="arrow" size={17} /></button>
        </div>
      </section>
    </form>

    {error && <div className="audit-error-banner" role="alert"><Icon name="info" size={20} /><div><strong>Comparison wasn't completed</strong><p>{error}</p><span>Your inputs are still here. Review them and compare again.</span></div></div>}

    {!result && <section className={`card audit-empty-report ${busy ? "audit-report-loading" : ""}`} aria-live="polite" aria-busy={busy}>
      <div className="audit-empty-icon"><Icon name={busy ? "clock" : "compare"} size={24} /></div>
      <div><p className="audit-eyebrow">Reconciliation report</p><h2>{busy ? "Reading chain evidence" : "Your comparison starts here"}</h2>
        <p>{busy ? "Checking the network and each transaction. Your inputs are preserved while the reads finish." : "Add your plan and transaction signatures, then compare to find missing, extra or mismatched amounts."}</p></div>
      {busy && <div className="audit-loading-lines" aria-hidden="true"><span /><span /><span /></div>}
    </section>}

    {result && reconciliation && <section className="card audit-report" aria-live="polite">
      <div className="audit-report-heading">
        <div><p className="audit-eyebrow">Reconciliation report</p><h2>{reconciliation.complete ? "Native transfers match this plan" : "This payout needs review"}</h2></div>
        <span className={`audit-verdict ${reconciliation.complete ? "audit-verdict-match" : "audit-verdict-review"}`}><Icon name={reconciliation.complete ? "check" : "info"} size={16} />{reconciliation.complete ? "Match" : "Review required"}</span>
      </div>
      <div className="audit-stats">
        <div className="audit-stat"><span>Expected amount</span><strong>{formatCook(reconciliation.totals.expected)}<small>COOK</small></strong><p>From your comparison plan</p></div>
        <div className="audit-stat"><span>Observed amount</span><strong>{formatCook(reconciliation.totals.paid)}<small>COOK</small></strong><p>Native transfers from this sender</p></div>
        <div className={`audit-stat ${reconciliation.totals.delta !== 0n ? "audit-stat-difference" : ""}`}><span>Difference</span><strong>{formatCook(reconciliation.totals.delta)}<small>COOK</small></strong><p>Observed minus expected</p></div>
      </div>
      <div className="audit-report-counts">
        <span><Icon name="users" size={15} /><strong>{reconciliation.rows.length}</strong> recipient{reconciliation.rows.length === 1 ? "" : "s"} reviewed</span>
        <span className={reconciliation.unresolved ? "audit-count-warning" : ""}><Icon name="clock" size={15} /><strong>{reconciliation.unresolved}</strong> unresolved transaction{reconciliation.unresolved === 1 ? "" : "s"}</span>
        <span className={reconciliation.failed ? "audit-count-warning" : ""}><strong>{reconciliation.failed}</strong> failed transaction{reconciliation.failed === 1 ? "" : "s"}</span>
      </div>
      <div className="audit-table-wrap" tabIndex={0} role="region" aria-label="Recipient comparison; scroll horizontally to view every column"><table className="audit-table">
        <caption className="audit-sr-only">Expected and observed native COOK transfers by recipient</caption>
        <thead><tr><th>Recipient</th><th className="num">Expected COOK</th><th className="num">Observed COOK</th><th className="num">Difference</th><th>Status</th></tr></thead>
        <tbody>{reconciliation.rows.map(row => <tr key={row.address}>
          <td><a className="audit-address" href={explorerAddress(row.address)} target="_blank" rel="noreferrer" title={row.address} aria-label={`View address ${row.address}`}>{row.address.slice(0,8)}…{row.address.slice(-8)}<Icon name="external" size={12} /></a></td>
          <td className="num">{formatCook(row.expected)}</td><td className="num">{formatCook(row.paid)}</td><td className={`num ${row.delta !== 0n ? "audit-delta" : ""}`}>{formatCook(row.delta)}</td>
          <td><span className={`audit-row-status ${row.status === "paid" ? "audit-row-match" : "audit-row-review"}`}>{row.status === "paid" && <Icon name="check" size={12} />}{row.status === "paid" ? "Matches" : row.status}</span></td>
        </tr>)}</tbody>
      </table></div>
      {reconciliation.unresolved > 0 && <p className="audit-result-warning"><Icon name="info" size={17} />Some transactions are missing or could not be read. These amounts are partial observations; resolve unknown transactions before resending.</p>}
      {!reconciliation.complete && reconciliation.totals.delta === 0n && <p className="audit-helper audit-report-note">Equal totals do not mean every recipient was paid correctly. Review the individual rows and unresolved transactions.</p>}
      {!!reconciliation.ignoredTransfers && <p className="audit-helper audit-report-note">{reconciliation.ignoredTransfers} transfer(s) from other senders were excluded.</p>}
      <div className="audit-report-footer">
        <div className="audit-read-time"><Icon name="clock" size={14} /><span>Read {new Date(result.readAt).toUTCString()} · Confirmed</span></div>
        <div className="audit-export-actions">
          <button type="button" onClick={() => downloadText("cookie-payout-reconciliation.csv", reconciliationCsv(reconciliation), "text/csv;charset=utf-8")}><Icon name="download" size={16} />Export reconciliation CSV</button>
          <button type="button" onClick={() => downloadText("cookie-payout-plan.json", planJson(result.plan), "application/json")}><Icon name="file" size={16} />Download comparison plan</button>
          <a className="button-link audit-receipt-action" href={receiptUrl(result.txs.map(t => t.signature))}>Open transaction receipt<Icon name="arrow" size={16} /></a>
        </div>
        <p className="audit-helper">This compares native transfer instructions, not net balance changes, identity or an authenticated prior agreement. Confirmed is not finalized; finality may still change.</p>
      </div>
    </section>}

    <div className="audit-scope"><Icon name="info" size={15} /><p>Your comparison plan is supplied by you and is not authenticated by the chain. Native COOK only. The public example demonstrates reading and reconciliation, not Nightly signing or an end-to-end payment by this app.</p></div>
  </main>;
}
