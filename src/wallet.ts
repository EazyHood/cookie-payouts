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
 * can mean the transaction is broadcast to the wrong network. So this app only
 * ever asks the wallet to SIGN, and sends the signed bytes itself through the
 * Cookie Chain RPC. A successful signature is still not proof of confirmation.
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

function canSign(provider: Provider | undefined): provider is Provider {
  return !!provider && typeof provider.connect === "function" &&
    (typeof provider.signAllTransactions === "function" || typeof provider.signTransaction === "function");
}

declare global {
  interface Window {
    nightly?: { solana?: Provider };
    solana?: Provider & { isNightly?: boolean };
  }
}

export function detectProviders(): { kind: WalletKind; name: string; provider: Provider }[] {
  const out: { kind: WalletKind; name: string; provider: Provider }[] = [];
  const nightly = canSign(window.nightly?.solana) ? window.nightly?.solana : undefined;
  if (nightly) out.push({ kind: "nightly", name: "Nightly", provider: nightly });
  const generic = window.solana;
  if (canSign(generic) && generic !== nightly) {
    if (generic.isNightly) {
      if (!nightly) out.unshift({ kind: "nightly", name: "Nightly", provider: generic });
    } else {
      out.push({ kind: "injected", name: "Injected wallet", provider: generic });
    }
  }
  return out;
}

/** Validate the wallet response before any transaction is broadcast.
 *  `original` must be a snapshot taken before calling the provider, since some
 *  providers sign by mutating the transactions passed to them. */
export function validateSignedTransactions(
  original: readonly Transaction[],
  signed: readonly Transaction[],
  signer: PublicKey
): void {
  if (!Array.isArray(signed) || signed.length !== original.length || original.length === 0) {
    throw new Error("Wallet returned a different number of transactions. Nothing was sent.");
  }
  for (let i = 0; i < original.length; i++) {
    const expected = original[i];
    const actual: Transaction = signed[i];
    if (!expected.feePayer?.equals(signer) || !actual?.feePayer?.equals(signer)) {
      throw new Error(`Wallet signer changed for transaction ${i + 1}. Nothing was sent.`);
    }
    const before = expected.serializeMessage();
    const after = actual.serializeMessage();
    if (before.length !== after.length || before.some((byte, j) => byte !== after[j])) {
      throw new Error(`Wallet changed transaction ${i + 1}. Nothing was sent.`);
    }
    if (!actual.signatures.some((entry) => entry.publicKey.equals(signer) && entry.signature !== null) ||
        !actual.verifySignatures()) {
      throw new Error(`Wallet returned an invalid or missing signature for transaction ${i + 1}. Nothing was sent.`);
    }
  }
}

export async function connect(entry: { kind: WalletKind; name: string; provider: Provider }): Promise<Wallet> {
  const p = entry.provider;
  if (!canSign(p)) throw new Error(`${entry.name} cannot sign transactions`);
  const res = (await p.connect()) as { publicKey?: unknown } | undefined;
  const raw: unknown = res?.publicKey ?? p.publicKey;
  if (!raw) throw new Error(`${entry.name} did not return a public key`);
  const publicKey = raw instanceof PublicKey ? raw : new PublicKey(String(raw));

  const assertCurrentAccount = () => {
    if (p.publicKey && !new PublicKey(p.publicKey).equals(publicKey)) {
      throw new Error("Wallet account changed. Reconnect and review the payout before signing.");
    }
  };

  return {
    kind: entry.kind,
    name: entry.name,
    publicKey,
    async signAllTransactions(txs: Transaction[]) {
      assertCurrentAccount();
      // Preserve the reviewed messages independently of provider mutations.
      const originals = txs.map((tx) => Transaction.from(tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      })));
      let signed: Transaction[];
      // Prefer batch signing; the wallet controls how many prompts it shows.
      if (p.signAllTransactions) {
        signed = await p.signAllTransactions(txs);
      } else {
        if (!p.signTransaction) throw new Error(`${entry.name} cannot sign transactions`);
        signed = [];
        for (const tx of txs) {
          assertCurrentAccount();
          signed.push(await p.signTransaction(tx));
        }
      }
      assertCurrentAccount();
      validateSignedTransactions(originals, signed, publicKey);
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
