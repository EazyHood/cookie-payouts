import { GENESIS_HASH, formatCook, isValidAddress } from "./chain";
import { parseRecipients } from "./payout";
import type { PayoutPlan } from "./reconcile";

export function planJson(plan: PayoutPlan): string {
  return JSON.stringify({ version: 1, chain: GENESIS_HASH, sender: plan.sender,
    recipients: plan.recipients.map(r => ({ address: r.address, amountBaseUnits: r.units.toString() })),
  }, null, 2);
}

export function readPlan(text: string): { sender: string; recipientsText: string } {
  if (text.length > 50_000) throw new Error("Plan file is too large (50 KB maximum).");
  const data = JSON.parse(text);
  if (data?.version !== 1 || data.chain !== GENESIS_HASH || typeof data.sender !== "string" || !isValidAddress(data.sender) || !Array.isArray(data.recipients) || data.recipients.length > 200) {
    throw new Error("Choose a Cookie Payouts plan for this chain, with a sender and at most 200 recipients.");
  }
  const lines = data.recipients.map((r: { address?: unknown; amountBaseUnits?: unknown }) => {
    if (typeof r?.address !== "string" || !isValidAddress(r.address) || typeof r.amountBaseUnits !== "string" || !/^\d{1,20}$/.test(r.amountBaseUnits)) {
      throw new Error("Plan contains an invalid address or amount.");
    }
    return `${r.address}, ${formatCook(BigInt(r.amountBaseUnits)).replaceAll(",", "")}`;
  }).join("\n");
  const parsed = parseRecipients(lines);
  if (!parsed.recipients.length || parsed.errors.length) throw new Error("Plan contains invalid or duplicate recipients.");
  return { sender: data.sender, recipientsText: lines };
}

export function downloadText(filename: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
