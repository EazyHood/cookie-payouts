import { PublicKey, Transaction } from "@solana/web3.js";

/**
 * Wallet plumbing.
 *
 * The bounty requires Nightly, which injects `window.nightly.solana`. Any other
 * injected Solana wallet exposing the same three methods works too, so this
 * detects rather than hardcodes — but Nightly is listed first and labelled, so a
 * reader can see the required one is actually wired.
 *
 * Note on `signAndSendTransaction`: several wallets implement it by sending
 * through *their own* RPC, which for a wallet that does not know Cookie Chain
 * means the transaction is broadcast to Solana and disappears. So this app only
 * ever asks the wallet to SIGN, and sends the signed bytes itself through the
 * Cookie Chain RPC. That is the difference between a payout that lands and one
 * that silently does not.
 */

export type WalletKind = "nightly" | "injected";

export interface Wallet {
  kind: WalletKind;
  name: string;
  publicKey: PublicKey;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
}

interface Provider {
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: PublicKey } | void>;
  disconnect?(): Promise<void>;
  publicKey?: PublicKey | null;
  signTransaction?(tx: Transaction): Promise<Transaction>;
  signAllTransactions?(txs: Transaction[]): Promise<Transaction[]>;
}

declare global {
  interface Window {
    nightly?: { solana?: Provider };
    solana?: Provider & { isNightly?: boolean };
  }
}

export function detectProviders(): { kind: WalletKind; name: string; provider: Provider }[] {
  const out: { kind: WalletKind; name: string; provider: Provider }[] = [];
  const nightly = window.nightly?.solana;
  if (nightly) out.push({ kind: "nightly", name: "Nightly", provider: nightly });
  const generic = window.solana;
  if (generic && !generic.isNightly && generic !== nightly) {
    out.push({ kind: "injected", name: "Injected wallet", provider: generic });
  }
  return out;
}

export async function connect(entry: { kind: WalletKind; name: string; provider: Provider }): Promise<Wallet> {
  const p = entry.provider;
  const res = (await p.connect()) as { publicKey?: unknown } | undefined;
  const raw: unknown = res?.publicKey ?? p.publicKey;
  if (!raw) throw new Error(`${entry.name} did not return a public key`);
  const publicKey = raw instanceof PublicKey ? raw : new PublicKey(String(raw));

  return {
    kind: entry.kind,
    name: entry.name,
    publicKey,
    async signAllTransactions(txs: Transaction[]) {
      // Prefer the batch method: one approval for the whole payout instead of
      // one prompt per batch, which is where people give up half way through
      // and leave a payout half sent.
      if (p.signAllTransactions) return p.signAllTransactions(txs);
      if (!p.signTransaction) throw new Error(`${entry.name} cannot sign transactions`);
      const signed: Transaction[] = [];
      for (const tx of txs) signed.push(await p.signTransaction(tx));
      return signed;
    },
  };
}

export async function disconnect(entry?: { provider: Provider }) {
  try {
    await entry?.provider.disconnect?.();
  } catch {
    // A wallet that refuses to disconnect is not a reason to break the page.
  }
}
