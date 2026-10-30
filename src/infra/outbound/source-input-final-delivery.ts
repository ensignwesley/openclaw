import { randomUUID } from "node:crypto";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import {
  withSessionActor,
  runSessionActorCommand,
} from "../../config/sessions/session-actor-scope.js";
import { buildSessionTranscriptTurnExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MessageActionAuthorization } from "../../gateway/message-action-turn-capability.js";
import { readUserTurnSourceInputs } from "../../sessions/user-turn-source-delivery.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { DurableDeliveryCompletion } from "./delivery-queue-types.js";
import { sourceInputMatchesDeliveryContext } from "./source-reply-input-context.js";

/** Reuse pending-final for source-tool ambiguity; no second recovery/store/queue. */
export async function prepareSourceInputFinalDelivery(params: {
  source: NonNullable<MessageActionAuthorization["currentInput"]>;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
  context: DeliveryContext;
}): Promise<
  Extract<DurableDeliveryCompletion, { kind: "pending-final" }> | "answered" | "pending" | undefined
> {
  const { source } = params;
  source.assertCurrent();
  const originals = await readUserTurnSourceInputs(source.recorder, source.assertCurrent);
  if (
    !originals.length ||
    originals.some(
      (input) =>
        input.sessionKey !== params.sessionKey ||
        input.sessionId !== params.sessionId ||
        !input.consumed,
    )
  ) {
    return undefined;
  }
  if (originals.some((input) => !sourceInputMatchesDeliveryContext(input.origin, params.context))) {
    return undefined;
  }
  const receipts = await Promise.all(originals.map((input) => input.read!()));
  source.assertCurrent();
  if (receipts.every(Boolean)) {
    return "answered";
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return withSessionActor(
    { agentId: params.agentId, sessionKey: params.sessionKey, storePath },
    { assertCurrent: source.assertCurrent, assertReadable: source.assertCurrent },
    async (actor) => {
      let snapshot = await actor.read({
        assertCurrent: source.assertCurrent,
        authorize() {
          source.assertCurrent();
        },
      });
      const entry = snapshot.entry;
      if (!entry || entry.sessionId !== params.sessionId) {
        throw new Error("Source final session changed");
      }
      if (entry.pendingFinalDelivery) {
        return "pending";
      }
      const intentId = randomUUID(),
        deliveryId = randomUUID();
      const authority: SessionActorAuthority = {
        assertCurrent: source.assertCurrent,
        authorize(_stage, facts) {
          source.assertCurrent();
          if (
            facts.entry?.sessionId !== params.sessionId ||
            facts.entry.lifecycleRevision !== entry.lifecycleRevision
          ) {
            throw new Error("Source final lifetime changed");
          }
        },
      };
      const outcome = await runSessionActorCommand(actor, authority, async (current) => {
        snapshot = current ?? (await actor.read(authority));
        return actor.completeTurn(
          {
            commandId: randomUUID(),
            phaseId: `source-final:${params.toolCallId}`,
            expected: actor.target.database.kind === "memory" ? undefined : snapshot.version,
            bookkeeping: {
              sessionId: params.sessionId,
              lifecycleRevision: entry.lifecycleRevision ?? null,
              writerRunId: entry.activeWriterRunId,
              expectedState: buildSessionTranscriptTurnExpectedState(entry),
            },
            pendingFinalDelivery: {
              kind: "transport-only",
              intentId,
              sourceRunId: params.runId,
              sourceOutcome: "answer",
              sourceInputs: originals
                .filter((_, index) => !receipts[index])
                .map((input) => input.identity!),
              deliveries: [{ id: deliveryId, state: "prepared" }],
              context: params.context,
              createdAt: Date.now(),
            },
          },
          authority,
        );
      });
      if (outcome.kind !== "committed" || outcome.failure) {
        throw new Error("Source final custody was not committed");
      }
      return {
        kind: "pending-final",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        storePath,
        intentId,
        deliveryId,
      };
    },
  );
}
