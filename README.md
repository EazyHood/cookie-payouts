# Cookie Payouts

**Pay many people on Cookie Chain in one approval, and hand out a receipt anyone can check against the chain.**

Live app: <https://eazyhood.github.io/cookie-payouts/>

A payout screenshot proves nothing — it is a picture of a claim. This app sends native COOK to a
list of addresses, then produces a link that carries nothing but transaction signatures. Whoever
opens that link re-reads those transactions from the Cookie Chain RPC **in their own browser**.
There is no server and no database, so there is no stored copy of the numbers that the person who
published the link could have edited.

The receipt can also come back negative. A signature that is not on chain says *not found*; a
transaction that confirmed without moving any COOK says so in as many words. A receipt that could
only ever say "paid" would be decoration.

## What it does

| Step | What happens |
| --- | --- |
| 1 · The list | Paste `address, amount` lines. Every unreadable line is reported with its number — nothing is skipped quietly. |
| 2 · The wallet | Connect Nightly. Balance, payout total and the real network fee are shown before anything is signed. |
| 3 · Send | Transfers are packed into as few transactions as fit, signed in one approval, and confirmed one by one with live status. |
| Receipt | A shareable link that re-verifies the whole payout from the chain. |

## Why the details are the way they are

**The wallet only signs; this app sends.** Several wallets implement `signAndSendTransaction` by
broadcasting through *their own* RPC. For a wallet that does not know Cookie Chain, that means the
transaction goes to Solana and vanishes. So the app asks only for a signature and submits the signed
bytes to `rpc.cookiescan.io` itself. That is the difference between a payout that lands and one that
silently does not.

**The chain is verified at runtime, not assumed.** On load the app calls `getGenesisHash` and
compares it with Cookie Chain's (`9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2`). The badge in the
header is that check, not a label.

**Batch sizes are measured, not guessed.** Instructions are added to a transaction until the
serialized message would cross the 1232-byte packet limit, then the batch is closed. A fixed guess
either wastes transactions or builds one the cluster rejects after the user has already approved it.

**Amounts never touch floating point.** `0.1 * 1e9` is `100000000.00000001` in JavaScript. Parsing
is done with string maths and `BigInt`, so what you type is what is transferred.

**The receipt reads inner instructions too.** The first real Cookie Chain transaction used for
testing moved value through a CPI, and a verifier that reads only top-level instructions reported it
as "confirmed" with zero transfers — a verified-looking receipt for nothing. Both levels are scanned.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

No API keys, no environment variables, no backend. `dist/` is a static bundle that can be served
from anywhere; the deployed copy is GitHub Pages.

## Layout

```
src/chain.ts     Cookie Chain constants, COOK formatting and parsing, genesis check
src/wallet.ts    Nightly and injected-wallet detection, sign-only interface
src/payout.ts    List parsing, measured batching, fee estimation
src/receipt.ts   Reading transactions back and summarising what was really paid
src/App.tsx      UI for both views: making a payout, and verifying a receipt
```

## Where it stops

- Native COOK only. SPL token payouts are the obvious next step and are not implemented.
- The receipt URL carries signatures, so a payout of hundreds of transactions makes a long link.
- Confirmation waits on `confirmed`, not `finalized`.

## License

Apache-2.0
