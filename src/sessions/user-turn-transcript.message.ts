// Canonical user input shape and runtime/display projections share the same media metadata.
import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import {
  asFiniteNumberInRange,
  asPositiveSafeInteger,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import {
  isMediaKind,
  isImageMediaFact,
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
  readPersistedMediaFacts,
  type MediaFact,
  type MediaFactInput,
} from "../media/media-facts.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndex,
} from "../media/runtime-prompt-image-provenance.js";
import { applyInputProvenanceToUserMessage } from "./input-provenance.js";
import { buildPersistedUserTurnMetadata } from "./user-turn-transcript.metadata.js";
import type {
  ModelPromptImage,
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnMessagePersistenceParams,
} from "./user-turn-transcript.types.js";

// Exposed messages are projections. Only producer facts or exact accepted
// pending custody can supply identity to a fresh write.
export function projectUserTurnRequesterOrigin<T extends PersistedUserTurnMessage | undefined>(
  candidate: T,
  origin: RequesterOrigin | undefined,
): T {
  if (!candidate) {
    return candidate;
  }
  const { requesterOrigin: _previousOrigin, ...metadata } = candidate["__openclaw"] ?? {};
  if (origin) {
    metadata.requesterOrigin = origin;
  }
  const next = { ...candidate };
  delete next["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    next["__openclaw"] = metadata;
  }
  return next;
}

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu;

