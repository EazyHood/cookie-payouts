import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { GENESIS_HASH, RPC_URL, verifyChain } from "../src/chain.ts";

const envelope = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });

test("accepts only the expected Cookie Chain genesis and sends a read-only RPC request", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, RPC_URL);
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] });
    assert.equal(options.signal.aborted, false);
    return new Response(JSON.stringify(envelope(GENESIS_HASH)));
  });
  try {
    assert.deepEqual(await verifyChain(), { ok: true, genesis: GENESIS_HASH });
  } finally { fetchMock.mock.restore(); }
});

test("a well-formed but different genesis cannot authorize work on Cookie Chain", async () => {
  const wrong = "11111111111111111111111111111111";
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(envelope(wrong))));
  try {
    const result = await verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.genesis, wrong);
    assert.match(result.error!, /different chain/);
  } finally { fetchMock.mock.restore(); }
});

test("RPC errors and malformed responses never produce a successful chain check", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));
  try {
    for (const data of [
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Node unavailable" } },
      envelope(null), envelope(123), envelope("not a genesis hash"), [],
      { jsonrpc: "2.0", id: 2, result: GENESIS_HASH }, { result: GENESIS_HASH },
    ]) {
      fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(data)));
      const result = await verifyChain();
      assert.equal(result.ok, false);
      assert.equal(result.genesis, undefined);
      assert.ok(result.error);
    }
    fetchMock.mock.mockImplementation(async () => new Response("Unavailable", { status: 503 }));
    assert.match((await verifyChain()).error!, /HTTP 503/);
    fetchMock.mock.mockImplementation(async () => new Response("invalid json"));
    assert.equal((await verifyChain()).ok, false);
  } finally { fetchMock.mock.restore(); }
});

test("the 12-second deadline aborts a stalled fetch without waiting 12 real seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | undefined;
  const fetchMock = mock.method(globalThis, "fetch", async (_url, options) => {
    requestSignal = options.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  try {
    const pending = verifyChain();
    assert.equal(requestSignal?.aborted, false);
    t.mock.timers.tick(11_999);
    assert.equal(requestSignal?.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(requestSignal?.aborted, true);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error!, /timed out or was cancelled/);
  } finally { fetchMock.mock.restore(); t.mock.timers.reset(); }
});

test("an already-cancelled caller cannot receive a successful chain check", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchMock = mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  });
  try {
    assert.equal((await verifyChain(controller.signal)).ok, false);
  } finally { fetchMock.mock.restore(); }
});
