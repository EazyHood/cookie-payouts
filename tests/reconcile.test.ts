import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcilePayout, reconciliationCsv, type PayoutPlan } from "../src/reconcile.ts";
import type { VerifiedTx, VerifiedTransfer } from "../src/receipt.ts";

const plan: PayoutPlan = { sender: "treasury", recipients: [{ address: "alice", units: 100n }, { address: "bob", units: 200n }] };
const tx = (signature: string, transfers: VerifiedTransfer[], fields: Partial<VerifiedTx> = {}): VerifiedTx => ({
  signature, found: true, succeeded: true, status: "confirmed", transfers, ...fields,
});
const payment = (to: string, units: bigint, from = "treasury"): VerifiedTransfer => ({ from, to, units });

test("an exact plan match aggregates installments and deduplicates signatures", () => {
  const first = tx("one", [payment("alice", 30n)]);
  const result = reconcilePayout(plan, [first, first, tx("two", [payment("alice", 70n), payment("bob", 200n)])]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.rows.map((row) => row.status), ["paid", "paid"]);
  assert.deepEqual(result.totals, { expected: 300n, paid: 300n, delta: 0n });
});

test("wrong senders cannot satisfy even a correct amount and recipient", () => {
  const result = reconcilePayout(plan, [tx("wrong", [payment("alice", 100n, "someone-else"), payment("bob", 200n, "someone-else")])]);
  assert.equal(result.complete, false);
  assert.equal(result.ignoredTransfers, 2);
  assert.equal(result.totals.paid, 0n);
  assert.deepEqual(result.rows.map((row) => row.status), ["missing", "missing"]);
});

test("reports missing, underpaid, overpaid and unexpected recipients independently", () => {
  const expanded = { ...plan, recipients: [...plan.recipients, { address: "carol", units: 10n }] };
  const result = reconcilePayout(expanded, [tx("differences", [payment("alice", 40n), payment("bob", 230n), payment("stranger", 70n)])]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.rows.map((row) => [row.address, row.status, row.delta]), [
    ["alice", "underpaid", -60n], ["bob", "overpaid", 30n], ["carol", "missing", -10n], ["stranger", "unexpected", 70n],
  ]);
  assert.deepEqual(result.totals, { expected: 310n, paid: 340n, delta: 30n });
});

test("a zero net delta does not hide a shortfall offset by an extra recipient", () => {
  const result = reconcilePayout(plan, [tx("offset", [payment("alice", 100n), payment("bob", 150n), payment("stranger", 50n)])]);
  assert.equal(result.totals.delta, 0n);
  assert.equal(result.complete, false);
});

test("unresolved and failed signatures prevent a complete result even with exact observed amounts", () => {
  const paid = tx("paid", [payment("alice", 100n), payment("bob", 200n)]);
  const result = reconcilePayout(plan, [paid,
    tx("missing", [], { status: "not_found", found: false, succeeded: false }),
    tx("rpc", [], { status: "rpc_error", found: false, succeeded: false }),
    tx("unknown", [], { status: "unresolved", succeeded: false }),
    tx("failed", [payment("alice", 1000n)], { status: "failed", succeeded: false }),
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.unresolved, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.totals.paid, 300n);
});

test("aggregates duplicate plan rows and refuses empty or invalid plans as paid", () => {
  const repeated: PayoutPlan = { sender: "treasury", recipients: [{ address: "alice", units: 40n }, { address: "alice", units: 60n }] };
  const result = reconcilePayout(repeated, [tx("match", [payment("alice", 100n)])]);
  assert.equal(result.complete, true);
  assert.equal(result.rows.length, 1);
  assert.equal(reconcilePayout({ sender: "treasury", recipients: [] }, []).complete, false);
  assert.throws(() => reconcilePayout({ sender: "", recipients: plan.recipients }, []), /sender/);
  assert.throws(() => reconcilePayout({ sender: "treasury", recipients: [{ address: "alice", units: 0n }] }, []), /positive/);
});

test("CSV uses exact base units, escapes quotes and neutralizes spreadsheet formulas", () => {
  const result = reconcilePayout({ sender: "treasury", recipients: [{ address: '=HYPERLINK("bad","click")', units: 9007199254740993n }] }, []);
  const csv = reconciliationCsv(result);
  assert.ok(csv.startsWith("address,expected_base_units,paid_base_units,delta_base_units,status\r\n"));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"",""click"")"'));
  assert.ok(csv.includes(",9007199254740993,0,-9007199254740993,\"missing\"\r\n"));
});

test("an inconsistent confirmed status cannot turn failed execution into a match", () => {
  const result = reconcilePayout(plan, [tx("inconsistent", [payment("alice", 100n), payment("bob", 200n)], { succeeded: false })]);
  assert.equal(result.complete, false);
  assert.equal(result.unresolved, 1);
  assert.equal(result.totals.paid, 0n);
});
