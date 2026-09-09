import assert from "node:assert/strict";
import { test, mock } from "node:test";
import bs58 from "bs58";
import {
  SYSTEM_PROGRAM_ID, decodeReceipt, encodeReceipt, parseVerifiedTransaction,
  summarize, validateReceiptSignatures, verifyAll, verifyOne, type VerifiedTx,
} from "../src/receipt.ts";

const signature = (index: number) => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i + index) % 256));

function transfer(source: string, destination: string, lamports: unknown, programId: unknown = SYSTEM_PROGRAM_ID, type = "transfer") {
  return { programId, parsed: { type, info: { source, destination, lamports } } };
}

function response(instructions: unknown[] = [], meta: Record<string, unknown> = {}) {
  return {
    slot: 42, blockTime: 123456,
    transaction: { message: { instructions } },
    meta: { err: null, fee: 5000, innerInstructions: [], ...meta },
  };
}

test("extracts top-level and CPI native transfers with their individual sources", () => {
  const tx = parseVerifiedTransaction("one", response([
    transfer("alice", "bob", 10),
    transfer("fake", "bob", 500, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  ], { innerInstructions: [{ index: 0, instructions: [transfer("carol", "dave", "20")] }] }));
  assert.equal(tx.status, "confirmed");
  assert.equal(tx.from, undefined);
  assert.deepEqual(tx.transfers, [{ from: "alice", to: "bob", units: 10n }, { from: "carol", to: "dave", units: 20n }]);
  assert.equal(tx.fee, 5000n);
});

test("recognizes SDK PublicKey program IDs and transferWithSeed source accounts", () => {
  const tx = parseVerifiedTransaction("seed", response([
    transfer("derived-source", "recipient", 12, { toBase58: () => SYSTEM_PROGRAM_ID }, "transferWithSeed"),
  ]));
  assert.equal(tx.from, "derived-source");
  assert.deepEqual(tx.transfers, [{ from: "derived-source", to: "recipient", units: 12n }]);
});

test("does not trust a system label or arbitrary parsed transfer without the program ID", () => {
  const fake = { program: "system", parsed: { type: "transfer", info: { source: "a", destination: "b", lamports: 99 } } };
  const tx = parseVerifiedTransaction("fake", response([fake]));
  assert.deepEqual(tx.transfers, []);
  assert.equal(summarize([tx]).total, 0n);
  assert.equal(tx.status, "unresolved");
});

test("rejects unsafe, negative, fractional and nondecimal native transfer amounts", () => {
  for (const amount of [Number.MAX_SAFE_INTEGER + 1, -1, 0.1, NaN, Infinity, "-1", "1.5", "1e9", "18446744073709551616"]) {
    const tx = parseVerifiedTransaction(String(amount), response([transfer("a", "b", amount)]));
    assert.equal(tx.status, "unresolved", String(amount));
    assert.equal(tx.succeeded, false);
    assert.deepEqual(tx.transfers, []);
    assert.equal(summarize([tx]).total, 0n);
  }
  const exact = parseVerifiedTransaction("large", response([transfer("a", "b", "18446744073709551615")]));
  assert.equal(exact.transfers[0].units, 18446744073709551615n);
});

test("a failed transaction exposes its fee and failure, never its attempted transfers", () => {
  const tx = parseVerifiedTransaction("failed", response([transfer("a", "b", 50)], { err: { InstructionError: [0, "Custom"] } }));
  assert.equal(tx.status, "failed");
  assert.deepEqual(tx.transfers, []);
  const summary = summarize([tx]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.total, 0n);
  assert.equal(summary.fees, 5000n);
});

test("missing metadata, missing execution result and unavailable CPI records are unresolved", () => {
  for (const input of [
    { ...response(), meta: null },
    { ...response(), meta: { fee: 5000, innerInstructions: [] } },
    response([], { innerInstructions: null }),
    response([], { innerInstructions: [{ index: 0 }] }),
    response([], { fee: Number.MAX_SAFE_INTEGER + 1 }),
    response([{ programId: SYSTEM_PROGRAM_ID, data: "unparsed" }]),
  ]) {
    const tx = parseVerifiedTransaction("incomplete", input);
    assert.equal(tx.status, "unresolved");
    assert.equal(tx.succeeded, false);
  }
});

test("not found, RPC error and execution failure have separate counts", () => {
  const notFound = parseVerifiedTransaction("absent", null);
  const rpcError: VerifiedTx = { signature: "timeout", found: false, succeeded: false, status: "rpc_error", error: "Timeout", transfers: [] };
  const failed = parseVerifiedTransaction("failed", response([], { err: { InstructionError: [0, "failed"] } }));
  const summary = summarize([notFound, rpcError, failed]);
  assert.equal(summary.missing, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unresolved, 1);
  assert.equal(summary.rpcErrors, 1);
});

test("duplicate signatures never inflate payments, recipient count or fee totals", async () => {
  const tx = parseVerifiedTransaction("one", response([transfer("a", "b", 10), transfer("a", "b", 20)]));
  const summary = summarize([tx, { ...tx }]);
  assert.equal(summary.total, 30n);
  assert.equal(summary.recipients, 1);
  assert.equal(summary.paid, 1);
  assert.equal(summary.fees, 5000n);
  const one = signature(1), two = signature(2);
  assert.deepEqual(decodeReceipt(` ${one}..${one}.${two}. `), [one, two]);
  assert.equal(encodeReceipt([one, one, ` ${two} `]), `${one}.${two}`);
  const reads: string[] = [];
  const results = await verifyAll([one, one, ` ${one} `, "", two], async (signature) => {
    reads.push(signature);
    return { ...tx, signature };
  });
  assert.deepEqual(reads, [one, two]);
  assert.equal(results.length, 2);
});

test("conflicting observations for the same signature do not produce a positive receipt", () => {
  const first = parseVerifiedTransaction("same", response([transfer("a", "b", 10)]));
  const second = parseVerifiedTransaction("same", response([transfer("a", "b", 20)]));
  const summary = summarize([first, second]);
  assert.equal(summary.total, 0n);
  assert.equal(summary.paid, 0);
  assert.equal(summary.unresolved, 1);
});

test("rejects invalid or excessive signatures before invoking any RPC reader", async () => {
  for (const values of [[], ["not-a-signature"], ["1".repeat(1000)], ["0".repeat(88)], Array.from({ length: 51 }, (_, index) => signature(index))]) {
    let reads = 0;
    await assert.rejects(verifyAll(values, async (sig) => {
      reads++;
      return parseVerifiedTransaction(sig, null);
    }));
    assert.equal(reads, 0);
  }
  assert.throws(() => validateReceiptSignatures(["1".repeat(65)]), /signature/i);
  const oversized = "1.".repeat(10000);
  assert.deepEqual(decodeReceipt(oversized), [oversized]);
  await assert.rejects(verifyAll(decodeReceipt(oversized)), /large|invalid/i);
});

test("RPC errors are unknown, while a successful null result means not found", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Node unavailable" } }), { status: 200 }));
  try {
    const failedRead = await verifyOne(signature(1));
    assert.equal(failedRead.status, "rpc_error");
    assert.equal(failedRead.error, "Node unavailable");
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 }));
    assert.equal((await verifyOne(signature(1))).status, "not_found");
  } finally { fetchMock.mock.restore(); }
});

