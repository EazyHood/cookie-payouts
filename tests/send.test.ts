import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { submitSignedBatches, type SendRpc } from "../src/send.ts";
import type { BatchStatus } from "../src/payout.ts";

const payer = Keypair.fromSeed(new Uint8Array(32).fill(240));
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(241)).publicKey.toBase58();
function fixtures(count = 3): Transaction[] {
  return Array.from({ length: count }, (_, index) => {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
    tx.add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.fromSeed(new Uint8Array(32).fill(index + 1)).publicKey,
      lamports: BigInt(index + 1),
    }));
    tx.sign(payer);
    return tx;
  });
}
const signatureOf = (tx: Transaction) => bs58.encode(tx.signature!);

function harness(override: Partial<SendRpc> = {}) {
  const statuses = new Map<number, BatchStatus>();
  const journal: string[] = [];
  const events: string[] = [];
  const rpc: SendRpc = {
    async getBlockHeight() { events.push("height"); return 99; },
    async sendRawTransaction(bytes, options) {
      const signature = signatureOf(Transaction.from(bytes));
      assert.equal(journal.at(-1), signature, "the signature must already be saved before RPC submission");
      assert.equal(options.skipPreflight, false);
      events.push(`send:${signature}`);
      return signature;
    },
    async confirmTransaction(strategy) {
      assert.equal(strategy.blockhash, blockhash);
      assert.equal(strategy.lastValidBlockHeight, 100);
      events.push(`confirm:${strategy.signature}`);
      return { value: { err: null } };
    },
    ...override,
  };
  const onStatus = (index: number, status: BatchStatus) => statuses.set(index, status);
  const save = (signature: string) => { journal.push(signature); events.push(`save:${signature}`); };
  const run = (txs = fixtures()) => submitSignedBatches(txs, blockhash, 100, rpc, onStatus, save);
  return { statuses, journal, events, rpc, onStatus, save, run };
}

test("each identifier is journaled before a single broadcast and confirmation", async () => {
  const txs = fixtures();
  const h = harness();
  await h.run(txs);
  assert.deepEqual(h.journal, txs.map(signatureOf));
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["confirmed", "confirmed", "confirmed"]);
  assert.deepEqual(h.events, txs.flatMap(tx => ["height", `save:${signatureOf(tx)}`, `send:${signatureOf(tx)}`, `confirm:${signatureOf(tx)}`]));
});

test("a journal failure prevents the first broadcast and skips the remaining batches", async () => {
  const h = harness();
  await submitSignedBatches(fixtures(), blockhash, 100, h.rpc, h.onStatus, () => {
    throw new Error("Storage unavailable");
  });
  assert.equal(h.journal.length, 0);
  assert.deepEqual(h.events, ["height"]);
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["failed", "skipped", "skipped"]);
});

test("a timeout during broadcast is uncertain and never triggers a retry or later batch", async () => {
  let calls = 0;
  const h = harness({ async sendRawTransaction() { calls++; throw new Error("RPC timeout after upload"); } });
  const txs = fixtures();
  await h.run(txs);
  assert.equal(calls, 1);
  assert.deepEqual(h.journal, [signatureOf(txs[0])]);
  assert.deepEqual(h.statuses.get(0), { state: "uncertain", signature: signatureOf(txs[0]), error: "RPC timeout after upload" });
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["uncertain", "skipped", "skipped"]);
});

test("confirmation uncertainty preserves prior confirmations and stops unattempted batches", async () => {
  let confirmations = 0;
  const h = harness({ async confirmTransaction() {
    confirmations++;
    if (confirmations === 2) throw new Error("Confirmation unavailable");
    return { value: { err: null } };
  } });
  const txs = fixtures();
  await h.run(txs);
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["confirmed", "uncertain", "skipped"]);
  assert.deepEqual(h.journal, txs.slice(0, 2).map(signatureOf));
  assert.equal(h.events.filter(event => event.startsWith("send:")).length, 2);
});

test("an explicit on-chain error is failed, keeps its identifier, and stops later batches", async () => {
  const h = harness({ async confirmTransaction() { return { value: { err: { InstructionError: [0, "Custom"] } } }; } });
  const txs = fixtures();
  await h.run(txs);
  assert.deepEqual(h.statuses.get(0), { state: "failed", signature: signatureOf(txs[0]), error: '{"InstructionError":[0,"Custom"]}' });
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["failed", "skipped", "skipped"]);
  assert.equal(h.journal.length, 1);
});

test("an unexpected RPC identifier remains uncertain under the locally signed identifier", async () => {
  const h = harness({ async sendRawTransaction() { return "a-different-identifier"; } });
  const txs = fixtures();
  await h.run(txs);
  assert.deepEqual(h.statuses.get(0), { state: "uncertain", signature: signatureOf(txs[0]), error: "RPC returned an unexpected transaction identifier." });
  assert.deepEqual(h.journal, [signatureOf(txs[0])]);
  assert.equal(h.events.some(event => event.startsWith("confirm:")), false);
});

test("expired approval and failed block-height reads do not journal or broadcast", async () => {
  for (const getBlockHeight of [async () => 101, async (): Promise<number> => { throw new Error("Height unavailable"); }]) {
    const h = harness({ getBlockHeight });
    await h.run();
    assert.equal(h.journal.length, 0);
    assert.equal(h.events.length, 0);
    assert.deepEqual([...h.statuses.values()].map(status => status.state), ["failed", "skipped", "skipped"]);
  }
});

test("expiry between batches preserves the confirmed batch without broadcasting the next", async () => {
  let reads = 0;
  const h = harness({ async getBlockHeight() { return ++reads === 1 ? 100 : 101; } });
  const txs = fixtures();
  await h.run(txs);
  assert.deepEqual(h.journal, [signatureOf(txs[0])]);
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["confirmed", "failed", "skipped"]);
});

test("a missing signature is rejected before saving or broadcasting anything", async () => {
  const txs = fixtures();
  txs[0].signatures[0].signature = null;
  const h = harness();
  await h.run(txs);
  assert.equal(h.journal.length, 0);
  assert.deepEqual(h.events, ["height"]);
  assert.deepEqual([...h.statuses.values()].map(status => status.state), ["failed", "skipped", "skipped"]);
});
