import { expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  decodeSessionInputSettlement,
  encodeSessionInputSettlement,
  mergeSessionInputSettlement,
} from "./session-input-settlement.js";
const answer = {
  kind: "answer" as const,
  responderRunId: "R",
  intentId: "native-A",
  deliveryId: "A",
  platformMessageId: "final-A",
  resultCount: 1,
  settledAt: 10,
};
it("separates receipt-first delivery from processing and preserves it through real completion", () => {
  const receipt = mergeSessionInputSettlement({}, { sourceDelivery: answer });
  expect(decodeSessionInputSettlement(encodeSessionInputSettlement(receipt))).toEqual({
    sourceDelivery: answer,
  });
  const processing = buildAgentRunTerminalOutcome({ status: "ok" });
  expect(decodeSessionInputSettlement(JSON.stringify(processing))).toEqual({ processing });
  expect(mergeSessionInputSettlement(receipt, { processing })).toEqual({
    processing,
    sourceDelivery: answer,
  });
});
it("does not overwrite a final processing fact or union another input's terminal receipt", () => {
  const processing = buildAgentRunTerminalOutcome({ status: "ok" });
  const retained = { processing, sourceDelivery: answer };
  expect(mergeSessionInputSettlement(retained, { sourceDelivery: answer })).toEqual(retained);
  expect(() =>
    mergeSessionInputSettlement(retained, {
      sourceDelivery: { ...answer, deliveryId: "B", platformMessageId: "final-B" },
    }),
  ).toThrow("different terminal delivery");
});