test("cancellation aborts the actual RPC fetch and leaves payment status unknown", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  });
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await verifyOne(signature(1), controller.signal);
    assert.equal(result.status, "rpc_error");
    assert.match(result.error!, /unknown/);
  } finally { fetchMock.mock.restore(); }
});

test("an RPC response for another transaction cannot validate the requested receipt", async () => {
  const result = { ...response([transfer("a", "b", 100)]), transaction: { signatures: [signature(2)], message: { instructions: [transfer("a", "b", 100)] } } };
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 }));
  try {
    const tx = await verifyOne(signature(1));
    assert.equal(tx.status, "rpc_error");
    assert.match(tx.error!, /does not match/);
    assert.deepEqual(tx.transfers, []);
  } finally { fetchMock.mock.restore(); }
});

test("bounded concurrent reads retain input order and rejected reads become unresolved", async () => {
  let active = 0, peak = 0;
  const signatures = Array.from({ length: 8 }, (_, index) => signature(index));
  const results = await verifyAll(signatures, async (sig) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (sig === signatures[3]) throw new Error("read failed");
    return parseVerifiedTransaction(sig, null);
  });
  assert.ok(peak <= 4);
  assert.deepEqual(results.map(tx => tx.signature), signatures);
  assert.equal(results[3].status, "rpc_error");
});
