import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { finishModelStepWithoutToolCalls } from "../src/runtime/methods/turn-stop.js";

test("a Guide arriving during terminal fallback is queued instead of stranded", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  let enterFallback!: () => void;
  const fallbackStarted = new Promise<void>((resolve) => {
    enterFallback = resolve;
  });
  let finishFallback!: () => void;
  const fallbackWrite = new Promise<void>((resolve) => {
    finishFallback = resolve;
  });
  const runtime = new AgentRuntime("session-terminal-overlap" as never, { agentName: "ZCode" }, {
    eventStore: {
      append: async (event: (typeof events)[number]) => {
        const payload = event.payload as { pendingInputId?: string };
        if (
          event.type === "turn_steer_delivery_changed" &&
          payload.pendingInputId === "queue-first"
        ) {
          enterFallback();
          await fallbackWrite;
        }
        const stored = { ...event, sequenceNumber: events.length + 1 };
        events.push(stored);
        return stored;
      },
      getEvents: async () => events,
    },
    sessionStore: { saveSessionInput: async () => undefined },
  } as never);
  const turnId = "turn-terminal-overlap";
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId,
  };
  const active = runtime.beginActiveTurn(turnId as never, traceContext as never, "regular", true);
  const intent = (queueItemId: string, text: string, admissionSeq: number) => ({
    admittedAt: Date.now(),
    admissionSeq,
    clientId: "desktop-client",
    kind: "sendText" as const,
    queueItemId,
    requestedDelivery: "guide" as const,
    sourceCommandId: queueItemId,
    text,
  });
  const first = await runtime.admitPrompt("First Guide", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "queue-first",
    intent: intent("queue-first", "First Guide", 1),
  });
  assert.equal(first.kind, "queued");
  assert.equal(first.delivery, "guide");
  Object.assign(runtime as object, {
    persistAssistantMessage: async () => undefined,
    persistPart: async () => undefined,
  });
  const state = {
    activeTurn: active,
    automationCreateLimitReached: true,
    currentUserMessageId: "message-initial",
    events: [],
    historyRoundCount: 0,
    model: { providerId: "glm", modelId: "GLM-5.3-Flash" },
    modelResponse: "Done",
    turnMachine: { complete: () => ({ phase: "complete" }) },
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
    turnTraceContext: traceContext,
  } as never;
  const finishing = finishModelStepWithoutToolCalls.call(runtime as never, state, {
    assistantPersistenceAnchor: {
      latestAssistantMessageId: undefined,
      latestAssistantTurnId: undefined,
      latestConversationMessageId: undefined,
    },
    assistantCreatedAt: Date.now(),
    assistantMessageId: "message-assistant" as never,
    modelTraceContext: traceContext as never,
    result: { finishReason: "stop", text: "Done", usage: {} } as never,
  });
  try {
    await fallbackStarted;
    const second = await runtime.admitPrompt("Second Guide", undefined, {
      delivery: "start_turn",
      queueDelivery: "guide",
      inputId: "queue-second",
      intent: intent("queue-second", "Second Guide", 2),
    });
    assert.equal(second.kind, "queued");
    assert.equal(second.delivery, "queue");
  } finally {
    finishFallback();
  }
  assert.equal(await finishing, "break");
  assert.equal(active.steerable, false);
  const projection = await runtime.rebuildProjection();
  assert.deepEqual(
    projection.pendingSteerInputs.map((item) => [
      item.pendingInputId,
      item.intent?.admittedDelivery,
      item.intent?.fallbackReasonCode,
    ]),
    [
      ["queue-first", "queue", "guide.noToolBoundary"],
      ["queue-second", "queue", "guide.turnNotSteerable"],
    ],
  );
});
