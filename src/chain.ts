import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Cookie Chain is an SVM chain, so the Solana JSON-RPC client works unchanged.
 * Everything here was read from the live endpoint rather than copied from docs:
 * `getGenesisHash` returns the hash below, and `getVersion` reports solana-core
 * 4.1.2. The genesis hash checks the RPC identity at runtime. It does not inspect
 * the wallet's selected network; the app signs locally and broadcasts through
 * this RPC rather than asking a wallet to choose the destination RPC.
 */
export const RPC_URL = "https://rpc.cookiescan.io";
export const GENESIS_HASH = "9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2";
export const EXPLORER = "https://cookiescan.io";

/** Native COOK, like SOL, has 9 decimals: the base fee reported by the chain is
 *  0.000005 COOK, i.e. 5000 of the smallest unit. */
export const DECIMALS = 9;
export const UNITS_PER_COOK = 1_000_000_000;
/** Native transfer instructions encode their amount as an unsigned 64-bit integer. */
export const MAX_TRANSFER_UNITS = (1n << 64n) - 1n;

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

/** Parse a human COOK amount exactly, without rounding decimal input or going
 *  through a JavaScript number, and enforce the transfer instruction's u64 limit. */
export function parseCook(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) return null;
  // Bound the integer conversion even when a pasted value has many digits.
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  if (normalizedWhole.length > 11) return null;
  const padded = frac.padEnd(DECIMALS, "0");
  try {
    const units = BigInt(normalizedWhole) * BigInt(UNITS_PER_COOK) + BigInt(padded || "0");
    return units <= MAX_TRANSFER_UNITS ? units : null;
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

/** Check whether the RPC reports Cookie Chain's expected genesis hash.
 *  Callers must enforce the result before enabling or attempting a payout. */
export async function verifyChain(signal?: AbortSignal): Promise<{ ok: boolean; genesis?: string; error?: string }> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, 12_000);
  try {
    if (signal?.aborted) controller.abort();
    // Abort both the request and response-body read when the RPC stalls. Keep
    // the shared Connection unchanged for balance, fee and transaction work.
    const response = await fetch(RPC_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
    });
    if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The RPC returned an invalid genesis response.");
    const envelope = data as Record<string, unknown>;
    if (envelope.error) {
      const error = typeof envelope.error === "object" ? envelope.error as Record<string, unknown> : undefined;
      throw new Error(typeof error?.message === "string" ? error.message : "The RPC could not read its genesis hash.");
    }
    const genesis = envelope.result;
    if (envelope.jsonrpc !== "2.0" || envelope.id !== 1 || typeof genesis !== "string" || genesis.length > 44 || !isValidAddress(genesis)) {
      throw new Error("The RPC returned an invalid genesis response.");
    }
    return genesis === GENESIS_HASH ? { ok: true, genesis }
      : { ok: false, genesis, error: "This RPC reports a different chain; Cookie Chain could not be verified." };
  } catch (e) {
    return { ok: false, error: controller.signal.aborted ? "Cookie Chain verification timed out or was cancelled. Try again." : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
