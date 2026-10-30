import { expect, it } from "vitest";
import type { SessionTranscriptAnchorFacts } from "../../config/sessions/session-transcript-anchor-read.types.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { resolveChatReplySourceInput } from "./chat-send-reply-delivery.js";
const anchor = (entryId: string, position: number): TranscriptEntryAnchor => ({
  entryId,
  rawSeq: position + 1,
  activeMessagePosition: position,
  agentId: "main",
  sessionId: "s",
  sessionKey: "agent:main:s",
  storePath: "/synthetic/store",
  generation: "g",
  effectiveParentId: null,
});
const a = anchor("A", 0),
  af = anchor("A-final", 1),
  b = anchor("B", 2),
  bf = anchor("B-final", 3);
const facts: SessionTranscriptAnchorFacts = {
  anchors: [a],
  watermark: { generation: "g", maxSeq: 4 },
  tail: {
    lastSeq: 4,
    entries: [
      { entryId: "A", role: "user", anchor: a },
      { entryId: "A-final", role: "assistant", anchor: af },
      { entryId: "B", role: "user", anchor: b },
      { entryId: "B-final", role: "assistant", anchor: bf },
    ],
  },
};
it("retains historical A and distinct steered B association without borrowing B's answer", () => {
  const read = (messageId: string, admissionIds: string[]) =>
    resolveChatReplySourceInput({ facts, messageId, admissionIds, afterSeq: 0 });
  expect(read("A-final", ["A"])).toBe("A");
  expect(read("B-final", ["A"])).toBeUndefined();
  expect(read("B-final", ["A", "B"])).toBe("B");
  expect(
    resolveChatReplySourceInput({
      facts: { ...facts, watermark: { generation: "new", maxSeq: 4 } },
      messageId: "A-final",
      admissionIds: ["A"],
      afterSeq: 0,
    }),
  ).toBeUndefined();
});
