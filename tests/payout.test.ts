import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { formatCook, MAX_TRANSFER_UNITS, parseCook } from "../src/chain.ts";
import {
  buildBatches,
  getPayoutBlocker,
  MAX_RECIPIENTS,
  MAX_TX_BYTES,
  parseRecipients,
  type PayoutReadiness,
} from "../src/payout.ts";
import { connect, detectProviders, validateSignedTransactions } from "../src/wallet.ts";

// Deterministic, unfunded fixture keys; no test makes an RPC or wallet request.
const key = (index: number) => Keypair.fromSeed(new Uint8Array(32).fill(index));
const payer = key(250);
const blockhash = key(249).publicKey.toBase58();
const recipient = (index: number) => ({
  line: index,
  address: key(index).publicKey.toBase58(),
  units: BigInt(index),
});
const clone = (tx: Transaction) => Transaction.from(tx.serialize({
  requireAllSignatures: false,
  verifySignatures: false,
}));
const transfer = (index = 1) => buildBatches(payer.publicKey, [recipient(index)], blockhash, 100)[0].tx;
const ready: PayoutReadiness = {
  chainOk: true,
  hasWallet: true,
  recipientCount: 1,
  errorCount: 0,
  total: 1_000_000_000n,
  fee: 5_000n,
  balance: 1_000_005_000n,
  batchCount: 1,
  running: false,
};

test("amounts retain all nine decimals, including the u64 boundary", () => {
  assert.equal(parseCook("0.000000001"), 1n);
  assert.equal(parseCook("0001.123456789"), 1_123_456_789n);
  assert.equal(parseCook("18446744073.709551615"), MAX_TRANSFER_UNITS);
  assert.equal(parseCook("18446744073.709551616"), null);
  assert.equal(parseCook("18446744074"), null);
  assert.equal(formatCook(1n), "0.000000001");
  assert.equal(formatCook(MAX_TRANSFER_UNITS), "18,446,744,073.709551615");
  for (const invalid of ["1e3", "-1", "NaN", "1.0000000001", "1,000", "1.", ".1", "9".repeat(1_000)]) {
    assert.equal(parseCook(invalid), null, invalid);
  }
});

test("parser accepts documented separators and preserves exact totals", () => {
  const result = parseRecipients([
    "# Payout list",
    "",
    `${recipient(1).address}, 0.1`,
    `${recipient(2).address};0.2`,
    `${recipient(3).address}\t0.000000001`,
    `${recipient(4).address}  1.123456789`,
  ].join("\n"));
  assert.equal(result.errors.length, 0);
  assert.equal(result.recipients.length, 4);
  assert.equal(result.total, 1_423_456_790n);
  assert.deepEqual(result.recipients.map((row) => row.line), [3, 4, 5, 6]);
});

test("malformed and duplicate rows are reported instead of silently ignored", () => {
  const address = recipient(1).address;
  const rows = [
    `${address},1`,
    `${address},2`,
    `${recipient(2).address},3,extra`,
    `${recipient(3).address},4,`,
    `${recipient(4).address}\t5\t`,
    `${recipient(5).address},,6`,
    `${recipient(6).address} 7 extra`,
    `${recipient(7).address},0`,
    `${recipient(8).address},18446744073.709551616`,
    "not-an-address,1",
  ];
  const result = parseRecipients(rows.join("\n"));
  assert.equal(result.recipients.length, 1);
  assert.equal(result.total, 1_000_000_000n);
  assert.equal(result.errors.length, 9);
  assert.match(result.errors[0].reason, /duplicate of line 1/);
  assert.deepEqual(result.errors.map((error) => error.line), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(getPayoutBlocker({ ...ready, errorCount: result.errors.length })!, /Fix every/);
});

test("oversized lists produce a blocking error at the limit", () => {
  const list = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `${recipient(i + 1).address},1`).join("\n");
  const result = parseRecipients(list);
  assert.equal(result.recipients.length, MAX_RECIPIENTS);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, MAX_RECIPIENTS + 1);
  assert.match(result.errors[0].reason, /maximum 200/);
  const enormous = parseRecipients(" ".repeat(100_001));
  assert.equal(enormous.recipients.length, 0);
  assert.match(enormous.errors[0].reason, /too large/);
});

test("batch packing respects the packet size and preserves every transfer exactly once", () => {
  const recipients = Array.from({ length: 55 }, (_, i) => recipient(i + 1));
  const batches = buildBatches(payer.publicKey, recipients, blockhash, 100);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flatMap((batch) => batch.recipients), recipients);
  for (const batch of batches) {
    assert.ok(batch.recipients.length > 0);
    const wire = batch.tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    assert.ok(wire.length <= MAX_TX_BYTES, `packet is ${wire.length} bytes`);
    assert.equal(batch.tx.instructions.length, batch.recipients.length);
  }
  for (const [i, batch] of batches.slice(0, -1).entries()) {
    const next = batches[i + 1].recipients[0];
    const oversized = clone(batch.tx).add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: key(next.line).publicKey,
      lamports: next.units,
    }));
    assert.throws(() => oversized.serialize({ requireAllSignatures: false, verifySignatures: false }), /too large/);
  }
});

