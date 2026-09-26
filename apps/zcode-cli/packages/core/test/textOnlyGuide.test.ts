import assert from "node:assert/strict";
import test from "node:test";
import { finishModelStepWithoutToolCalls } from "../src/runtime/methods/turn-stop.js";

test("a text-only model step continues the current turn with its pending user Guide", async () => {
  const persisted: string[] = [];
  const userEntry = { kind: "message", role: "user", content: "Steer the current task" };
  const runtime = {
    sessionId: "session-guide",
    messageHistory: {
      addEntries: (entries: unknown[]) => persisted.push(`entries:${entries.length}`),
    },
    persistPart: async () => persisted.push("assistant-step-finish"),
    persistAssistantMessage: async () => persisted.push("assistant-message"),
    hasInlineGuidePendingInput: () => true,
    drainPendingInput: async () => ({
      injectedMessageIds: ["message-guide"],
      latestMessageId: "message-guide",
      pendingInputIds: ["pending-guide"],
      queryIds: ["query-guide"],
      runtimeEntries: [userEntry],
    }),
    getSessionModelSelection: () => undefined,
    runStopHooks: () => {
      throw new Error("A pending Guide must continue before Stop hooks");
    },
    fallbackPendingGuidesToQueue: () => {
      throw new Error("A text-only Guide must remain in the same turn");
    },
  };
  const state = {
    activeTurn: { turnId: "turn-original", pendingInputs: [{ delivery: "guide" }] },
    currentUserMessageId: "message-original",
    events: [],
    historyRoundCount: 0,
    model: { providerId: "glm", modelId: "GLM-5.3-Flash" },
    modelResponse: "Current answer",
    turnMachine: { aggregateResults: () => ({ phase: "aggregating_results" }) },
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    turnTraceContext: { traceId: "trace-original", turnId: "turn-original" },
  } as never;

  const continuation = await finishModelStepWithoutToolCalls.call(runtime as never, state, {
    assistantPersistenceAnchor: {
      latestAssistantMessageId: undefined,
      latestAssistantTurnId: undefined,
      latestConversationMessageId: undefined,
    },
    assistantCreatedAt: Date.now(),
    assistantMessageId: "message-assistant" as never,
    modelTraceContext: { traceId: "trace-original", turnId: "turn-original" } as never,
    result: { finishReason: "stop", text: "Current answer", usage: {} } as never,
  });

  assert.equal(continuation, "continue");
  assert.equal(
    (state as { turnMachine: { state: { phase: string } } }).turnMachine.state.phase,
    "aggregating_results",
  );
  assert.equal((state as { currentUserMessageId: string }).currentUserMessageId, "message-guide");
  assert.equal(
    (state as { turnTraceContext: { queryId: string } }).turnTraceContext.queryId,
    "query-guide",
  );
  assert.equal(
    (state as { turnRequestState: { entries: unknown[] } }).turnRequestState.entries.at(-1),
    userEntry,
  );
  assert.deepEqual(persisted, ["entries:1", "assistant-step-finish", "assistant-message"]);
});
