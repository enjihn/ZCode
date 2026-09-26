import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { drainInlineGuideForNextRequest } from "../src/runtime/methods/turn-guide-drain.js";

function createRuntime() {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  const promotions: Array<{
    message: { role: string; anchor?: { turnId?: string } };
    parts: Array<{ type: string; text?: string }>;
  }> = [];
  const runtime = new AgentRuntime("session-guide-admission" as never, { agentName: "ZCode" }, {
    eventStore: {
      append: async (event: (typeof events)[number]) => {
        const stored = { ...event, sequenceNumber: events.length + 1 };
        events.push(stored);
        return stored;
      },
      getEvents: async () => events,
    },
    sessionStore: {
      promoteSessionInput: async (promotion: (typeof promotions)[number]) => {
        promotions.push(promotion);
      },
      saveSessionInput: async () => undefined,
    },
  } as never);
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId: "turn-original",
  };
  return { events, promotions, runtime, traceContext };
}

test("Guide admitted during active model output waits in the same turn without cancellation", async () => {
  const { events, runtime, traceContext } = createRuntime();
  const active = runtime.beginActiveTurn(
    "turn-original" as never,
    traceContext as never,
    "regular",
    true,
  );

  const admitted = await runtime.admitPrompt("Please focus on the failing test", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-during-output",
  });

  assert.equal(admitted.kind, "queued");
  assert.equal(admitted.turnId, active.turnId);
  assert.equal(admitted.delivery, "guide");
  assert.equal(active.pendingInputs.length, 1);
  assert.equal((runtime as unknown as { activeTurn?: unknown }).activeTurn, active);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turn_steer_queued"],
  );
});

test("a completed tool batch drains one Guide as user input before the next model request", async () => {
  const { events, promotions, runtime, traceContext } = createRuntime();
  const active = runtime.beginActiveTurn(
    "turn-original" as never,
    traceContext as never,
    "regular",
    true,
  );
  for (const [inputId, text] of [
    ["command-first", "Use the small test"],
    ["command-second", "Also check replay"],
  ]) {
    const admitted = await runtime.admitPrompt(text, undefined, {
      delivery: "start_turn",
      queueDelivery: "guide",
      inputId,
    });
    assert.equal(admitted.kind, "queued");
    assert.equal(admitted.turnId, active.turnId);
    assert.equal(admitted.delivery, "guide");
  }
  const state = {
    activeTurn: active,
    currentUserMessageId: "message-original",
    events: [] as never[],
    modelSelectionScope: "execution",
    turnRequestState: { entries: [] as unknown[] },
    turnTraceContext: traceContext,
  } as never;

  assert.equal(await drainInlineGuideForNextRequest(runtime as never, state), true);
  assert.equal(active.pendingInputs.length, 1);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.message.role, "user");
  assert.deepEqual(
    promotions[0]?.parts.map((part) => part.text),
    ["Use the small test"],
  );
  assert.equal(
    (state as { turnRequestState: { entries: unknown[] } }).turnRequestState.entries.length,
    1,
  );
  assert.equal(await drainInlineGuideForNextRequest(runtime as never, state), true);
  assert.equal(active.pendingInputs.length, 0);
  assert.deepEqual(
    promotions.map((item) => item.parts[0]?.text),
    ["Use the small test", "Also check replay"],
  );
  assert.equal(events.filter((event) => event.type === "turn_steer_drained").length, 2);
  assert.equal((runtime as unknown as { activeTurn?: unknown }).activeTurn, active);
});

test("a Guide arriving after its turn completed starts a new turn", async () => {
  const { runtime, traceContext } = createRuntime();
  const active = runtime.beginActiveTurn(
    "turn-original" as never,
    traceContext as never,
    "regular",
    true,
  );
  runtime.finishActiveTurn(active);
  const enqueuedCommands: unknown[] = [];
  (
    runtime as unknown as { enqueueRuntimeCommand: (command: unknown) => void }
  ).enqueueRuntimeCommand = (command) => enqueuedCommands.push(command);

  const admitted = await runtime.admitPrompt("New request after completion", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-later",
  });

  assert.equal(admitted.kind, "started");
  assert.notEqual(admitted.turnId, active.turnId);
  assert.equal(enqueuedCommands.length, 1);
  assert.equal(
    (runtime as unknown as { activeTurnStartReservation?: { turnId: string } })
      .activeTurnStartReservation?.turnId,
    admitted.turnId,
  );
  await runtime.releaseTurnStart(admitted.turnId);
});

test("Guide requested during maintenance is visibly queued with a fallback reason", async () => {
  const { events, runtime } = createRuntime();
  (runtime as unknown as { runtimeCommandDrainActive: boolean }).runtimeCommandDrainActive = true;
  const admitted = await runtime.admitPrompt("Wait for maintenance", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-maintenance",
    intent: {
      admittedAt: Date.now(),
      admissionSeq: 1,
      clientId: "desktop-client",
      kind: "sendText",
      queueItemId: "queue-maintenance",
      requestedDelivery: "guide",
      sourceCommandId: "command-maintenance",
      text: "Wait for maintenance",
    },
  });

  assert.equal(admitted.kind, "queued");
  assert.equal(admitted.delivery, "queue");
  const queued = events.find((event) => event.type === "turn_steer_queued")?.payload as {
    intent?: { admittedDelivery?: string; fallbackReasonCode?: string };
  };
  assert.equal(queued.intent?.admittedDelivery, "queue");
  assert.equal(queued.intent?.fallbackReasonCode, "guide.maintenance");
  const projection = await runtime.rebuildProjection();
  assert.equal(projection.pendingSteerInputs.length, 1);
  assert.equal(projection.pendingSteerInputs[0]?.intent?.fallbackReasonCode, "guide.maintenance");
});

test("a turn failure preserves an undelivered Guide as a replayable queued input", async () => {
  const { events, runtime, traceContext } = createRuntime();
  const active = runtime.beginActiveTurn(
    "turn-original" as never,
    traceContext as never,
    "regular",
    true,
  );
  const admitted = await runtime.admitPrompt("Keep this after the failure", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-after-failure",
    intent: {
      admittedAt: Date.now(),
      admissionSeq: 1,
      clientId: "desktop-client",
      kind: "sendText",
      queueItemId: "queue-after-failure",
      requestedDelivery: "guide",
      sourceCommandId: "command-after-failure",
      text: "Keep this after the failure",
    },
  });
  assert.equal(admitted.kind, "queued");
  assert.equal(admitted.delivery, "guide");

  const changed = await runtime.fallbackPendingGuidesToQueue({
    activeTurn: active,
    reasonCode: "guide.turnFailed",
    traceContext: traceContext as never,
  });
  runtime.finishActiveTurn(active);

  assert.equal(changed, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turn_steer_queued", "turn_steer_delivery_changed"],
  );
  assert.equal(active.pendingInputs[0]?.delivery, "queue");
  const projection = await runtime.rebuildProjection();
  assert.equal(projection.pendingSteerInputs.length, 1);
  assert.equal(projection.pendingSteerInputs[0]?.targetTurnId, "turn-original");
  assert.equal(projection.pendingSteerInputs[0]?.intent?.admittedDelivery, "queue");
  assert.equal(projection.pendingSteerInputs[0]?.intent?.fallbackReasonCode, "guide.turnFailed");
});
