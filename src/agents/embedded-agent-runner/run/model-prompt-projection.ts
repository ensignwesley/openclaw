import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  runWithSessionSourceScope,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { ImageContent } from "../../../llm/types.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import {
  INTER_SESSION_PROMPT_PREFIX_BASE,
  isHostGeneratedInputProvenance,
} from "../../../sessions/input-provenance.js";
import {
  isUserMessage,
  readModelPromptProjection,
  readModelPromptImages,
} from "../../../sessions/user-turn-transcript.message.js";
import type {
  ModelPromptImage,
  UserTurnTranscriptRecorder,
} from "../../../sessions/user-turn-transcript.types.js";
import { isTextContentBlock } from "../../content-blocks.js";
import { resolveRuntimeContextPromptOwner } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { bindModelPromptProjectionAppend } from "../../sessions/model-prompt-projection-append.js";
import { findActiveUserMessageIndex } from "./attempt-history.js";
import type { UserTranscriptContext } from "./attempt-llm-boundary.types.js";
import { readPersistedImageBlockFactIndexes } from "./prompt-image-metadata.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

type PromptContextTransform = (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;

/** The model-facing text of a prompt before any recorded projection. */
export function resolveModelPromptText(params: {
  text: string;
  transcriptPrompt: string;
  modelPrompt?: string;
  prependContext?: string;
  appendContext?: string;
}): string {
  if (params.modelPrompt?.trim() && params.text === params.transcriptPrompt) {
    return params.modelPrompt;
  }
  return [params.prependContext, params.text, params.appendContext]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
}

/** Capture the admitted prompt once; every later request reads the same transcript field. */
export function installModelPromptProjection(params: {
  session: {
    agent: { transformContext?: PromptContextTransform; state?: { messages: AgentMessage[] } };
  };
  transcriptPrompt: string;
  modelPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  shouldCapturePrompt: () => boolean;
  images?: ImageContent[];
  carrier?: RuntimeContextCustomMessage;
  recorder?: UserTurnTranscriptRecorder;
  getUserTranscriptContexts?: () => readonly UserTranscriptContext[] | undefined;
  withTranscriptWrite?: <T>(write: () => Promise<T>) => Promise<T>;
  assertCurrent?: SessionSourceAssertion;
}): () => void {
  if (
    !params.recorder?.captureModelPromptProjection &&
    (!params.modelPrompt?.trim() || params.modelPrompt === params.transcriptPrompt) &&
    !params.prependContext?.trim() &&
    !params.appendContext?.trim()
  ) {
    return () => {};
  }
  const agent = params.session.agent;
  const originalTransformContext = agent.transformContext;
  let targetPrompt: AgentMessage | undefined;
  let imageSnapshotPending = false;
  let promptOwner:
    | NonNullable<ReturnType<typeof resolveRuntimeContextPromptOwner>>["owner"]
    | undefined;
  const resolveProjection = async (messages: AgentMessage[], assertCurrent: () => void) => {
    if (!params.shouldCapturePrompt()) {
      return undefined;
    }
    await params.recorder?.waitForRuntimePersistence();
    assertCurrent();
    const recorded = params.recorder?.getPersistedMessage?.();
    if (!targetPrompt) {
      const retained = resolveRuntimeContextPromptOwner(messages);
      const key = recorded?.idempotencyKey;
      const paired = params
        .getUserTranscriptContexts?.()
        ?.find(
          ({ transcriptMessage }) =>
            transcriptMessage === recorded ||
            (key && Reflect.get(transcriptMessage, "idempotencyKey") === key),
        )?.runtimeMessage;
      targetPrompt = params.recorder
        ? messages.find(
            (message) =>
              message === paired ||
              message === recorded ||
              (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key),
          )
        : messages[retained?.userIndex ?? findActiveUserMessageIndex(messages)];
      promptOwner = retained?.owner;
    }
    const canonicalPrompt = recorded ?? promptOwner?.transcriptUser ?? targetPrompt;
    const key = asOptionalObjectRecord(canonicalPrompt)?.idempotencyKey;
    const target = messages.find(
      (message) =>
        message === targetPrompt ||
        message === canonicalPrompt ||
        (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key),
    );
    if (target?.role !== "user") {
      return undefined;
    }
    const firstText =
      typeof target.content === "string"
        ? target.content
        : target.content.find(isTextContentBlock)?.text;
    const targetProjection = readModelPromptProjection(target);
    const frozen = readModelPromptProjection(canonicalPrompt) ?? targetProjection;
    let text =
      frozen ??
      (firstText === undefined
        ? undefined
        : resolveModelPromptText({ ...params, text: firstText }));
    // Inter-session input keeps its stored source-provenance envelope in current and replayed text.
    if (
      frozen === undefined &&
      text !== undefined &&
      firstText?.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE) === true &&
      !text.includes(firstText)
    ) {
      text = firstText;
    }
    if (
      text === undefined ||
      !(
        frozen !== undefined ||
        text !== firstText ||
        (params.recorder?.captureModelPromptProjection &&
          !firstText?.startsWith(INTER_SESSION_PROMPT_PREFIX_BASE))
      )
    ) {
      return undefined;
    }
    const capturesAuthoredImages =
      isUserMessage(canonicalPrompt) &&
      canonicalPrompt.display !== false &&
      !canonicalPrompt.excludeFromContext &&
      !isHostGeneratedInputProvenance(canonicalPrompt.provenance);
    if (frozen === undefined && capturesAuthoredImages) {
      imageSnapshotPending = Boolean(params.images?.length);
    }
    const images =
      frozen === undefined && capturesAuthoredImages && !imageSnapshotPending ? [] : undefined;
    return { target, targetProjection, frozen, text, images };
  };
  const releaseCarrier =
    params.carrier && params.recorder?.prepareModelPromptProjection
      ? bindModelPromptProjectionAppend(params.carrier, () =>
          runWithSessionSourceScope(
            params.assertCurrent,
            async () => {
              const assertCurrent = () => params.assertCurrent?.();
              const projection = await resolveProjection(
                agent.state?.messages ?? [],
                assertCurrent,
              );
              return projection && projection.frozen === undefined
                ? params.recorder?.prepareModelPromptProjection?.(
                    projection.text,
                    assertCurrent,
                    projection.images,
                  )
                : undefined;
            },
            { checkAfter: false },
          ),
        )
      : undefined;
  agent.transformContext = async (messages, signal) =>
    runWithSessionSourceScope(
      params.assertCurrent,
      async () => {
        let promptMessages = messages;
        const assertCurrent = () => {
          signal?.throwIfAborted();
          params.assertCurrent?.();
        };
        const projection = await resolveProjection(messages, assertCurrent);
        if (projection) {
          const { target, targetProjection, frozen } = projection;
          let { text } = projection;
          let capturedImages: ModelPromptImage[] | undefined = projection.images;
          const captureProjection = params.recorder?.captureModelPromptProjection;
          if (frozen === undefined && captureProjection) {
            const capture = () => captureProjection(text, assertCurrent, projection.images);
            const captured = await (params.withTranscriptWrite
              ? params.withTranscriptWrite(capture)
              : capture());
            assertCurrent();
            const capturedText = readModelPromptProjection(captured);
            if (capturedText === undefined) {
              throw new Error("Transcript recorder did not capture the model prompt projection");
            }
            text = capturedText;
            capturedImages = readModelPromptImages(captured);
          }
          // Replay snapshots are immutable; only replace the runtime view.
          if (targetProjection !== text || capturedImages !== undefined) {
            const projectedTarget = {
              ...target,
              __openclaw: {
                ...asOptionalObjectRecord(Reflect.get(target, "__openclaw")),
                modelPromptProjection: {
                  version: 1,
                  text,
                  ...(capturedImages !== undefined ? { images: capturedImages } : {}),
                },
              },
            };
            promptMessages = messages.map((message) =>
              message === target ? projectedTarget : message,
            );
            if (agent.state) {
              agent.state.messages = agent.state.messages.map((message) =>
                message === target ? projectedTarget : message,
              );
            }
          }
        }
        const transformed = originalTransformContext
          ? await originalTransformContext.call(agent, promptMessages, signal)
          : promptMessages;
        assertCurrent();
        const captureImages = params.recorder?.captureModelPromptProjection;
        if (imageSnapshotPending && projection && captureImages) {
          const key = Reflect.get(projection.target, "idempotencyKey");
          const target = transformed.find(
            (message) =>
              message === projection.target ||
              (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key),
          );
          const finalImages =
            target?.role === "user" && Array.isArray(target.content)
              ? target.content.filter((block): block is ImageContent => block.type === "image")
              : [];
          const indexes = readRuntimePromptImageFactIndexes(params.images);
          const admitted =
            params.images?.filter((_image, index) => indexes?.[index] === null) ?? [];
          const finalIndexes = target ? readPersistedImageBlockFactIndexes(target) : undefined;
          const images = finalImages.flatMap((image, index): ModelPromptImage[] => {
            const factIndex = finalIndexes?.[index];
            if (typeof factIndex === "number") return [{ index, factIndex }];
            return factIndex === null &&
              admitted.some(
                (entry) => entry.data === image.data && entry.mimeType === image.mimeType,
              )
              ? [{ index, image: { type: "image", data: image.data, mimeType: image.mimeType } }]
              : [];
          });
          // Text and its carrier already committed together. Final image choices
          // settle on that same owner only after supported context hooks ran.
          const capture = () => captureImages(projection.text, assertCurrent, images);
          const captured = await (params.withTranscriptWrite
            ? params.withTranscriptWrite(capture)
            : capture());
          assertCurrent();
          imageSnapshotPending = false;
          if (agent.state) {
            agent.state.messages = agent.state.messages.map((message) =>
              message === projection.target ||
              (key && message.role === "user" && Reflect.get(message, "idempotencyKey") === key)
                ? {
                    ...message,
                    __openclaw: {
                      ...asOptionalObjectRecord(Reflect.get(message, "__openclaw")),
                      modelPromptProjection: captured["__openclaw"]?.modelPromptProjection,
                    },
                  }
                : message,
            );
          }
        }
        return transformed;
      },
      { checkAfter: false },
    );
  return () => {
    releaseCarrier?.();
    agent.transformContext = originalTransformContext;
  };
}
