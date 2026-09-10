import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { getWallets, type Wallet as StandardWallet, type WalletAccount } from "@wallet-standard/core";
import { connect, detectProviders, subscribeProvidersChanged } from "../src/wallet.ts";

// Deterministic, unfunded test keys. Signing here is a local fixture, never a
// request to an extension, and no test has access to a broadcast function.
const payer = Keypair.fromSeed(new Uint8Array(32).fill(231));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(232));
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(233)).publicKey.toBase58();
const solanaAccount: WalletAccount = {
  address: payer.publicKey.toBase58(),
  publicKey: payer.publicKey.toBytes(),
  chains: ["solana:mainnet"],
  features: ["solana:signTransaction"],
};
function tx(amount = 1n) {
  return new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: recipient.publicKey, lamports: amount,
  }));
}
interface SignInput { account: WalletAccount; transaction: Uint8Array }
type SignOutput = { signedTransaction: Uint8Array };
function fixture() {
  let accounts: readonly WalletAccount[] = [];
  let authorized: readonly WalletAccount[] = [solanaAccount];
  const requests: SignInput[][] = [];
  let sign = async (inputs: SignInput[]): Promise<readonly SignOutput[]> => inputs.map(input => {
    const transaction = Transaction.from(input.transaction);
    transaction.sign(payer);
    return { signedTransaction: new Uint8Array(transaction.serialize()) };
  });
  const features = {
    "standard:connect": {
      version: "1.0.0",
      async connect() { accounts = authorized; return { accounts }; },
    },
    "standard:disconnect": { version: "1.0.0", async disconnect() { accounts = []; } },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      async signTransaction(...inputs: SignInput[]) { requests.push(inputs); return sign(inputs); },
    },
    // These methods must NEVER be called by the application adapter.
    "solana:signAndSendTransaction": { signAndSendTransaction() { assert.fail("Wallet must not broadcast"); } },
  };
  const wallet: StandardWallet = {
    name: "Nightly", version: "1.0.0", icon: "data:image/svg+xml;base64,",
    chains: ["solana:mainnet"], features,
    get accounts() { return accounts; },
  };
  return {
    wallet, features, requests,
    authorize(value: readonly WalletAccount[]) { authorized = value; },
    setAccounts(value: readonly WalletAccount[]) { accounts = value; },
    setSigner(value: typeof sign) { sign = value; },
  };
}
function withWindow(value: object, t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

test("a standard-only Nightly is discovered ahead of a generic legacy injection", t => {
  const f = fixture();
  const generic = { connect: async () => undefined, signTransaction: async (transaction: Transaction) => transaction };
  withWindow({ solana: generic }, t);
  const choices = detectProviders([f.wallet]);
  assert.deepEqual(choices.map(choice => choice.name), ["Nightly", "Injected wallet"]);
  assert.equal(choices[1].provider, generic);
});

test("registry, namespace and legacy aliases expose Nightly once", t => {
  const f = fixture();
  const alias = { standardWallet: f.wallet, isNightly: true, connect: async () => undefined, signTransaction: async (transaction: Transaction) => transaction };
  withWindow({ nightly: { solana: alias }, solana: alias }, t);
  const first = detectProviders([f.wallet, f.wallet]);
  const second = detectProviders([f.wallet]);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "nightly");
  assert.equal(first[0].provider, second[0].provider, "rerenders keep the selected account in the same adapter");
});

test("the direct standard namespace works without a registry entry", t => {
  const f = fixture();
  withWindow({ nightly: { solana: f.wallet } }, t);
  assert.deepEqual(detectProviders([]).map(choice => choice.name), ["Nightly"]);
});

test("unsupported versioned-only signing is not presented as legacy transaction support", t => {
  const f = fixture();
  f.features["solana:signTransaction"].supportedTransactionVersions = [0];
  withWindow({}, t);
  assert.equal(detectProviders([f.wallet]).length, 0);
});

