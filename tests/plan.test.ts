import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { GENESIS_HASH, MAX_TRANSFER_UNITS } from "../src/chain.ts";
import { parseRecipients } from "../src/payout.ts";
import { planJson, readPlan } from "../src/plan.ts";

const address = (index: number) => Keypair.fromSeed(new Uint8Array(32).fill(index)).publicKey.toBase58();
const plan = {
  sender: address(250),
  recipients: [{ address: address(1), units: 1n }, { address: address(2), units: MAX_TRANSFER_UNITS }],
};
const document = () => JSON.parse(planJson(plan));

test("plan export/import preserves the sender and exact integer amounts through u64", () => {
  const serialized = planJson(plan);
  const json = JSON.parse(serialized);
  assert.equal(json.version, 1);
  assert.equal(json.chain, GENESIS_HASH);
  assert.equal(json.recipients[1].amountBaseUnits, MAX_TRANSFER_UNITS.toString());
  const restored = readPlan(serialized);
  assert.equal(restored.sender, plan.sender);
  assert.deepEqual(parseRecipients(restored.recipientsText).recipients.map(({ address, units }) => ({ address, units })), plan.recipients);
});

test("plan import rejects the wrong chain, unsupported version, empty or duplicate recipients", () => {
  const invalid = [
    { ...document(), chain: "another-chain" },
    { ...document(), version: 2 },
    { ...document(), recipients: [] },
    { ...document(), recipients: [document().recipients[0], document().recipients[0]] },
    { ...document(), recipients: Array(201).fill(document().recipients[0]) },
  ];
  for (const value of invalid) assert.throws(() => readPlan(JSON.stringify(value)));
  assert.throws(() => readPlan(" ".repeat(50_001)), /too large/);
  assert.throws(() => readPlan("not json"));
});

test("plan import rejects imprecise, zero, negative or out-of-range amounts", () => {
  for (const amountBaseUnits of [1, "1.1", "0", "-1", "1e9", (MAX_TRANSFER_UNITS + 1n).toString(), "9".repeat(21)]) {
    assert.throws(() => readPlan(JSON.stringify({ ...document(), recipients: [{ address: address(1), amountBaseUnits }] })));
  }
});

test("a sender must be an address string, not another PublicKey constructor input", () => {
  for (const sender of [1, Array(32).fill(1), null, {}, "invalid"]) {
    assert.throws(() => readPlan(JSON.stringify({ ...document(), sender })));
  }
});

test("plan addresses cannot inject additional recipient rows during import", () => {
  const maliciousAddress = `${address(1)}, 1\n${address(2)}`;
  assert.throws(() => readPlan(JSON.stringify({
    ...document(),
    recipients: [{ address: maliciousAddress, amountBaseUnits: "1" }],
  })));
});
