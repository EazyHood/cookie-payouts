# Validation record — 9 September 2026

This records what was checked for the reconciliation update. It is not a security audit or proof of an end-to-end payout from this application.

## Automated checks

`npm test`: **52 tests passed**. `npm run lint`: no warnings or errors. `npm run build`: completed; Vite reports a bundle-size warning (about 670 kB minified JavaScript before compression).

The tests cover exact nine-decimal amounts and u64 limits, malformed and duplicate rows, 200-recipient limits, serialized batch sizes, missing funds/fees/network guards, wallet message mutation and signatures, plan import/export, RPC response validation and cancellation, native top-level/CPI parsing, duplicate signatures, reconciliation discrepancies and CSV escaping. Sending tests use locally generated test keys and mocked RPC calls to check persistence before broadcast, expiry, failures, uncertainty and stopping later batches. They do not transfer funds.

The cross-tab Web Locks and recovery-record checks were reviewed in code. They have not been exercised with simultaneous live-wallet payouts.

## Browser dependency regression

The development console exposed a `buffer` externalization warning from a dependency fallback. A browser fixture constructed, locally signed and verified a 215-byte native-transfer transaction successfully even before the dependency change; the warning alone did not prove payment failure. Vite now explicitly resolves `buffer` to the browser package, with that package declared directly.

`tests/browser-smoke.html` exercises the actual transaction construction, serialization and signature-verification code with disposable local keys, preserving `1.000000001` COOK exactly. It makes no wallet connection, RPC call or broadcast. To check the production-bundled fixture separately from the deployed app:

```bash
npx vite build --config tests/vite.browser.config.ts
npx vite preview --config tests/vite.browser.config.ts --host 127.0.0.1 --port 4176
# Open http://127.0.0.1:4176/tests/browser-smoke.html
```

The fixture is a browser compatibility check, not Nightly integration or proof of payment.

## Browser checks using a real public transaction

Reference: [public Cookie Chain transaction](https://cookiescan.io/tx/LiNmNJa4WxS7DG1zCZR7q6pwtiHRtM3zdXemP4Nkrk9crp2Cy4yZCFSLSoLTW95xX45wzccn74pUjejdArQv7aQ).

- Sender: `BwwXgbiHMWqukbxzTjK9QJcp8EPBLc7hWo2A2e9xEsGt`
- Recipient: `33n68Rpis2dGYv36xTHaxeMGvkwXDRJnxAHLmFn2o3J3`
- Native transfer observed: `100000000000` base units = 100 COOK.
- Slot: `23437496`; fee: `5005` base units; execution error: `null`.

**This is an external reference. It was not created by Cookie Payouts or by this review. Its author, purpose and relationship to any bounty entry are not asserted.** The expected plan is supplied for comparison; it is not an authenticated prior agreement.

| Browser action | Observed result |
| --- | --- |
| Load public example and compare 100 COOK | Match; 100 expected and 100 observed from the specified sender |
| Change expected amount to 101 | Old result disappears; new result says `underpaid`, 100 observed |
| Change expected amount to 99 | `overpaid`, 100 observed |
| Export the 99-COOK comparison | Downloaded CSV contains expected `99000000000`, paid `100000000000`, delta `1000000000`, status `overpaid` |
| Open the reference receipt | One confirmed transaction, one unique recipient, 100 native COOK, correct fee/source/slot |
| Open Pay with an empty list | Zero recipients; sending and plan export disabled |
| Add duplicate recipient rows | Line-specific duplicate error; sending disabled |
| Review desktop and narrow viewport | Navigation and forms fit; wide comparison table scrolls inside its container |

No wallet was connected, no transaction was signed, and no funds were moved during these browser checks. The previously observed Nightly error, `Unable to find any account for 501`, remains an unresolved end-to-end setup gap.

## Interpretation limits

Read-only checks use the configured public RPC at `confirmed` commitment. They compare native System Program transfer instructions, not finality, net balance settlement, identity or payment purpose. They inspect only supplied signatures, not all chain history. Unknown, failed, conflicting or incomplete observations cannot yield a complete reconciliation. SPL tokens and custom payout programs are outside the application's current scope.

Before claiming a fully validated payout workflow, a Cookie Chain account with sufficient native COOK must complete an application-originated Nightly signing, broadcast, confirmation and receipt/reconciliation round trip. Publish its actual signature and observed outcome only after that occurs.