function resolveTranscriptMediaPath(pathValue: string, workspaceDir: string | undefined): string {
  // Relative staged media paths are anchored to the media workspace; absolute
  // paths and URL-like refs are already stable transcript references.
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

function normalizeStructuredMediaEntryForTranscript(
  media: PersistedUserTurnMediaInput,
): MediaFactInput {
  const workspaceDir = normalizeOptionalString(media.workspaceDir);
  const mediaPath = normalizeOptionalString(media.path);
  const mediaUrl = normalizeOptionalString(media.url);
  const legacyKind = normalizeOptionalString(media.kind);
  const kind = isMediaKind(legacyKind) ? legacyKind : undefined;
  const messageId = normalizeOptionalString(media.messageId);
  const contentType =
    normalizeOptionalString(media.contentType) ??
    (kind || !legacyKind || !MIME_TYPE_PATTERN.test(legacyKind) ? undefined : legacyKind) ??
    mimeTypeFromFilePath(mediaPath ?? mediaUrl);
  const durationMs = asPositiveSafeInteger(media.durationMs);
  const width = asPositiveSafeInteger(media.width);
  const height = asPositiveSafeInteger(media.height);
  const fileName = normalizeOptionalString(media.fileName);
  const sizeBytes = asFiniteNumberInRange(media.sizeBytes, { min: 0 });
  return {
    ...(mediaPath ? { path: resolveTranscriptMediaPath(mediaPath, workspaceDir) } : {}),
    ...(mediaUrl ? { url: mediaUrl } : {}),
    ...(contentType ? { contentType } : {}),
    ...(kind ? { kind } : {}),
    ...(fileName ? { fileName } : {}),
    ...(media.origin === "paste" || media.origin === "file" ? { origin: media.origin } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(media.transcribed === true ? { transcribed: true } : {}),
    ...(messageId ? { messageId } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

export function resolvePersistedUserTurnText(value: string | null | undefined): string | undefined {
  return normalizeOptionalString(value);
}

export function buildPersistedUserTurnMediaInputsFromFields(
  fields: PersistedUserTurnMessage | null | undefined,
): PersistedUserTurnMediaInput[] {
  const facts = fields ? (readPersistedMediaFacts(fields) ?? []) : [];
  const normalizedMedia = facts.map<PersistedUserTurnMediaInput>((fact) => {
    const mediaPath = fact.path
      ? resolveTranscriptMediaPath(fact.path, fact.workspaceDir)
      : undefined;
    const url = fact.url;
    if (!mediaPath && !url) {
      return {};
    }
    const media: PersistedUserTurnMediaInput = {
      contentType: fact.contentType ?? mimeTypeFromFilePath(mediaPath ?? url),
    };
    const set = <K extends keyof typeof media>(key: K, value: (typeof media)[K]) => {
      if (value !== undefined) {
        media[key] = value;
      }
    };
    set("path", mediaPath);
    set("url", url);
    set("kind", fact.kind);
    set("fileName", fact.fileName);
    set("origin", fact.origin);
    set("sizeBytes", fact.sizeBytes);
    set("durationMs", fact.durationMs);
    set("width", fact.width);
    set("height", fact.height);
    return media;
  });
  return normalizedMedia.some((entry) => entry.path || entry.url) ? normalizedMedia : [];
}

export function buildLateMediaAttachedProjection(message: AgentMessage): {
  text?: string;
  media: MediaFact[];
} {
  const isLateMedia = readOpenClawMessageMeta(message)?.lateMedia === true;
  const media = isLateMedia ? (readPersistedMediaFacts(message) ?? []) : [];
  const text = media
    .flatMap((fact) => {
      const mediaRef = fact.path ?? fact.url;
      return mediaRef ? [`[media attached: ${mediaRef}]`] : [];
    })
    .join("\n");
  return { ...(text ? { text } : {}), media };
}

function readOpenClawMessageMeta(message: AgentMessage): Record<string, unknown> | undefined {
  return asOptionalRecord(Reflect.get(message, "__openclaw"));
}

function isModelPromptImages(value: unknown): value is ModelPromptImage[] {
  if (!Array.isArray(value)) return false;
  let previousIndex = -1;
  return value.every((entry) => {
    const slot = asOptionalRecord(entry);
    const image = asOptionalRecord(slot?.image);
    if (
      typeof slot?.index !== "number" ||
      !Number.isSafeInteger(slot.index) ||
      slot.index <= previousIndex
    )
      return false;
    const valid = image
      ? slot.factIndex === undefined &&
        image.type === "image" &&
        typeof image.data === "string" &&
        typeof image.mimeType === "string"
      : slot.image === undefined &&
        typeof slot.factIndex === "number" &&
        Number.isSafeInteger(slot.factIndex) &&
        slot.factIndex >= 0;
    previousIndex = slot.index;
    return valid;
  });
}

function readModelPromptProjectionPayload(message: unknown):
  | {
      text: string;
      images?: ModelPromptImage[];
    }
  | undefined {
  if (!isUserMessage(message)) {
    return undefined;
  }
  const metadata = readOpenClawMessageMeta(message);
  if (!metadata || !Object.hasOwn(metadata, "modelPromptProjection")) {
    return undefined;
  }
  const projection = asOptionalRecord(metadata.modelPromptProjection);
  const images = projection?.images;
  if (
    projection?.version !== 1 ||
    typeof projection.text !== "string" ||
    (images !== undefined && !isModelPromptImages(images))
  ) {
    throw new Error(
      "Unsupported or invalid user-turn model prompt projection; update OpenClaw to a compatible version or start a new session.",
    );
  }
  return { text: projection.text, ...(images ? { images } : {}) };
}

export function readModelPromptProjection(message: unknown): string | undefined {
  return readModelPromptProjectionPayload(message)?.text;
}

export function readModelPromptImages(message: unknown): ModelPromptImage[] | undefined {
  return readModelPromptProjectionPayload(message)?.images;
}

export function prepareModelPromptProjection(
  message: unknown,
  text: string,
  images?: ModelPromptImage[],
): PersistedUserTurnMessage | undefined {
  if (!isUserMessage(message)) {
    throw new Error("Model prompt projection lost its canonical user turn");
  }
  const existing = readModelPromptProjection(message);
  if (existing !== undefined) {
    if (existing !== text) {
      throw new Error("A captured user-turn model prompt projection cannot be changed");
    }
    if (images === undefined || readModelPromptImages(message) !== undefined) return undefined;
  }
  return {
    ...message,
    __openclaw: {
      ...message["__openclaw"],
      modelPromptProjection: { version: 1, text, ...(images !== undefined ? { images } : {}) },
    },
  };
}

/** Materialize frozen image choices before extension context hooks; never after redaction. */
export function projectRecordedModelPromptImages(
  message: PersistedUserTurnMessage,
  transcript?: AgentMessage,
): PersistedUserTurnMessage;
export function projectRecordedModelPromptImages(
  message: AgentMessage,
  transcript?: AgentMessage,
): AgentMessage;
export function projectRecordedModelPromptImages(
  message: AgentMessage,
  transcript?: AgentMessage,
): AgentMessage {
  if (!isUserMessage(message)) return message;
  const slots = readModelPromptImages(transcript) ?? readModelPromptImages(message);
  if (slots === undefined) return message;
  const facts = readRuntimePromptMediaFacts(message) ?? readPersistedMediaFacts(message) ?? [];
  const selected = new Set(
    slots.flatMap((slot) => (slot.factIndex !== undefined ? [slot.factIndex] : [])),
  );
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }];
  if (
    !slots.length &&
    !blocks.some((block) => block.type === "image") &&
    !facts.some(isImageMediaFact)
  )
    return message;
  const indexes = asOptionalRecord(message["__openclaw"])?.mediaImageBlockFactIndexes;
  const managed = new Map<number, Extract<(typeof blocks)[number], { type: "image" }>>();
  blocks
    .filter((block) => block.type === "image")
    .forEach((image, index) => {
      const native = readRuntimePromptImageFactIndex(image);
      const factIndex: unknown =
        native !== undefined ? native : Array.isArray(indexes) ? indexes[index] : undefined;
      if (typeof factIndex === "number" && isImageMediaFact(facts[factIndex] ?? {}))
        managed.set(factIndex, image);
    });
  const entries = slots.flatMap((slot) => {
    const image =
      slot.image ?? (slot.factIndex !== undefined ? managed.get(slot.factIndex) : undefined);
    return image ? [{ image: { ...image }, factIndex: slot.factIndex ?? null }] : [];
  });
  const finalized = finalizeRuntimePromptImages(entries);
  const media = facts.map((fact, index) =>
    isImageMediaFact(fact) && !selected.has(index) ? { ...fact, hydrationSuppressed: true } : fact,
  );
  const projected = {
    ...message,
    content: [...blocks.filter((block) => block.type !== "image"), ...finalized.images],
    __openclaw: {
      ...message["__openclaw"],
      ...(media.length ? { media } : {}),
      mediaImageBlockFactIndexes: finalized.imageFactIndexes,
    },
  };
  // Context hooks receive detached plain containers; carry the same transient
  // omissions in their metadata even when that clone drops runtime symbols.
  return attachRuntimePromptMediaFacts(projected, media);
}

export function projectRecordedModelPrompt(
  message: PersistedUserTurnMessage,
  transcript?: AgentMessage,
  includeImages?: boolean,
): PersistedUserTurnMessage;
export function projectRecordedModelPrompt(
  message: AgentMessage,
  transcript?: AgentMessage,
  includeImages?: boolean,
): AgentMessage;
export function projectRecordedModelPrompt(
  message: AgentMessage,
  transcript?: AgentMessage,
  includeImages = true,
): AgentMessage {
  if (!isUserMessage(message)) {
    return message;
  }
  const projection =
    readModelPromptProjectionPayload(transcript) ?? readModelPromptProjectionPayload(message);
  if (!projection) {
    return message;
  }
  const { text } = projection;
  let content = message.content;
  if (Array.isArray(content)) {
    let replaced = false;
    content = content.map((block) => {
      if (block.type !== "text" || replaced) {
        return block;
      }
      replaced = true;
      return { ...block, text };
    });
    if (!replaced) {
      content = [{ type: "text", text }, ...content];
    }
  } else {
    content = text;
  }
  const imageMessage = includeImages
    ? projectRecordedModelPromptImages({ ...message, content }, transcript)
    : message;
  if (includeImages) content = imageMessage.content;
  const metadata = { ...imageMessage["__openclaw"] };
  delete metadata.modelPromptProjection;
  const projected: PersistedUserTurnMessage = {
    ...imageMessage,
    content,
    timestamp: transcript?.role === "user" ? transcript.timestamp : message.timestamp,
  };
  delete projected["__openclaw"];
  if (Object.keys(metadata).length > 0) {
    projected["__openclaw"] = metadata;
  }
  return projected;
}

export function buildPersistedUserTurnMessage(params: UserTurnInput): PersistedUserTurnMessage {
  const normalizedMedia = (params.media ?? []).map(normalizeStructuredMediaEntryForTranscript);
  const text = params.text ?? "";
  // Keep stored content bare: normalizeMessagesForLlmBoundary stamps current and
  // historical turns alike from their own timestamp (#3658).
  const openClawMeta = buildPersistedUserTurnMetadata(params, normalizedMedia);
  const message: PersistedUserTurnMessage = {
    role: "user",
    ...(params.display === false ? { display: false } : {}),
    ...(params.excludeFromContext ? { excludeFromContext: true } : {}),
    content: text,
    timestamp: params.timestamp ?? Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(Object.keys(openClawMeta).length > 0 ? { __openclaw: openClawMeta } : {}),
  };
  return applyInputProvenanceToUserMessage(message, params.provenance);
}

export function resolvePersistedUserTurnMessage(
  params: Pick<UserTurnMessagePersistenceParams, "input" | "message">,
): PersistedUserTurnMessage | undefined {
  return params.message ?? (params.input ? buildPersistedUserTurnMessage(params.input) : undefined);
}

export function isUserMessage(message: unknown): message is PersistedUserTurnMessage {
  return asOptionalRecord(message)?.role === "user";
}

export function buildLateResolvedMediaMessage(params: {
  admittedMessage?: PersistedUserTurnMessage;
  resolvedMessage: PersistedUserTurnMessage;
}): PersistedUserTurnMessage | undefined {
  const admittedMedia = buildPersistedUserTurnMediaInputsFromFields(params.admittedMessage);
  const resolvedMedia = buildPersistedUserTurnMediaInputsFromFields(params.resolvedMessage);
  if (
    resolvedMedia.length === 0 ||
    JSON.stringify(resolvedMedia) === JSON.stringify(admittedMedia)
  ) {
    return undefined;
  }
  const resolvedIdempotencyKey = Reflect.get(params.resolvedMessage, "idempotencyKey");
  const resolvedTimestamp = Reflect.get(params.resolvedMessage, "timestamp");
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  let content = resolvedContent;
  if (resolvedContent === admittedContent) {
    content = "";
  } else if (Array.isArray(resolvedContent) && typeof admittedContent === "string") {
    content = resolvedContent.filter((block) => {
      const textBlock = asOptionalRecord(block);
      return textBlock?.type !== "text" || textBlock.text !== admittedContent;
    });
  }
  const idempotencyKey =
    typeof resolvedIdempotencyKey === "string" && resolvedIdempotencyKey.length > 0
      ? `${resolvedIdempotencyKey}:late-media`
      : `late-media:${typeof resolvedTimestamp === "number" ? resolvedTimestamp : Date.now()}`;
  const metadata: Record<string, unknown> = {
    ...readOpenClawMessageMeta(params.resolvedMessage),
    lateMedia: true,
  };
  delete metadata.humanMentions;
  delete metadata.modelPromptProjection;
  // Like #111204, mark late-media scaffolding as wire-only so UIs never render it.
  return {
    ...params.resolvedMessage,
    content,
    idempotencyKey,
    __openclaw: metadata,
  };
}

// Runtime messages may lack transcript metadata because channel adapters prepare
// display text separately. Merge only safe user messages, never block markers.
export function mergePreparedUserTurnMessageForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (
    !params.preparedMessage ||
    !isUserMessage(params.runtimeMessage) ||
    readOpenClawMessageMeta(params.runtimeMessage)?.beforeAgentRunBlocked !== undefined
  ) {
    return params.runtimeMessage;
  }
  const runtimeMeta = readOpenClawMessageMeta(params.runtimeMessage);
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  return {
    ...params.runtimeMessage,
    ...params.preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(Array.isArray(params.runtimeMessage.content) &&
    params.runtimeMessage.content.some((block) => asOptionalRecord(block)?.type === "image")
      ? { content: params.runtimeMessage.content }
      : {}),
  };
}
