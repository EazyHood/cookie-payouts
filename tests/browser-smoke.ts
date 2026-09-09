import { Keypair, Transaction } from "@solana/web3.js";
import { buildBatches, parseRecipients } from "../src/payout";
import { validateSignedTransactions } from "../src/wallet";

// Browser-specific regression: Node tests can hide missing Buffer dependencies.
// These disposable keys never receive funds and no RPC method is invoked.
const result = document.getElementById("result")!;
try {
  const signer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const parsed = parseRecipients(`${recipient.toBase58()}, 1.000000001`);
  const batches = buildBatches(signer.publicKey, parsed.recipients, Keypair.generate().publicKey.toBase58(), 100);
  const original = batches.map(({tx}) => Transaction.from(tx.serialize({requireAllSignatures:false,verifySignatures:false})));
  const signed = batches.map(({tx}) => { tx.sign(signer); return tx; });
  validateSignedTransactions(original, signed, signer.publicKey);
  const sizes = signed.map(tx => tx.serialize().length);
  if (parsed.total !== 1_000_000_001n || sizes.some(n => n > 1232)) throw new Error("Incorrect transfer amount or transaction size.");
  result.textContent = `PASS: browser constructs, locally signs and verifies ${signed.length} transaction; ${sizes.join(", ")} bytes; exact amount ${parsed.total} base units. No broadcast.`;
} catch (error) {
  result.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
}
