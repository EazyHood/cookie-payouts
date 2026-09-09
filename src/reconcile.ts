import { deduplicateTransactions, verificationStatus, type VerifiedTx } from "./receipt";

export interface PayoutPlan {
  sender: string;
  recipients: { address: string; units: bigint }[];
}

export type ReconciliationStatus = "paid" | "missing" | "underpaid" | "overpaid" | "unexpected";

export interface ReconciliationRow {
  address: string;
  expected: bigint;
  paid: bigint;
  /** Observed minus expected; a negative number is a shortfall. */
  delta: bigint;
  status: ReconciliationStatus;
}

export interface ReconciliationResult {
  rows: ReconciliationRow[];
  totals: { expected: bigint; paid: bigint; delta: bigint };
  complete: boolean;
  /** Includes signatures not found, RPC errors and incomplete parsing. */
  unresolved: number;
  failed: number;
  /** Native transfers by other senders, excluded from all paid amounts. */
  ignoredTransfers: number;
}

/**
 * Compare a user-supplied expectation with the supplied chain observations.
 * This does not prove who authored a plan, search all chain history, or establish
 * that a transfer was made for this particular plan rather than another purpose.
 */
export function reconcilePayout(plan: PayoutPlan, txs: VerifiedTx[]): ReconciliationResult {
  if (!plan.sender.trim()) throw new Error("A plan needs a sender address.");
  const expected = new Map<string, bigint>();
  for (const recipient of plan.recipients) {
    if (!recipient.address.trim() || typeof recipient.units !== "bigint" || recipient.units <= 0n) {
      throw new Error("Every planned recipient needs an address and a positive amount in base units.");
    }
    expected.set(recipient.address, (expected.get(recipient.address) ?? 0n) + recipient.units);
  }
  const observed = new Map<string, bigint>();
  let unresolved = 0, failed = 0, ignoredTransfers = 0;
  for (const tx of deduplicateTransactions(txs)) {
    const status = verificationStatus(tx);
    if (status === "failed") { failed++; continue; }
    if (status !== "confirmed") { unresolved++; continue; }
    let invalidTransfer = false;
    for (const transfer of tx.transfers) {
      if (!transfer.from || !transfer.to || typeof transfer.units !== "bigint" || transfer.units < 0n) {
        invalidTransfer = true;
        continue;
      }
      if (transfer.from !== plan.sender) { ignoredTransfers++; continue; }
      if (transfer.units === 0n) continue;
      observed.set(transfer.to, (observed.get(transfer.to) ?? 0n) + transfer.units);
    }
    if (invalidTransfer) unresolved++;
  }
  const addresses = new Set([...expected.keys(), ...observed.keys()]);
  const rows: ReconciliationRow[] = [...addresses].map((address) => {
    const due = expected.get(address) ?? 0n;
    const paid = observed.get(address) ?? 0n;
    const status: ReconciliationStatus = !expected.has(address) ? "unexpected"
      : paid === 0n ? "missing" : paid < due ? "underpaid" : paid > due ? "overpaid" : "paid";
    return { address, expected: due, paid, delta: paid - due, status };
  });
  const totals = rows.reduce((sum, row) => ({
    expected: sum.expected + row.expected,
    paid: sum.paid + row.paid,
    delta: sum.delta + row.delta,
  }), { expected: 0n, paid: 0n, delta: 0n });
  return {
    rows, totals, unresolved, failed, ignoredTransfers,
    complete: rows.length > 0 && unresolved === 0 && failed === 0 && rows.every((row) => row.status === "paid"),
  };
}

/** RFC 4180 escaping plus spreadsheet-formula neutralization for free text. */
function csvText(value: string): string {
  // Control characters can precede a spreadsheet formula after CSV import.
  // eslint-disable-next-line no-control-regex
  const safe = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function reconciliationCsv(result: ReconciliationResult): string {
  const header = "address,expected_base_units,paid_base_units,delta_base_units,status";
  return [header, ...result.rows.map((row) => [
    csvText(row.address), row.expected.toString(), row.paid.toString(), row.delta.toString(), csvText(row.status),
  ].join(","))].join("\r\n") + "\r\n";
}