test("batch construction rejects invalid direct callers as well as pasted rows", () => {
  assert.throws(() => buildBatches(payer.publicKey, [], blockhash, 100), /at least one/);
  assert.throws(() => buildBatches(payer.publicKey, Array(MAX_RECIPIENTS + 1).fill(recipient(1)), blockhash, 100), /Maximum/);
  assert.throws(() => buildBatches(payer.publicKey, [recipient(1), recipient(1)], blockhash, 100), /Duplicate/);
  for (const units of [0n, -1n, MAX_TRANSFER_UNITS + 1n]) {
    assert.throws(() => buildBatches(payer.publicKey, [{ ...recipient(1), units }], blockhash, 100), /Invalid transfer amount/);
  }
});

test("payout guard requires known chain, valid list, prepared batches and funds including fees", () => {
  assert.equal(getPayoutBlocker(ready), null);
  const blockers: Partial<PayoutReadiness>[] = [
    { chainOk: false }, { chainOk: null }, { hasWallet: false }, { errorCount: 1 },
    { recipientCount: 0 }, { recipientCount: MAX_RECIPIENTS + 1 }, { total: 0n },
    { batchCount: 0 }, { fee: null }, { balance: null }, { fee: -1n }, { balance: -1n },
    { balance: ready.balance! - 1n }, { running: true },
  ];
  for (const patch of blockers) assert.notEqual(getPayoutBlocker({ ...ready, ...patch }), null);
  assert.equal(getPayoutBlocker({ ...ready, fee: 0n, balance: ready.total }), null);
});

test("signed response must contain the original messages and valid signatures", () => {
  const original = [transfer(1), transfer(2)];
  const signed = original.map((tx) => { const copy = clone(tx); copy.sign(payer); return copy; });
  assert.doesNotThrow(() => validateSignedTransactions(original, signed, payer.publicKey));
  assert.throws(() => validateSignedTransactions(original, signed.slice(0, 1), payer.publicKey), /number of transactions/);
  assert.throws(() => validateSignedTransactions(original, [signed[1], signed[0]], payer.publicKey), /changed transaction/);
  assert.throws(() => validateSignedTransactions([original[0]], [clone(original[0])], payer.publicKey), /invalid or missing signature/);
  assert.throws(() => validateSignedTransactions(original, signed, key(240).publicKey), /signer changed/);
  const corrupt = clone(signed[0]);
  corrupt.signatures[0].signature![0] ^= 1;
  assert.throws(() => validateSignedTransactions([original[0]], [corrupt], payer.publicKey), /invalid or missing signature/);
});

test("wallet wrapper detects mutation of the transactions handed to the provider", async () => {
  const wallet = await connect({
    kind: "nightly",
    name: "Fixture",
    provider: {
      publicKey: payer.publicKey,
      async connect() { return { publicKey: payer.publicKey }; },
      async signAllTransactions(txs) {
        txs[0].instructions[0] = SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: key(2).publicKey,
          lamports: 999n,
        });
        txs[0].sign(payer);
        return txs;
      },
    },
  });
  await assert.rejects(wallet.signAllTransactions([transfer()]), /changed transaction/);
});

test("sequential signing works and an account change aborts before invoking signing", async () => {
  let calls = 0;
  const provider = {
    publicKey: payer.publicKey,
    async connect() { return { publicKey: payer.publicKey }; },
    async signTransaction(tx: Transaction) { calls += 1; tx.sign(payer); return tx; },
  };
  const wallet = await connect({ kind: "nightly", name: "Fixture", provider });
  assert.equal((await wallet.signAllTransactions([transfer(1), transfer(2)])).length, 2);
  assert.equal(calls, 2);
  provider.publicKey = key(240).publicKey;
  await assert.rejects(wallet.signAllTransactions([transfer()]), /account changed/);
  assert.equal(calls, 2);
});

test("provider detection accepts the Nightly fallback and filters unusable injections", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const provider = { connect: async () => undefined, signTransaction: async (tx: Transaction) => tx, isNightly: true };
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { solana: provider } });
    assert.deepEqual(detectProviders().map(({ kind, name }) => ({ kind, name })), [{ kind: "nightly", name: "Nightly" }]);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { nightly: { solana: provider }, solana: provider } });
    assert.equal(detectProviders().length, 1);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { solana: { connect: async () => undefined } } });
    assert.equal(detectProviders().length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
