# Cookie Payouts

**Batch native COOK payments, then check each recipient against the original plan.**

[Pay](https://eazyhood.github.io/cookie-payouts/#make) · [Try reconciliation without a wallet](https://eazyhood.github.io/cookie-payouts/#/audit) · [Source](https://github.com/EazyHood/cookie-payouts)

A community manager needs more than a successful transaction: the right people must receive the right amounts. Cookie Payouts prepares payments on Cookie Chain and provides a separate reconciliation view. Give it an expected sender, a recipient list and transaction signatures; it reads native transfers from the chain and reports missing amounts, overpayments and unexpected recipients.

**Validation scope:** the public example below is an external transaction, not a payment created by this app. End-to-end payment signing, broadcasting and confirmation with Nightly have **not yet been validated** for this submission. Automated tests exercise the implementation with fixtures and controlled RPC/wallet responses; they do not substitute for that wallet test.

## Review it in a minute

1. Open [Reconcile](https://eazyhood.github.io/cookie-payouts/#/audit) and select **Load example**. No wallet or funds are required.
2. Select **Compare with the chain**. The example contains one native transfer of 100 COOK.
3. Change the expected amount and compare again:

| Expected COOK | Observed COOK | Result for the supplied plan |
| --- | --- | --- |
| 100 | 100 | Match |
| 101 | 100 | Underpaid by 1 COOK |
| 99 | 100 | Overpaid by 1 COOK |

4. Export the reconciliation CSV, download the comparison plan or open the transaction receipt. Missing transactions or unavailable RPC data prevent a complete result; a partial observation is not proof that a payment failed.

The [original public transaction](https://cookiescan.io/tx/LiNmNJa4WxS7DG1zCZR7q6pwtiHRtM3zdXemP4Nkrk9crp2Cy4yZCFSLSoLTW95xX45wzccn74pUjejdArQv7aQ) was independently read from Cookie Chain at slot `23437496` with a successful execution result. Its native transfer is:

```text
Sender:    BwwXgbiHMWqukbxzTjK9QJcp8EPBLc7hWo2A2e9xEsGt
Recipient: 33n68Rpis2dGYv36xTHaxeMGvkwXDRJnxAHLmFn2o3J3
Amount:    100000000000 base units = 100 COOK
```

We do not assert its purpose or authorship. It demonstrates reading and comparison only. Changing the example's expected amount changes a local comparison input, not the transaction.

## Pay and keep the plan

1. Install [Nightly](https://nightly.app/) and configure it for Cookie Chain using the [official wallet guide](https://docs.cookiechain.wtf/wallets). If funds are on Solana, follow the [official bridge guide](https://docs.cookiechain.wtf/bridge) and use its [Hyperlane bridge](https://hyperlane.cookiescan.io). The app does not bridge funds.
2. Open **Pay**, connect Nightly and paste one `address, amount` line per recipient. The limit is 200 recipients. Invalid or duplicate rows block sending until corrected.
3. Review the connected address, balance, recipient list, total and network fee estimate. **Download plan before paying** saves the expected sender and exact amounts as JSON.
4. Approve the required transactions in your wallet. Batch signing is preferred when available; otherwise the app requests signatures sequentially. The wallet controls the number of prompts.
5. Review each batch's status, open its receipt and use **Reconcile this run**. Import the saved plan to compare it with the recorded signatures.

The wallet signs; the app submits the signed bytes to `https://rpc.cookiescan.io`. It checks the returned messages and signatures before broadcasting, rechecks the chain and funding requirements before signing, and stops for review if the fee estimate changed.

## What reconciliation establishes

The reader fetches the supplied signatures from Cookie Chain in their own browser. Only successfully executed native System Program transfer instructions count. The parser checks the program identifier, reads top-level and inner instructions, and retains the source of each transfer. Transfers from a different sender are excluded, repeated signatures count once, and incomplete or conflicting observations remain unresolved.

The report compares amounts per destination, so an extra payment cannot conceal another recipient's shortfall merely because the totals balance. It checks only the supplied signatures; it does not search the sender's entire history.

A plan is **user-supplied input**, not an authenticated prior agreement. A match does not prove who controls an address, why money moved, that the plan existed before payment, or final net account settlement. The receipt URL contains transaction signatures; share the plan separately when another person needs to reproduce the comparison.

Plans are versioned JSON files tied to Cookie Chain's genesis hash, with amounts stored as decimal strings in base units. The reconciliation CSV contains recipient, expected amount, observed amount, difference and status. Its amount columns use base units (`1 COOK = 1,000,000,000`); preserve them as text in spreadsheets when exact large integers matter.

## Interrupted runs and duplicate-payment protection

Before each broadcast attempt, the app saves the signed transaction identifier, sender, original list and timestamp in a local browser journal. If that write fails, it stops before broadcasting that batch. A timeout after an attempted broadcast is **uncertain**, not automatically failed: remaining batches stop and the saved receipt remains available for checking. The app does not create a replacement payment automatically.

Web Locks coordinate sending across tabs on the same origin. A saved run blocks another payout until the user reviews it and explicitly starts a different one. Sending requires Web Locks and usable local storage; reconciliation remains available without a wallet.

This journal is recovery assistance, not a global payment registry. Clearing site data loses it, and it does not coordinate separate browser profiles, origins or devices. Download the run record and original plan before clearing an interrupted run. Paying the same list again can duplicate payments even after clearing the record.

## Development and tests

```bash
npm install
npm run dev      # local app
npm test         # regression tests; no live payments
npm run lint
npm run build    # TypeScript check and static output in dist/
npm run preview
```

No API keys, environment variables or application backend are required. The public deployment uses GitHub Pages. Reads depend on Cookie Chain's public RPC; the RPC receives the addresses and signatures queried.

Tests cover exact amount parsing, invalid and duplicate recipient rows, transaction packing, wallet response validation, sender filtering, duplicate signatures, failed and unresolved receipts, plan import/export, CSV escaping and interrupted-send behavior. Browser wallet signing and the Web Locks/local-storage interaction still require their own integration checks.

See the [dated validation record](docs/validation.md) for the commands run, observed browser results and remaining gaps.

```text
src/chain.ts       Network constants, integer amount parsing and genesis check
src/wallet.ts      Injected wallet detection, signing and response validation
src/payout.ts      Recipient validation, batch construction and fee estimates
src/send.ts        Broadcast/confirmation states and journal-before-send hook
src/receipt.ts     Native transfer extraction and receipt verification
src/reconcile.ts   Expected-versus-observed comparison and CSV export
src/plan.ts        Versioned plan import/export
src/AuditView.tsx  Reconciliation and public reference walkthrough
src/App.tsx        Payment UI, local run journal and Web Locks coordination
tests/             Regression tests
```

## Scope

- Native COOK only; no SPL payouts or custom on-chain program.
- Reads and confirmations use `confirmed`, not `finalized`.
- Decimal amounts are parsed with strings and `BigInt`, preserving up to nine decimal places without floating-point amount multiplication.
- Reconciliation accepts up to 50 unique signatures. Long receipts produce long URLs.
- The chain check compares `getGenesisHash` with `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2`; it identifies the configured network, not the trustworthiness of every RPC response.
- The public reference and unit tests do not establish a completed Nightly payment by Cookie Payouts.

## License

[Apache-2.0](LICENSE)
