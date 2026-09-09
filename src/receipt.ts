import bs58 from "bs58";
import { RPC_URL } from "./chain";

/** Receipts re-read signatures from RPC; they do not authenticate a payout plan. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MAX_U64 = (1n << 64n) - 1n;
export const MAX_RECEIPT_SIGNATURES = 50;
export const MAX_RECEIPT_CHARACTERS = 5_000;
const READ_TIMEOUT_MS = 12_000;
const RECEIPT_TIMEOUT_MS = 30_000;

export interface VerifiedTransfer {
  from: string;
  to: string;
  units: bigint;
}

export type VerificationStatus = "confirmed" | "failed" | "not_found" | "rpc_error" | "unresolved";

export interface VerifiedTx {
  signature: string;
  found: boolean;
  succeeded: boolean;
  /** Optional for compatibility with receipts constructed by older callers. */
  status?: VerificationStatus;
  slot?: number;
  blockTime?: number | null;
  /** Set only when every observed native transfer has the same source. */
  from?: string;
  fee?: bigint;
  transfers: VerifiedTransfer[];
  error?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Never turn an already rounded JSON number into apparently exact evidence. */
function exactUnits(value: unknown): bigint | undefined {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return;
  if (typeof value !== "number" && !(typeof value === "string" && /^\d{1,20}$/.test(value))) return;
  const units = BigInt(value);
  return units <= MAX_U64 ? units : undefined;
}

function programId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const key = record(value);
  if (typeof key?.toBase58 !== "function") return;
  try {
    const encoded: unknown = key.toBase58();
    return typeof encoded === "string" ? encoded : undefined;
  } catch {
    return;
  }
}

export function encodeReceipt(signatures: string[]): string {
  return validateReceiptSignatures(signatures).join(".");
}

export function decodeReceipt(encoded: string): string[] {
  // Leave oversized input intact so verifyAll rejects it before any network
  // work, while decoding during React render remains non-throwing.
  if (encoded.length > MAX_RECEIPT_CHARACTERS) return [encoded];
  return [...new Set(encoded.split(".").map((signature) => signature.trim()).filter(Boolean))];
}

/** Reject the whole request; never silently skip a malformed or excess signature. */
export function validateReceiptSignatures(signatures: string[]): string[] {
  if (signatures.length > MAX_RECEIPT_CHARACTERS || signatures.some((s) => typeof s !== "string" || s.length > 100)) {
    throw new Error("Receipt input is too large or contains an invalid signature.");
  }
  const unique = [...new Set(signatures.map((s) => s.trim()).filter(Boolean))];
  if (!unique.length || unique.length > MAX_RECEIPT_SIGNATURES) {
    throw new Error("Enter 1–50 transaction signatures. Repeated signatures count once.");
  }
  if (unique.some((signature) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return true;
    try { return bs58.decode(signature).length !== 64; } catch { return true; }
  })) throw new Error("A transaction signature is invalid; use its complete base58 signature, not a URL.");
  return unique;
}

