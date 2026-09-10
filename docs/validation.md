# Validation record — 9 September 2026

This records what was checked for the reconciliation update. It is not a security audit or proof of an end-to-end payout from this application.

## Automated checks

`npm test`: **52 tests passed**. `npm run lint`: no warnings or errors. `npm run build`: completed; Vite reports a bundle-size warning (about 682 kB minified JavaScript before compression).

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

## Workspace design review

The payment workspace, reconciliation view and receipt were restyled with a dark sidebar, light working surfaces, consistent controls and responsive layouts. Payment parsing, signing, persistence, chain reads and reconciliation modules were unchanged.

Browser checks covered 375 px mobile, 768 px tablet and 1440 px desktop layouts without horizontal page overflow. The three receipt navigation links fit on mobile; the receipt stacks its heading and transaction count. The sidebar scrolls independently at reduced desktop height. Keyboard focus is visible, visible form labels are retained as accessible names, network details expose the current network state, and reduced-motion preferences are respected.

The public reference still produced a 100 COOK match and a 101 COOK expected-versus-100 observed shortfall. An entered recipient appeared in the payment preview with the exact 12.5 COOK total; payment remained disabled without a connected wallet. No wallet connection, signing or broadcast was performed for this design review. Build, lint and all 52 existing tests passed after the redesign.

## Nightly Wallet Standard compatibility — 10 September 2026 UTC

The previous detector required legacy `connect` and signing methods directly on the injected provider. A Nightly provider exposing only Wallet Standard was therefore omitted. The adapter now discovers Nightly through the standard registry or namespace, retains the legacy fallback, deduplicates aliases, and refreshes the UI when wallets register or unregister. Generic injections are not labelled as Nightly, including in connection error guidance.

The standard path connects an authorized Solana/SVM account and requests `solana:signTransaction` only. It preserves the existing transaction-message and signature checks and rejects missing responses, changed messages and revoked accounts before allowing the caller to broadcast. It never requests `signAndSendTransaction` or changes the wallet's network.

All **65 tests passed**, including 13 new standard-wallet cases; lint and production build passed. The new cases cover standard-only and legacy detection, deduplication, account capabilities, exact transaction bytes, altered or unsigned responses, missing batches, account revocation and late registration cleanup. These use controlled wallet fixtures; no funds were moved by them. The production preview loaded with an unrelated injected provider, displayed the explicit Nightly-not-detected guidance and kept payment disabled without a connected account. The live browser's previous `501` error alone does not identify its wallet implementation.

This closes a compatibility gap in the code. It is **not** evidence of a completed real Nightly connection or an application-originated Cookie Chain payout. The actual Nightly extension and funded round trip remain unverified. The production JavaScript bundle is approximately 688 kB before compression and retains Vite's size warning.

Contract references: [Nightly detection](https://docs.nightly.app/docs/solana/solana/detection/), [Nightly connection](https://docs.nightly.app/docs/solana/solana/connect/), [Solana Wallet Standard signing interface](https://github.com/solana-labs/wallet-standard/blob/master/packages/core/features/src/signTransaction.ts).

## Interpretation limits

Read-only checks use the configured public RPC at `confirmed` commitment. They compare native System Program transfer instructions, not finality, net balance settlement, identity or payment purpose. They inspect only supplied signatures, not all chain history. Unknown, failed, conflicting or incomplete observations cannot yield a complete reconciliation. SPL tokens and custom payout programs are outside the application's current scope.

Before claiming a fully validated payout workflow, a Cookie Chain account with sufficient native COOK must complete an application-originated Nightly signing, broadcast, confirmation and receipt/reconciliation round trip. Publish its actual signature and observed outcome only after that occurs.
