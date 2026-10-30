import { readSessionPendingInputSettlements } from "../config/sessions/session-accessor.pending-inputs.js";
import type { SessionInputSourceDelivery } from "../config/sessions/session-input-settlement.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

/** Collection preserves each source's private identity, never the responder run's union. */
export async function readUserTurnSourceInputs(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertCurrent: () => void,
) {
  const owner = recorder && getUserTurnTranscriptAdmissionOwner(recorder);
  if (!owner || recorder!.isBlocked()) return [];
  const originals = owner.sources?.length ? owner.sources : [recorder!];
  const inputs = [];
  for (const original of originals) {
    const native = getUserTurnTranscriptAdmissionOwner(original);
    const pending = await native?.ensureSource?.(assertCurrent);
    assertCurrent();
    if (!pending) continue;
    for (const source of readSessionPendingInputSettlements(pending)) {
      if (!source.identity || !source.read || !source.write) continue;
      inputs.push({ ...source, admission: native?.receipt() });
    }
  }
  return inputs;
}

export async function readUserTurnSourceDelivery(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertCurrent: () => void,
) {
  const originals = await readUserTurnSourceInputs(recorder, assertCurrent);
  if (!originals.length) return undefined;
  const deliveries: SessionInputSourceDelivery[] = [];
  for (const source of originals) {
    const delivered = await source.read!();
    assertCurrent();
    if (!delivered) return undefined;
    deliveries.push(delivered);
  }
  return deliveries;
}