export function receiptUrl(signatures: string[]): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/receipt/${encodeReceipt(signatures)}`;
}

/** Parse the getParsedTransaction result, without a network call or wallet. */
export function parseVerifiedTransaction(signature: string, response: unknown): VerifiedTx {
  const base: VerifiedTx = { signature, found: false, succeeded: false, transfers: [] };
  if (response == null) return { ...base, status: "not_found" };
  const tx = record(response);
  const unresolved = (error: string): VerifiedTx => ({
    ...base, found: true, status: "unresolved", error,
  });
  if (!tx) return unresolved("The RPC returned an invalid transaction response.");
  if (typeof tx.slot === "number" && Number.isSafeInteger(tx.slot)) base.slot = tx.slot;
  if (tx.blockTime === null || (typeof tx.blockTime === "number" && Number.isSafeInteger(tx.blockTime))) {
    base.blockTime = tx.blockTime;
  }
  const meta = record(tx.meta);
  if (!meta || !("err" in meta) || meta.err === undefined) {
    return unresolved("Transaction metadata is unavailable; execution cannot be verified.");
  }
  const fee = exactUnits(meta.fee);
  if (fee !== undefined) base.fee = fee;
  if (meta.err !== null) {
    return { ...base, found: true, status: "failed", error: JSON.stringify(meta.err) };
  }
  if (fee === undefined) return unresolved("The transaction fee is not an exact non-negative integer.");

  const message = record(record(tx.transaction)?.message);
  if (!Array.isArray(message?.instructions)) return unresolved("Transaction instructions are unavailable.");
  if (!Array.isArray(meta.innerInstructions)) {
    return unresolved("Inner-instruction records are unavailable; transfer evidence may be incomplete.");
  }
  const instructions: unknown[] = [...message.instructions];
  for (const group of meta.innerInstructions) {
    const inner = record(group);
    if (!Array.isArray(inner?.instructions)) return unresolved("Inner-instruction records are malformed.");
    instructions.push(...inner.instructions);
  }
  const transfers: VerifiedTransfer[] = [];
  for (const instruction of instructions) {
    const ix = record(instruction);
    // A parsed type named "transfer" alone could be an SPL-token transfer.
    const id = programId(ix?.programId);
    if (!ix || !id) return unresolved("An instruction's program identity is unavailable.");
    if (id !== SYSTEM_PROGRAM_ID) continue;
    const parsed = record(ix.parsed);
    if (!parsed || typeof parsed.type !== "string") return unresolved("An instruction from the System Program could not be decoded.");
    if (parsed.type !== "transfer" && parsed.type !== "transferWithSeed") continue;
    const info = record(parsed.info);
    const units = exactUnits(info?.lamports);
    if (typeof info?.source !== "string" || !info.source || typeof info.destination !== "string" || !info.destination || units === undefined) {
      return unresolved("A native transfer has missing addresses or an inexact amount.");
    }
    transfers.push({ from: info.source, to: info.destination, units });
  }
  const sources = new Set(transfers.map((transfer) => transfer.from));
  return {
    ...base, found: true, succeeded: true, status: "confirmed", transfers,
    from: sources.size === 1 ? transfers[0].from : undefined,
  };
}

/** Read only: a timeout is different from a signature absent at this RPC. */
export async function verifyOne(signature: string, signal?: AbortSignal): Promise<VerifiedTx> {
  validateReceiptSignatures([signature]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, READ_TIMEOUT_MS);
  try {
    if (signal?.aborted) controller.abort();
    // Fetch permits an actual abort, including response-body reads, unlike a
    // Promise.race that leaves the underlying RPC request running indefinitely.
    const response = await fetch(RPC_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, {
        encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed",
      }] }),
    });
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}.`);
    const envelope = record(await response.json());
    if (!envelope || envelope.error || !("result" in envelope)) {
      const message = record(envelope?.error)?.message;
      throw new Error(typeof message === "string" ? message : "The RPC returned an invalid response.");
    }
    if (envelope.result != null) {
      const signatures = record(record(envelope.result)?.transaction)?.signatures;
      if (!Array.isArray(signatures) || signatures[0] !== signature) {
        throw new Error("The RPC transaction does not match the requested signature.");
      }
    }
    return parseVerifiedTransaction(signature, envelope.result);
  } catch (e) {
    return {
      signature, found: false, succeeded: false, status: "rpc_error", transfers: [],
      error: controller.signal.aborted ? "RPC read timed out or was cancelled; payment status remains unknown." : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function verifyAll(
  signatures: string[],
  read: (signature: string, signal?: AbortSignal) => Promise<VerifiedTx> = verifyOne,
): Promise<VerifiedTx[]> {
  const unique = validateReceiptSignatures(signatures);
  const out = new Array<VerifiedTx>(unique.length);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECEIPT_TIMEOUT_MS);
  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const index = cursor++;
      const signature = unique[index];
      try {
        if (controller.signal.aborted) throw new Error("Receipt read time limit reached; this signature has not been checked.");
        out[index] = await read(signature, controller.signal);
      } catch (error) {
        out[index] = { signature, found: false, succeeded: false, status: "rpc_error", transfers: [],
          error: error instanceof Error ? error.message : "The RPC read could not be completed." };
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
    return out;
  } finally {
    clearTimeout(timeout);
  }
}

export function verificationStatus(tx: VerifiedTx): VerificationStatus {
  const status = tx.status ?? (!tx.found ? (tx.error ? "rpc_error" : "not_found") : tx.succeeded ? "confirmed" : "failed");
  if (status === "confirmed" && (!tx.found || !tx.succeeded)) return "unresolved";
  return status;
}

/** Duplicate evidence never increases totals; conflicting observations stay unresolved. */
export function deduplicateTransactions(txs: VerifiedTx[]): VerifiedTx[] {
  const unique = new Map<string, VerifiedTx>();
  const fingerprint = (tx: VerifiedTx) => JSON.stringify([
    verificationStatus(tx), tx.fee?.toString(),
    tx.transfers.map((transfer) => [transfer.from, transfer.to, transfer.units.toString()]),
  ]);
  for (const tx of txs) {
    const previous = unique.get(tx.signature);
    if (!previous) unique.set(tx.signature, tx);
    else if (fingerprint(previous) !== fingerprint(tx)) {
      unique.set(tx.signature, {
        signature: tx.signature, found: previous.found || tx.found, succeeded: false,
        status: "unresolved", transfers: [], error: "Conflicting observations for the same signature; read it again.",
      });
    }
  }
  return [...unique.values()];
}

export interface ReceiptSummary {
  total: bigint;
  recipients: number;
  paid: number;
  failed: number;
  missing: number;
  unresolved: number;
  rpcErrors: number;
  fees: bigint;
}

export function summarize(txs: VerifiedTx[]): ReceiptSummary {
  let total = 0n;
  const recipients = new Set<string>();
  let paid = 0, failed = 0, missing = 0, unresolved = 0, rpcErrors = 0;
  let fees = 0n;
  for (const tx of deduplicateTransactions(txs)) {
    const status = verificationStatus(tx);
    if (status === "not_found") { missing++; continue; }
    if (status === "rpc_error") { unresolved++; rpcErrors++; continue; }
    if (status === "unresolved") { unresolved++; continue; }
    fees += tx.fee ?? 0n;
    if (status === "failed") { failed++; continue; }
    paid++;
    for (const transfer of tx.transfers) {
      total += transfer.units;
      if (transfer.units > 0n) recipients.add(transfer.to);
    }
  }
  return { total, recipients: recipients.size, paid, failed, missing, unresolved, rpcErrors, fees };
}
