import { AsyncLocalStorage } from "node:async_hooks";
// Transient user-turn transcript context carried through runtime queues.
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { createMessageInjectionAuthority } from "../auto-reply/reply/message-injection-authority.js";
import { runWithAsyncStore } from "../shared/async-store.js";
import { getUserTurnTranscriptAdmissionOwner } from "./user-turn-transcript-admission.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

const RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT = Symbol.for(
  "openclaw.runtimeUserTurnTranscriptContext",
);
const RUNTIME_USER_TURN_TRANSCRIPT_RECORDER = Symbol.for(
  "openclaw.runtimeUserTurnTranscriptRecorder",
);

type RuntimeUserTurnTranscriptContext = {
  message: PersistedUserTurnMessage;
  recorder: UserTurnTranscriptRecorder;
};

type RuntimeUserTurnMessage = AgentMessage & {
  [RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT]?: RuntimeUserTurnTranscriptContext;
  [RUNTIME_USER_TURN_TRANSCRIPT_RECORDER]?: UserTurnTranscriptRecorder;
};

// Existing invocation custody follows actual committed steering, not generated prompt text.
const completionInputScope = new AsyncLocalStorage<{
  owner?: object;
  recorder?: UserTurnTranscriptRecorder;
  committedRecorders: Set<UserTurnTranscriptRecorder>;
}>();
export function readCurrentUserTurnInputRecorder() {
  const scope = completionInputScope.getStore();
  return scope ? (scope.recorder ?? null) : undefined;
}
export function readCommittedUserTurnInputRecorders(
  recorder?: UserTurnTranscriptRecorder,
): readonly UserTurnTranscriptRecorder[] {
  return [
    ...(completionInputScope.getStore()?.committedRecorders ??
      (recorder ? getUserTurnTranscriptAdmissionOwner(recorder)?.committedInputs : undefined) ??
      []),
  ];
}
export function publishCommittedUserTurnInput(
  recorder: UserTurnTranscriptRecorder | undefined,
  message?: PersistedUserTurnMessage,
) {
  const scope = completionInputScope.getStore();
  if (!scope) {
    return;
  }
  if (recorder && getUserTurnTranscriptAdmissionOwner(recorder)) {
    scope.recorder = recorder;
    scope.committedRecorders.add(recorder);
  } else if (
    !scope.recorder ||
    getUserTurnTranscriptAdmissionOwner(scope.recorder)?.message()?.idempotencyKey !==
      message?.idempotencyKey
  ) {
    scope.recorder = undefined;
  }
}
export async function withCurrentUserTurnInput<T>(
  recorder: UserTurnTranscriptRecorder | undefined,
  run: () => T,
  owner?: object,
): Promise<Awaited<T>> {
  const previous = completionInputScope.getStore();
  const scope =
    !previous || (owner && previous.owner !== owner)
      ? { owner, recorder, committedRecorders: new Set(recorder ? [recorder] : []) }
      : previous;
  const native = recorder && getUserTurnTranscriptAdmissionOwner(recorder);
  if (native) {
    native.committedInputs = scope.committedRecorders;
  }
  const enter = () => runWithAsyncStore(completionInputScope, scope, run);
  return await (recorder?.withPendingInputCurrent
    ? recorder.withPendingInputCurrent(enter)
    : recorder?.withPendingInput
      ? recorder.withPendingInput(enter)
      : enter());
}

export function bindUserTurnInput(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertCallerCurrent: () => void,
) {
  const assertNativeCurrent = () => {
    assertCallerCurrent();
    recorder?.withPendingInput?.(() => {});
  };
  return {
    assertNativeCurrent,
    assertLifetimeCurrent: () => {
      assertCallerCurrent();
      if (recorder?.assertPendingInputLifetimeCurrent) {
        recorder.assertPendingInputLifetimeCurrent();
      } else {
        recorder?.withPendingInput?.(() => {});
      }
    },
    withCurrent: async <T>(run: () => T): Promise<Awaited<T>> => {
      assertCallerCurrent();
      return await withCurrentUserTurnInput(recorder, () => {
        assertCallerCurrent();
        return run();
      });
    },
  };
}

/** Carries transcript-only fields with a queued runtime message without exposing them to the model. */
export function attachRuntimeUserTurnTranscriptContext(
  runtimeMessage: PersistedUserTurnMessage,
  context: RuntimeUserTurnTranscriptContext,
): PersistedUserTurnMessage {
  Object.defineProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT, {
    configurable: true,
    value: context,
  });
  return runtimeMessage;
}

/** Consumes the transient queued-turn context before the message is serialized. */
export function takeRuntimeUserTurnTranscriptContext(
  runtimeMessage: RuntimeUserTurnMessage,
): RuntimeUserTurnTranscriptContext | undefined {
  const context = runtimeMessage[RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT];
  if (context) {
    Reflect.deleteProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_CONTEXT);
  }
  return context;
}

/** Keeps the queued recorder attached to the exact final message until persistence succeeds. */
export function attachRuntimeUserTurnTranscriptRecorder(
  runtimeMessage: AgentMessage,
  recorder: UserTurnTranscriptRecorder,
): AgentMessage {
  Object.defineProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_RECORDER, {
    configurable: true,
    value: recorder,
  });
  return runtimeMessage;
}

function readRuntimeUserTurnTranscriptRecorder(
  runtimeMessage: RuntimeUserTurnMessage,
): UserTurnTranscriptRecorder | undefined {
  return runtimeMessage[RUNTIME_USER_TURN_TRANSCRIPT_RECORDER];
}

/** A steered message retains its own live custody while another turn owns the runtime. */
export function withRuntimeUserTurnTranscriptRecorder<T>(
  runtimeMessage: AgentMessage,
  append: (beforeFreshMessageCommit?: () => void) => T,
): T {
  const recorder = readRuntimeUserTurnTranscriptRecorder(runtimeMessage);
  const assertCommit = recorder?.assertOriginalInputCommit;
  // Capture before SessionManager canonicalizes the message and drops its symbols.
  // Only the fresh SQL append invokes this assertion; replay keeps its recorded result.
  const beforeFreshMessageCommit = assertCommit
    ? createMessageInjectionAuthority(() => {
        assertCommit();
        return true;
      })
    : undefined;
  const persist = () => append(beforeFreshMessageCommit);
  return recorder?.withPendingInput ? recorder.withPendingInput(persist) : persist();
}

export async function withCurrentRuntimeUserTurnTranscriptRecorder<T>(
  runtimeMessage: AgentMessage,
  append: (beforeFreshMessageCommit?: () => void) => T,
): Promise<Awaited<T>> {
  const recorder = readRuntimeUserTurnTranscriptRecorder(runtimeMessage);
  return await withCurrentUserTurnInput(recorder, () =>
    withRuntimeUserTurnTranscriptRecorder(runtimeMessage, append),
  );
}

export function takeRuntimeUserTurnTranscriptRecorder(
  runtimeMessage: RuntimeUserTurnMessage,
): UserTurnTranscriptRecorder | undefined {
  const recorder = readRuntimeUserTurnTranscriptRecorder(runtimeMessage);
  if (recorder) {
    Reflect.deleteProperty(runtimeMessage, RUNTIME_USER_TURN_TRANSCRIPT_RECORDER);
  }
  return recorder;
}
