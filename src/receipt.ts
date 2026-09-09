import { connection } from "./chain";

/**
 * The receipt is the point of this app.
 *
 * A payout screenshot proves nothing — it is an image of a claim. A receipt here
 * is a link that carries only transaction signatures; whoever opens it re-reads
 * those transactions from the Cookie Chain RPC in their own browser and sees who
 * was actually paid. Nothing is stored on a server, so there is no copy of the
 * numbers that the person who published the link could have edited.
 *
 * That means a receipt can also come back NEGATIVE: if a signature is not on
 * chain, or the transfer failed, the page says so. A receipt that can only ever
 * say "paid" would be decoration.
 */

export interface VerifiedTransfer {
  to: string;
  units: bigint;
}

export interface VerifiedTx {
  signature: string;
  found: boolean;
  succeeded: boolean;
  slot?: number;
  blockTime?: number | null;
  from?: string;
  fee?: bigint;
  transfers: VerifiedTransfer[];
  error?: string;
}

export function encodeReceipt(signatures: string[]): string {
  return signatures.join(".");
}

export function decodeReceipt(encoded: string): string[] {
  return encoded
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function receiptUrl(signatures: string[]): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/receipt/${encodeReceipt(signatures)}`;
}

/** Read one transaction back from the chain and extract its native transfers. */
export async function verifyOne(signature: string): Promise<VerifiedTx> {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) {
      return { signature, found: false, succeeded: false, transfers: [] };
    }

    const transfers: VerifiedTransfer[] = [];
    let from: string | undefined;

    const collect = (ix: unknown) => {
      if (!ix || typeof ix !== "object" || !("parsed" in ix)) return;
      const parsed = (ix as { parsed?: { type?: string; info?: Record<string, unknown> } }).parsed;
      if (parsed?.type !== "transfer") return;
      const info = parsed.info || {};
      const dest = info.destination;
      const src = info.source;
      const lamports = info.lamports;
      if (typeof dest === "string" && (typeof lamports === "number" || typeof lamports === "string")) {
        transfers.push({ to: dest, units: BigInt(lamports) });
        if (typeof src === "string") from = src;
      }
    };

    // Top-level instructions cover the payouts this app builds. Inner
    // instructions matter because a transfer made through a CPI — which is what
    // most programs on this chain actually do — appears nowhere else. Reading
    // only the top level made a real Cookie Chain transaction come back as
    // "confirmed" with zero transfers, which reads as a verified receipt for
    // nothing. Checked against live transactions, not against this app's own
    // output.
    for (const ix of tx.transaction.message.instructions) collect(ix);
    for (const group of tx.meta?.innerInstructions ?? []) {
      for (const ix of group.instructions) collect(ix);
    }

    return {
      signature,
      found: true,
      succeeded: tx.meta?.err == null,
      slot: tx.slot,
      blockTime: tx.blockTime,
      from,
      fee: tx.meta?.fee != null ? BigInt(tx.meta.fee) : undefined,
      transfers,
      error: tx.meta?.err ? JSON.stringify(tx.meta.err) : undefined,
    };
  } catch (e) {
    return {
      signature,
      found: false,
      succeeded: false,
      transfers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function verifyAll(signatures: string[]): Promise<VerifiedTx[]> {
  const out: VerifiedTx[] = [];
  for (const s of signatures) out.push(await verifyOne(s));
  return out;
}

export interface ReceiptSummary {
  total: bigint;
  recipients: number;
  paid: number;
  failed: number;
  missing: number;
  fees: bigint;
}

export function summarize(txs: VerifiedTx[]): ReceiptSummary {
  let total = 0n;
  let recipients = 0;
  let paid = 0;
  let failed = 0;
  let missing = 0;
  let fees = 0n;
  for (const t of txs) {
    if (!t.found) {
      missing++;
      continue;
    }
    if (!t.succeeded) {
      failed++;
      continue;
    }
    paid++;
    fees += t.fee ?? 0n;
    for (const tr of t.transfers) {
      total += tr.units;
      recipients++;
    }
  }
  return { total, recipients, paid, failed, missing, fees };
}
