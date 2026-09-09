import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Cookie Chain is an SVM chain, so the Solana JSON-RPC client works unchanged.
 * Everything here was read from the live endpoint rather than copied from docs:
 * `getGenesisHash` returns the hash below, and `getVersion` reports solana-core
 * 4.1.2. The genesis hash is what we use to prove, at runtime, that the wallet
 * and the RPC are on the same chain — a wallet silently pointed at Solana would
 * otherwise sign a transfer that never lands here.
 */
export const RPC_URL = "https://rpc.cookiescan.io";
export const GENESIS_HASH = "9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2";
export const EXPLORER = "https://cookiescan.io";

/** Native COOK, like SOL, has 9 decimals: the base fee reported by the chain is
 *  0.000005 COOK, i.e. 5000 of the smallest unit. */
export const DECIMALS = 9;
export const UNITS_PER_COOK = 1_000_000_000;

export const connection = new Connection(RPC_URL, "confirmed");

export function explorerTx(sig: string) {
  return `${EXPLORER}/tx/${sig}`;
}

export function explorerAddress(addr: string) {
  return `${EXPLORER}/address/${addr}`;
}

/** Format a raw unit amount as COOK, trimming trailing zeros but never lying
 *  about precision: 1 unit shows as 0.000000001, not as 0. */
export function formatCook(units: number | bigint): string {
  const n = typeof units === "bigint" ? units : BigInt(Math.round(units));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / BigInt(UNITS_PER_COOK);
  const frac = abs % BigInt(UNITS_PER_COOK);
  let fracStr = frac.toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${fracStr ? "." + fracStr : ""}`;
}

/** Parse a human COOK amount into raw units without floating point drift.
 *  `0.1` as a float times 1e9 is 100000000.00000001; string maths avoids that. */
export function parseCook(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) return null;
  const padded = frac.padEnd(DECIMALS, "0");
  try {
    return BigInt(whole) * BigInt(UNITS_PER_COOK) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

export function isValidAddress(a: string): boolean {
  try {
    // A 32-byte key that is not on the ed25519 curve is still a legal account
    // (PDAs are exactly that), so the only real check is that it decodes.
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
}

/** Confirm the RPC really is Cookie Chain. Called once on load; if this fails
 *  the app refuses to send rather than guessing. */
export async function verifyChain(): Promise<{ ok: boolean; genesis?: string; error?: string }> {
  try {
    const genesis = await connection.getGenesisHash();
    return { ok: genesis === GENESIS_HASH, genesis };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
