import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { connection, isValidAddress, MAX_TRANSFER_UNITS, parseCook } from "./chain";

/** Bound review size, wallet prompts and RPC work for a single payout. */
export const MAX_RECIPIENTS = 200;
const MAX_INPUT_CHARACTERS = 100_000;

export interface Recipient {
  line: number;
  address: string;
  units: bigint;
}

export interface ParseResult {
  recipients: Recipient[];
  errors: { line: number; text: string; reason: string }[];
  total: bigint;
}

/**
 * One recipient per line: `address,amount` (comma, semicolon, tab or spaces).
 * Blank lines and `#` comments are skipped so a list can be annotated.
 *
 * Every rejected line is reported with its line number rather than dropped. A
 * payout tool that silently ignores a malformed row pays fewer people than the
 * operator thinks it did, and nothing on screen says so.
 */
export function parseRecipients(text: string): ParseResult {
  const recipients: Recipient[] = [];
  const errors: ParseResult["errors"] = [];
  const seen = new Map<string, number>();

  if (text.length > MAX_INPUT_CHARACTERS) {
    return {
      recipients: [],
      errors: [{ line: 1, text: "", reason: `list is too large; use at most ${MAX_RECIPIENTS} recipients per payout` }],
      total: 0n,
    };
  }
  let rowCount = 0;

  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    rowCount += 1;
    if (rowCount > MAX_RECIPIENTS) {
      errors.push({ line, text: trimmed, reason: `maximum ${MAX_RECIPIENTS} recipients per payout; split the list before sending` });
      break;
    }

    // Explicit delimiters preserve empty columns, including trailing columns.
    // Whitespace is an alternative separator, not a reason to discard CSV data.
    const parts = /[,;\t]/.test(raw)
      ? raw.split(/[,;\t]/).map((part) => part.trim())
      : trimmed.split(/\s+/);
    if (parts.length !== 2 || parts.some((part) => !part)) {
      errors.push({ line, text: trimmed, reason: "expected exactly two columns: address and amount" });
      continue;
    }
    const [address, amountRaw] = parts;
    if (!isValidAddress(address)) {
      errors.push({ line, text: trimmed, reason: "not a valid address" });
      continue;
    }
    const units = parseCook(amountRaw);
    if (units === null) {
      errors.push({ line, text: trimmed, reason: `"${amountRaw}" is not a valid COOK amount (maximum 9 decimals and unsigned 64-bit units)` });
      continue;
    }
    if (units <= 0n) {
      errors.push({ line, text: trimmed, reason: "amount must be greater than zero" });
      continue;
    }
    const dup = seen.get(address);
    if (dup !== undefined) {
      errors.push({ line, text: trimmed, reason: `duplicate of line ${dup}` });
      continue;
    }
    seen.set(address, line);
    recipients.push({ line, address, units });
  }

  const total = recipients.reduce((a, r) => a + r.units, 0n);
  return { recipients, errors, total };
}

/** Solana's packet limit. A transaction that exceeds it is rejected outright. */
export const MAX_TX_BYTES = 1232;
/** Room for the fee payer's 64-byte signature, which is added after signing. */
const SIGNATURE_ROOM = 64 + 1;

export interface Batch {
  recipients: Recipient[];
  tx: Transaction;
}

/**
 * Pack transfers into as few transactions as possible.
 *
 * The count per transaction is measured, not guessed: instructions are added
 * until the serialized message would cross the packet limit, then the batch is
 * closed. Guessing a fixed number either wastes transactions or produces one
 * that the cluster refuses at send time, after the user has already approved it.
 */
export function buildBatches(
  from: PublicKey,
  recipients: Recipient[],
  blockhash: string,
  lastValidBlockHeight: number
): Batch[] {
  if (recipients.length === 0) throw new Error("Add at least one recipient before building a payout.");
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`Maximum ${MAX_RECIPIENTS} recipients per payout.`);
  const addresses = new Set<string>();
  for (const recipient of recipients) {
    if (!isValidAddress(recipient.address)) throw new Error(`Invalid recipient address on line ${recipient.line}.`);
    if (recipient.units <= 0n || recipient.units > MAX_TRANSFER_UNITS) {
      throw new Error(`Invalid transfer amount on line ${recipient.line}.`);
    }
    if (addresses.has(recipient.address)) throw new Error(`Duplicate recipient on line ${recipient.line}.`);
    addresses.add(recipient.address);
  }
  const batches: Batch[] = [];
  let current: Recipient[] = [];

  const makeTx = (rs: Recipient[]) => {
    const tx = new Transaction();
    tx.feePayer = from;
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    for (const r of rs) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: new PublicKey(r.address),
          lamports: r.units,
        }) as TransactionInstruction
      );
    }
    return tx;
  };

  const fits = (rs: Recipient[]) => {
    try {
      const size = makeTx(rs).serializeMessage().length + SIGNATURE_ROOM;
      return size <= MAX_TX_BYTES;
    } catch {
      return false;
    }
  };

  for (const r of recipients) {
    if (!fits([r])) throw new Error(`Transfer on line ${r.line} cannot fit in a valid transaction.`);
    const attempt = [...current, r];
    if (current.length > 0 && !fits(attempt)) {
      batches.push({ recipients: current, tx: makeTx(current) });
      current = [r];
    } else {
      current = attempt;
    }
  }
  if (current.length) batches.push({ recipients: current, tx: makeTx(current) });
  return batches;
}

export interface PayoutReadiness {
  chainOk: boolean | null;
  hasWallet: boolean;
  recipientCount: number;
  errorCount: number;
  total: bigint;
  fee: bigint | null;
  balance: bigint | null;
  batchCount: number;
  running: boolean;
}

/** A fail-closed guard shared by the visible control and the send handler. */
export function getPayoutBlocker(state: PayoutReadiness): string | null {
  if (state.running) return "A payout is already in progress.";
  if (state.chainOk !== true) return "Verify the Cookie Chain connection before sending.";
  if (!state.hasWallet) return "Connect a wallet before sending.";
  if (state.errorCount > 0) return "Fix every recipient list error before sending.";
  if (!Number.isInteger(state.recipientCount) || state.recipientCount < 1) return "Add at least one recipient.";
  if (state.recipientCount > MAX_RECIPIENTS) return `Maximum ${MAX_RECIPIENTS} recipients per payout.`;
  if (state.total <= 0n) return "The payout total must be greater than zero.";
  if (!Number.isInteger(state.batchCount) || state.batchCount < 1) return "Wait for transactions to be prepared.";
  if (state.fee === null || state.fee < 0n) return "Wait for a valid network fee estimate before sending.";
  if (state.balance === null || state.balance < 0n) return "Refresh the wallet balance before sending.";
  if (state.balance < state.total + state.fee) return "Insufficient COOK for the payout and network fees.";
  return null;
}

export type BatchStatus =
  | { state: "waiting" }
  | { state: "signing" }
  | { state: "sending" }
  | { state: "confirming"; signature: string }
  | { state: "confirmed"; signature: string }
  | { state: "uncertain"; signature: string; error: string }
  | { state: "skipped"; error: string }
  | { state: "failed"; signature?: string; error: string };

/**
 * Estimate the fee for the whole payout by asking the chain what each built
 * message costs, rather than multiplying an assumed 5000 units per signature.
 */
export async function estimateFee(batches: Batch[]): Promise<bigint | null> {
  try {
    let total = 0n;
    for (const b of batches) {
      const res = await connection.getFeeForMessage(b.tx.compileMessage(), "confirmed");
      if (res.value === null) return null;
      total += BigInt(res.value);
    }
    return total;
  } catch {
    return null;
  }
}
