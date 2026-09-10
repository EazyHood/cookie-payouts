import { PublicKey, Transaction } from "@solana/web3.js";
import { getWallets, type Wallet as StandardWallet, type WalletAccount } from "@wallet-standard/core";

/**
 * Wallet plumbing.
 *
 * Nightly is discovered through Wallet Standard first, then its legacy
 * `window.nightly.solana` injection. Other compatible injected Solana wallets
 * remain available, without being relabelled as Nightly.
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

interface StandardSignInput {
  account: WalletAccount;
  transaction: Uint8Array;
}
interface CompatibleStandardWallet extends StandardWallet {
  readonly features: StandardWallet["features"] & {
    "standard:connect": { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
    "solana:signTransaction": {
      supportedTransactionVersions: readonly ("legacy" | 0)[];
      signTransaction(...inputs: StandardSignInput[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
    };
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function isStandardSigner(value: unknown): value is CompatibleStandardWallet {
  const wallet = record(value);
  const features = record(wallet?.features);
  const connectFeature = record(features?.["standard:connect"]);
  const signFeature = record(features?.["solana:signTransaction"]);
  return wallet?.version === "1.0.0" && typeof wallet.name === "string" &&
    Array.isArray(wallet.accounts) && Array.isArray(wallet.chains) &&
    wallet.chains.some(chain => typeof chain === "string" && chain.startsWith("solana:")) &&
    typeof connectFeature?.connect === "function" && typeof signFeature?.signTransaction === "function" &&
    Array.isArray(signFeature.supportedTransactionVersions) && signFeature.supportedTransactionVersions.includes("legacy");
}

function isSolanaAccount(account: WalletAccount): boolean {
  return !!account && typeof account.address === "string" && account.publicKey instanceof Uint8Array &&
    account.publicKey.length === 32 && Array.isArray(account.chains) &&
    account.chains.some(chain => typeof chain === "string" && chain.startsWith("solana:")) &&
    Array.isArray(account.features) && account.features.includes("solana:signTransaction");
}

const standardProviders = new WeakMap<StandardWallet, Provider>();

function standardProvider(wallet: CompatibleStandardWallet): Provider {
  const cached = standardProviders.get(wallet);
  if (cached) return cached;
  let selectedAddress: string | undefined;
  const currentAccount = () => wallet.accounts.find(account =>
    isSolanaAccount(account) && account.address === selectedAddress &&
    new PublicKey(account.publicKey).toBase58() === selectedAddress);
  const provider: Provider = {
    get publicKey() {
      const account = currentAccount();
      return account ? new PublicKey(account.publicKey) : null;
    },
    async connect(options) {
      const output = await wallet.features["standard:connect"].connect({ silent: options?.onlyIfTrusted });
      const account = output?.accounts?.find(isSolanaAccount);
      if (!account) throw new Error(`${wallet.name} did not authorize a Solana/SVM signing account. Select one in the wallet and reconnect.`);
      const publicKey = new PublicKey(account.publicKey);
      if (publicKey.toBase58() !== account.address) throw new Error(`${wallet.name} returned inconsistent account details.`);
      selectedAddress = account.address;
      return { publicKey };
    },
    async signAllTransactions(txs) {
      const account = currentAccount();
      if (!account || !isStandardSigner(wallet)) throw new Error("Wallet account or signing support changed. Reconnect and review the payout.");
      const input = txs.map(tx => ({
        account,
        transaction: new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
      }));
      // Sign only: never use solana:signAndSendTransaction or ask the wallet to
      // change network. The app broadcasts the validated bytes to its own RPC.
      const output = await wallet.features["solana:signTransaction"].signTransaction(...input);
      if (!Array.isArray(output) || output.length !== txs.length) {
        throw new Error("Wallet returned a different number of transactions. Nothing was sent.");
      }
      return output.map(result => {
        if (!(result?.signedTransaction instanceof Uint8Array)) throw new Error("Wallet returned invalid signed transaction bytes. Nothing was sent.");
        return Transaction.from(result.signedTransaction);
      });
    },
    async disconnect() {
      const feature = record(wallet.features["standard:disconnect"]);
      try {
        if (typeof feature?.disconnect === "function") await feature.disconnect();
      } finally { selectedAddress = undefined; }
    },
  };
  standardProviders.set(wallet, provider);
  return provider;
}

function canSign(provider: Provider | undefined): provider is Provider {
  return !!provider && typeof provider.connect === "function" &&
    (typeof provider.signAllTransactions === "function" || typeof provider.signTransaction === "function");
}

declare global {
  interface Window {
    nightly?: { solana?: Partial<Provider> & { standardWallet?: StandardWallet; features?: StandardWallet["features"] } };
    solana?: Provider & { isNightly?: boolean; standardWallet?: StandardWallet };
  }
}

function registeredWallets(): readonly StandardWallet[] {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return [];
  return getWallets().get();
}

/** Refresh the visible choices when extensions register after the app loads. */
export function subscribeProvidersChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const registry = getWallets();
  const stopRegister = registry.on("register", listener);
  const stopUnregister = registry.on("unregister", listener);
  return () => { stopRegister(); stopUnregister(); };
}

/** The optional registry snapshot also permits offline capability tests. */
export function detectProviders(standardWallets: readonly StandardWallet[] = registeredWallets()): { kind: WalletKind; name: string; provider: Provider }[] {
  const out: { kind: WalletKind; name: string; provider: Provider }[] = [];
  if (typeof window === "undefined") return out;
  const nightlyInjection = window.nightly?.solana;
  const standardCandidates: unknown[] = [nightlyInjection?.standardWallet, nightlyInjection, window.solana?.standardWallet, ...standardWallets];
  const seen = new Set<StandardWallet>();
  for (const candidate of standardCandidates) {
    if (!isStandardSigner(candidate) || candidate.name !== "Nightly" || seen.has(candidate)) continue;
    seen.add(candidate);
    if (!out.some(entry => entry.kind === "nightly")) {
      out.push({ kind: "nightly", name: "Nightly", provider: standardProvider(candidate) });
    }
  }
  const nightly = canSign(nightlyInjection as Provider | undefined) ? nightlyInjection as Provider : undefined;
  if (nightly && !out.some(entry => entry.kind === "nightly")) out.push({ kind: "nightly", name: "Nightly", provider: nightly });
  const generic = window.solana;
  if (canSign(generic) && generic !== nightly) {
    if (generic.isNightly || generic.standardWallet?.name === "Nightly") {
      if (!out.some(entry => entry.kind === "nightly")) out.unshift({ kind: "nightly", name: "Nightly", provider: generic });
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
    if (p.publicKey === null || (p.publicKey && !new PublicKey(p.publicKey).equals(publicKey))) {
      throw new Error("Wallet account changed. Reconnect and review the payout before signing.");
    }
  };

  return {
    kind: entry.kind,
    name: entry.name,
    publicKey,
    async signAllTransactions(txs: Transaction[]) {
      if (!txs.length) throw new Error("No transactions to sign. Nothing was sent.");
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
