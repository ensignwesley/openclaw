import { createHash } from "node:crypto";

const RUNTIME_PROMPT_IMAGE_FACT_INDEXES = Symbol.for("openclaw.runtimePromptImageFactIndexes");

type RuntimePromptImageFactIndex = number | null;
const RUNTIME_PROMPT_IMAGE_FACT_INDEX = Symbol.for("openclaw.runtimePromptImageFactIndex");
const RUNTIME_PROMPT_IMAGE_ADMISSION = Symbol.for("openclaw.runtimePromptImageAdmission");

/** Native block identity survives content-only filtering; the SDK clone carries it explicitly. */
export function readRuntimePromptImageFactIndex(
  image: object,
): RuntimePromptImageFactIndex | undefined {
  const value: unknown = Reflect.get(image, RUNTIME_PROMPT_IMAGE_FACT_INDEX);
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    ? value
    : undefined;
}

function imageIdentity(image: object): string | undefined {
  const data: unknown = Reflect.get(image, "data");
  const mimeType: unknown = Reflect.get(image, "mimeType");
  return typeof data === "string" && typeof mimeType === "string"
    ? createHash("sha256").update(mimeType).update("\0").update(data).digest("hex")
    : undefined;
}

export function bindRuntimePromptImageAdmission<T extends object>(
  message: T,
  images: readonly object[] | undefined,
): T {
  const indexes = readRuntimePromptImageFactIndexes(images);
  if (indexes) {
    Object.defineProperty(message, RUNTIME_PROMPT_IMAGE_ADMISSION, {
      configurable: true,
      enumerable: true,
      value: { identities: images?.map(imageIdentity), indexes },
    });
  }
  return message;
}

export function readRuntimePromptImageAdmission(
  message: object,
): readonly RuntimePromptImageFactIndex[] | undefined {
  const admission: { indexes?: RuntimePromptImageFactIndex[] } | undefined = Reflect.get(
    message,
    RUNTIME_PROMPT_IMAGE_ADMISSION,
  );
  return admission?.indexes;
}

export function readRuntimePromptImageBlockFactIndexes(
  message: object,
  images: readonly object[],
): RuntimePromptImageFactIndex[] | undefined {
  const admission:
    | { identities: readonly (string | undefined)[]; indexes: RuntimePromptImageFactIndex[] }
    | undefined = Reflect.get(message, RUNTIME_PROMPT_IMAGE_ADMISSION);
  const indexes = images.map((image) => {
    const native = readRuntimePromptImageFactIndex(image);
    if (native !== undefined) return native;
    // A context listener can copy/filter blocks without copying native symbols.
    // Match admitted bytes, never their now-stale ordinal in message metadata.
    const identity = imageIdentity(image);
    const matches = identity
      ? (admission?.identities.flatMap((candidate, index) =>
          candidate === identity ? [admission.indexes[index]] : [],
        ) ?? [])
      : [];
    const identities = new Set(matches);
    return identities.size === 1 ? matches[0] : undefined;
  });
  return (indexes.length || admission) && indexes.every((index) => index !== undefined)
    ? indexes
    : undefined;
}

/** The SDK context clone detaches containers, not native image/fact attribution. */
export function copyRuntimePromptImageProvenance(source: object, target: object): void {
  const factIndex = readRuntimePromptImageFactIndex(source);
  if (factIndex !== undefined)
    Object.defineProperty(target, RUNTIME_PROMPT_IMAGE_FACT_INDEX, {
      configurable: true,
      enumerable: false,
      value: factIndex,
    });
  const admission: unknown = Reflect.get(source, RUNTIME_PROMPT_IMAGE_ADMISSION);
  if (admission)
    Object.defineProperty(target, RUNTIME_PROMPT_IMAGE_ADMISSION, {
      configurable: true,
      enumerable: true,
      value: admission,
    });
}

export function finalizeRuntimePromptImages<TImage extends object>(
  entries: readonly { image: TImage; factIndex: RuntimePromptImageFactIndex }[],
): { images: TImage[]; imageFactIndexes: RuntimePromptImageFactIndex[] } {
  const images = entries.map(({ image, factIndex }) => {
    if (Object.isExtensible(image)) {
      Object.defineProperty(image, RUNTIME_PROMPT_IMAGE_FACT_INDEX, {
        configurable: true,
        enumerable: false,
        value: factIndex,
      });
    }
    return image;
  });
  const imageFactIndexes = entries.map((entry) => entry.factIndex);
  // Carry fact ownership without changing provider-visible bytes.
  Object.defineProperty(images, RUNTIME_PROMPT_IMAGE_FACT_INDEXES, {
    configurable: true,
    value: [...imageFactIndexes],
  });
  return { images, imageFactIndexes };
}

export function readRuntimePromptImageFactIndexes(
  images: readonly object[] | null | undefined,
): RuntimePromptImageFactIndex[] | undefined {
  if (!images?.length) {
    return undefined;
  }
  const runtimeImages: readonly object[] & {
    [RUNTIME_PROMPT_IMAGE_FACT_INDEXES]?: unknown;
  } = images;
  const factIndexes = runtimeImages[RUNTIME_PROMPT_IMAGE_FACT_INDEXES];
  if (
    Array.isArray(factIndexes) &&
    factIndexes.length === images.length &&
    factIndexes.every(
      (entry) =>
        entry === null || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0),
    )
  ) {
    return factIndexes as RuntimePromptImageFactIndex[];
  }
  const indexes = images.map(readRuntimePromptImageFactIndex);
  return indexes.every((index) => index !== undefined) ? indexes : undefined;
}
