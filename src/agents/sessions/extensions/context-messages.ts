import { cloneTranscriptView } from "../../../config/sessions/transcript-snapshot.js";
import { copyRuntimePromptImageProvenance } from "../../../media/runtime-prompt-image-provenance.js";
import type { AgentMessage } from "../../runtime/index.js";

/** Give context hooks writable containers while retaining native image custody. */
export function cloneExtensionContextMessages(messages: AgentMessage[]): AgentMessage[] {
  const currentMessages = cloneTranscriptView(messages, { shareImmutablePayloads: false });
  messages.forEach((source, index) => {
    const target = currentMessages[index]!;
    copyRuntimePromptImageProvenance(source, target);
    if (
      source.role === "user" &&
      target.role === "user" &&
      Array.isArray(source.content) &&
      Array.isArray(target.content)
    ) {
      const targetBlocks = target.content;
      source.content.forEach((block, blockIndex) => {
        if (block.type === "image" && targetBlocks[blockIndex]?.type === "image")
          copyRuntimePromptImageProvenance(block, targetBlocks[blockIndex]!);
      });
    }
  });
  return currentMessages;
}
