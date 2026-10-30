import {
  readSessionPendingInputSettlements,
  stageSessionPendingInput,
} from "../config/sessions/session-accessor.pending-inputs.js";
import type { SessionInputSourceDelivery } from "../config/sessions/session-input-settlement.js";
import {
  registerUserTurnTranscriptAdmissionOwner,
  getUserTurnTranscriptAdmissionOwner,
} from "./user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

/** Collection preserves each source's private identity, never the responder run's union. */
export async function readUserTurnSourceInputs(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertCurrent: () => void,
) {
  const owner = recorder && getUserTurnTranscriptAdmissionOwner(recorder);
  if (!owner || recorder!.isBlocked()) {
    return [];
  }
  const originals = owner.sources?.length ? owner.sources : [recorder!];
  const inputs = [];
  for (const original of originals) {
    const native = getUserTurnTranscriptAdmissionOwner(original);
    const pending = await native?.ensureSource?.(assertCurrent);
    assertCurrent();
    if (!pending) {
      continue;
    }
    for (const source of readSessionPendingInputSettlements(pending)) {
      if (!source.identity || !source.read || !source.write) {
        continue;
      }
      inputs.push({
        ...source,
        admission: native?.receipt() ?? (owner.sources?.length ? owner.receipt() : undefined),
      });
    }
  }
  return inputs;
}

export async function readUserTurnSourceDelivery(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertCurrent: () => void,
) {
  const originals = await readUserTurnSourceInputs(recorder, assertCurrent);
  if (!originals.length) {
    return undefined;
  }
  const deliveries: SessionInputSourceDelivery[] = [];
  for (const source of originals) {
    const delivered = await source.read!();
    assertCurrent();
    if (!delivered) {
      return undefined;
    }
    deliveries.push(delivered);
  }
  return deliveries;
}

/** Install lazy receipt custody on the existing native admission owner. */
export function registerUserTurnSourceCustody(params: {
  recorder: UserTurnTranscriptRecorder;
  sources?: readonly UserTurnTranscriptRecorder[];
  fingerprint?: string;
  adopt: (
    receipt: import("../config/sessions/session-pending-input-receipt.types.js").SessionPendingInputReceipt,
  ) => void;
}) {
  const owner = getUserTurnTranscriptAdmissionOwner(params.recorder)!;
  owner.sources = params.sources;
  owner.ensureSource = async (assertCurrent) => {
    let pending = owner.pendingInput();
    const captured = owner.receipt(),
      message = owner.message();
    if (!pending && captured && message?.idempotencyKey && !params.sources?.length) {
      pending = await stageSessionPendingInput(captured, {
        message,
        runId: `input:${captured.entryId}`,
        requestFingerprint: params.fingerprint,
        assertCurrent() {
          assertCurrent();
          if (owner.receipt() !== captured) {
            throw new Error("Input source admission changed");
          }
        },
      });
      if (pending) {
        params.adopt(pending);
      }
    }
    return pending;
  };
}

export function registerUserTurnSourceOwner(
  recorder: UserTurnTranscriptRecorder,
  params: Pick<
    import("./user-turn-transcript.types.js").CreateUserTurnTranscriptRecorderParams,
    "pendingInputSources" | "pendingInputRequestFingerprint"
  >,
  owner: Parameters<typeof registerUserTurnTranscriptAdmissionOwner>[1],
  adopt: Parameters<typeof registerUserTurnSourceCustody>[0]["adopt"],
) {
  registerUserTurnTranscriptAdmissionOwner(recorder, owner);
  registerUserTurnSourceCustody({
    recorder,
    sources: params.pendingInputSources,
    fingerprint: params.pendingInputRequestFingerprint,
    adopt,
  });
}
