import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { connection, isValidAddress, parseCook } from "./chain";

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

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const parts = trimmed.split(/[,;\t]+|\s+/).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line, text: trimmed, reason: "expected an address and an amount" });
      return;
    }
    const [address, amountRaw] = parts;
    if (!isValidAddress(address)) {
      errors.push({ line, text: trimmed, reason: "not a valid address" });
      return;
    }
    const units = parseCook(amountRaw);
    if (units === null) {
      errors.push({ line, text: trimmed, reason: `"${amountRaw}" is not an amount in COOK` });
      return;
    }
    if (units <= 0n) {
      errors.push({ line, text: trimmed, reason: "amount must be greater than zero" });
      return;
    }
    const dup = seen.get(address);
    if (dup !== undefined) {
      errors.push({ line, text: trimmed, reason: `duplicate of line ${dup}` });
      return;
    }
    seen.set(address, line);
    recipients.push({ line, address, units });
  });

  const total = recipients.reduce((a, r) => a + r.units, 0n);
  return { recipients, errors, total };
}

/** Solana's packet limit. A transaction that exceeds it is rejected outright. */
const MAX_TX_BYTES = 1232;
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

export type BatchStatus =
  | { state: "waiting" }
  | { state: "signing" }
  | { state: "sending" }
  | { state: "confirming"; signature: string }
  | { state: "confirmed"; signature: string }
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