test("standard connection selects an authorized Solana account and signs exact reviewed bytes", async t => {
  const f = fixture();
  f.authorize([{ ...solanaAccount, chains: ["ethereum:1"], features: [] }, solanaAccount]);
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  assert.ok(wallet.publicKey.equals(payer.publicKey));
  const original = [tx(1n), tx(2n)];
  const messages = original.map(transaction => transaction.serializeMessage());
  const signed = await wallet.signAllTransactions(original);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].length, 2);
  for (const [index, transaction] of signed.entries()) {
    assert.deepEqual(transaction.serializeMessage(), messages[index]);
    assert.ok(transaction.verifySignatures());
    assert.equal(f.requests[0][index].account, solanaAccount);
    assert.equal(original[index].signature, null, "the original transactions are not mutated by conversion");
  }
});

test("connection without an authorized SVM account fails before signing", async t => {
  const f = fixture();
  f.authorize([]);
  withWindow({}, t);
  await assert.rejects(connect(detectProviders([f.wallet])[0]), /did not authorize a Solana/);
  assert.equal(f.requests.length, 0);
});

test("inconsistent address and public key are rejected at connection", async t => {
  const f = fixture();
  f.authorize([{ ...solanaAccount, address: recipient.publicKey.toBase58() }]);
  withWindow({}, t);
  await assert.rejects(connect(detectProviders([f.wallet])[0]), /inconsistent account details/);
  assert.equal(f.requests.length, 0);
});

test("the standard wallet cannot alter a reviewed transfer", async t => {
  const f = fixture();
  f.setSigner(async () => { const changed = tx(999n); changed.sign(payer); return [{ signedTransaction: changed.serialize() }]; });
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  await assert.rejects(wallet.signAllTransactions([tx()]), /changed transaction/);
});

test("missing returned transactions fail before the caller can submit any batch", async t => {
  const f = fixture();
  f.setSigner(async () => []);
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  let readyToBroadcast = false;
  await assert.rejects(async () => {
    await wallet.signAllTransactions([tx()]);
    readyToBroadcast = true;
  }, /different number/);
  assert.equal(readyToBroadcast, false);
});

test("an unsigned standard response is not accepted as a signed transaction", async t => {
  const f = fixture();
  f.setSigner(async inputs => inputs.map(input => ({ signedTransaction: input.transaction })));
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  await assert.rejects(wallet.signAllTransactions([tx()]), /invalid or missing signature/);
});

test("account revocation before signing prevents a wallet signing request", async t => {
  const f = fixture();
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  f.setAccounts([]);
  await assert.rejects(wallet.signAllTransactions([tx()]), /account changed/);
  assert.equal(f.requests.length, 0);
});

test("account revocation while signing invalidates even correctly signed returned bytes", async t => {
  const f = fixture();
  f.setSigner(async inputs => {
    f.setAccounts([]);
    return inputs.map(input => { const signed = Transaction.from(input.transaction); signed.sign(payer); return { signedTransaction: signed.serialize() }; });
  });
  withWindow({}, t);
  const wallet = await connect(detectProviders([f.wallet])[0]);
  await assert.rejects(wallet.signAllTransactions([tx()]), /account changed/);
});

test("late registration refreshes provider choices and the subscription cleans up", t => {
  withWindow(new EventTarget(), t);
  const f = fixture();
  let notifications = 0;
  const stop = subscribeProvidersChanged(() => { notifications++; });
  const registry = getWallets();
  const unregister = registry.register(f.wallet);
  assert.equal(notifications, 1);
  assert.deepEqual(detectProviders().map(choice => choice.name), ["Nightly"]);
  unregister();
  assert.equal(notifications, 2);
  assert.equal(detectProviders().length, 0);
  stop();
  const unregisterAgain = registry.register(f.wallet);
  assert.equal(notifications, 2);
  unregisterAgain();
});
