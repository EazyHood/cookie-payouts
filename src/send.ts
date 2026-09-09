import bs58 from "bs58";
import type { Transaction } from "@solana/web3.js";
import type { BatchStatus } from "./payout";

export interface SendRpc {
  getBlockHeight(commitment: "confirmed"): Promise<number>;
  sendRawTransaction(bytes: Uint8Array, options: { skipPreflight: boolean; preflightCommitment: "confirmed"; maxRetries: number }): Promise<string>;
  confirmTransaction(strategy: { signature: string; blockhash: string; lastValidBlockHeight: number }, commitment: "confirmed"): Promise<{ value: { err: unknown } }>;
}

/** Persist each signed identifier BEFORE submitting it. An RPC timeout does not
 * prove a payment failed, so stop the run and keep its receipt instead of retrying. */
export async function submitSignedBatches(
  signed: Transaction[],
  blockhash: string,
  lastValidBlockHeight: number,
  rpc: SendRpc,
  onStatus: (index: number, status: BatchStatus) => void,
  beforeBroadcast: (signature: string) => void,
): Promise<void> {
  for (let i = 0; i < signed.length; i++) {
    let signature: string | undefined;
    let attempted = false;
    try {
      if (await rpc.getBlockHeight("confirmed") > lastValidBlockHeight) {
        throw new Error("Approval expired before broadcast. No further batches were sent.");
      }
      const rawSignature = signed[i].signature;
      if (!rawSignature) throw new Error("Wallet returned a transaction without a signature.");
      signature = bs58.encode(rawSignature);
      const bytes = signed[i].serialize();
      beforeBroadcast(signature);
      attempted = true;
      onStatus(i, { state: "sending" });
      const reported = await rpc.sendRawTransaction(bytes, {
        skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 2,
      });
      if (reported !== signature) throw new Error("RPC returned an unexpected transaction identifier.");
      onStatus(i, { state: "confirming", signature });
      const result = await rpc.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (result.value.err) {
        onStatus(i, { state: "failed", signature, error: JSON.stringify(result.value.err) });
        for (let j = i + 1; j < signed.length; j++) onStatus(j, { state: "skipped", error: "Stopped after a failed batch." });
        return;
      }
      onStatus(i, { state: "confirmed", signature });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatus(i, attempted && signature
        ? { state: "uncertain", signature, error: message }
        : { state: "failed", error: message });
      for (let j = i + 1; j < signed.length; j++) onStatus(j, { state: "skipped", error: "Not sent. Review the previous batch first." });
      return;
    }
  }
}
