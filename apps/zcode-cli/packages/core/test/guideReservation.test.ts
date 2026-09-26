import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";

test("Guide sent during a turn start reservation drains once in the reserved turn", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  const promotions: Array<{
    id: string;
    message: { role: string; anchor?: { turnId?: string } };
    parts: Array<{ type: string; text?: string }>;
  }> = [];
  const runtime = new AgentRuntime("session-guide" as never, { agentName: "ZCode" }, {
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
  const runtimeState = runtime as unknown as { rootTraceContext: Record<string, unknown> };
  const turnId = "turn-original";
  const traceContext = { ...runtimeState.rootTraceContext, turnId };
  runtime.reserveTurnStart(turnId as never, traceContext as never, "regular");

  const accepted = await runtime.admitPrompt("Steer the same task", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-guide",
    queryId: "command-guide" as never,
  });

  assert.equal(accepted.kind, "queued");
  assert.equal(accepted.turnId, turnId);
  assert.equal((accepted as { delivery?: string }).delivery, "guide");
  const active = runtime.beginActiveTurn(turnId as never, traceContext as never, "regular", true, {
    inputId: "command-initial",
  });
  assert.equal(active.pendingInputs.length, 1);
  assert.equal(active.pendingInputs[0]?.delivery, "guide");

  const firstDrain = await runtime.drainPendingInput({
    activeTurn: active,
    events: [] as never[],
    traceContext: traceContext as never,
  });
  const secondDrain = await runtime.drainPendingInput({
    activeTurn: active,
    events: [] as never[],
    traceContext: traceContext as never,
  });
  assert.equal(firstDrain?.pendingInputIds.length, 1);
  assert.equal(secondDrain, undefined);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.message.role, "user");
  assert.deepEqual(
    promotions[0]?.parts.map((part) => part.text),
    ["Steer the same task"],
  );
  assert.equal(events.filter((event) => event.type === "turn_steer_drained").length, 1);
  assert.equal(
    events.some((event) => event.type === "turn_complete" || event.type === "turn_error"),
    false,
  );
});

test("a failed start reservation changes its accepted Guide to a visible queue item", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  const runtime = new AgentRuntime("session-failed-start" as never, { agentName: "ZCode" }, {
    eventStore: {
      append: async (event: (typeof events)[number]) => {
        const stored = { ...event, sequenceNumber: events.length + 1 };
        events.push(stored);
        return stored;
      },
      getEvents: async () => events,
    },
    sessionStore: { saveSessionInput: async () => undefined },
  } as never);
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId: "turn-failed-start",
  };
  runtime.reserveTurnStart("turn-failed-start" as never, traceContext as never, "regular");
  const accepted = await runtime.admitPrompt("Guide during startup", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-startup-guide",
    queryId: "command-startup-guide" as never,
    intent: {
      admittedAt: Date.now(),
      admittedDelivery: "guide",
      admissionSeq: 1,
      clientId: "desktop-client",
      kind: "sendText",
      queueItemId: "queue-startup-guide",
      requestedDelivery: "guide",
      sourceCommandId: "command-startup-guide",
      text: "Guide during startup",
    },
  });
  assert.equal(accepted.kind, "queued");
  assert.equal(accepted.turnId, "turn-failed-start");
  assert.equal((accepted as { delivery?: string }).delivery, "guide");

  await runtime.releaseTurnStart("turn-failed-start" as never);

  const changes = events.filter((event) => event.type === "turn_steer_delivery_changed");
  assert.equal(changes.length, 1);
  const change = changes[0]?.payload as {
    admittedDelivery?: string;
    fallbackReasonCode?: string;
  };
  assert.equal(change.admittedDelivery, "queue");
  assert.ok(change.fallbackReasonCode);
  const projection = await runtime.rebuildProjection();
  assert.equal(projection.pendingSteerInputs.length, 1);
  assert.equal(projection.pendingSteerInputs[0]?.intent?.admittedDelivery, "queue");
  assert.equal(
    projection.pendingSteerInputs[0]?.intent?.fallbackReasonCode,
    change.fallbackReasonCode,
  );
});

test("a Guide admitted while start fallback is persisting also becomes a visible queue item", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  let enterFallback!: () => void;
  const fallbackStarted = new Promise<void>((resolve) => {
    enterFallback = resolve;
  });
  let finishFallback!: () => void;
  const fallbackWrite = new Promise<void>((resolve) => {
    finishFallback = resolve;
  });
  const runtime = new AgentRuntime("session-overlapping-start" as never, { agentName: "ZCode" }, {
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
  const turnId = "turn-overlapping-start";
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId,
  };
  runtime.reserveTurnStart(turnId as never, traceContext as never, "regular");
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

  const release = runtime.releaseTurnStart(turnId as never);
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
  await release;

  const changes = events
    .filter((event) => event.type === "turn_steer_delivery_changed")
    .map((event) => event.payload as { admittedDelivery: string; pendingInputId: string });
  assert.deepEqual(
    changes.map((change) => [change.pendingInputId, change.admittedDelivery]),
    [["queue-first", "queue"]],
  );
  const projection = await runtime.rebuildProjection();
  assert.deepEqual(
    projection.pendingSteerInputs.map((item) => [
      item.pendingInputId,
      item.intent?.admittedDelivery,
    ]),
    [
      ["queue-first", "queue"],
      ["queue-second", "queue"],
    ],
  );
  assert.deepEqual(
    projection.pendingSteerInputs.map((item) => item.intent?.fallbackReasonCode),
    ["guide.startFailed", "guide.startFailed"],
  );
  assert.equal(
    (runtime as unknown as { activeTurnStartReservation?: unknown }).activeTurnStartReservation,
    undefined,
  );
});

test("removing an accepted reserved Guide prevents its later delivery", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  const cancelledInputs: string[] = [];
  const runtime = new AgentRuntime("session-removed-guide" as never, { agentName: "ZCode" }, {
    eventStore: {
      append: async (event: (typeof events)[number]) => {
        const stored = { ...event, sequenceNumber: events.length + 1 };
        events.push(stored);
        return stored;
      },
      getEvents: async () => events,
    },
    sessionStore: {
      saveSessionInput: async () => undefined,
      settleSessionInput: async ({ id }: { id: string }) => {
        cancelledInputs.push(id);
      },
    },
  } as never);
  const turnId = "turn-removal";
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId,
  };
  runtime.reserveTurnStart(turnId as never, traceContext as never, "regular");
  const accepted = await runtime.admitPrompt("Withdraw this Guide", undefined, {
    delivery: "start_turn",
    queueDelivery: "guide",
    inputId: "command-removed-guide",
  });
  assert.equal(accepted.kind, "queued");
  if (accepted.kind !== "queued") return;

  const removed = await runtime.removePendingInputById({
    pendingInputId: accepted.pendingInputId,
    reason: "user_removed",
    traceContext: traceContext as never,
  });
  const active = runtime.beginActiveTurn(turnId as never, traceContext as never, "regular", true);
  const drained = await runtime.drainPendingInput({
    activeTurn: active,
    events: [] as never[],
    traceContext: traceContext as never,
  });

  assert.equal(removed, true);
  assert.ok(cancelledInputs.includes(accepted.pendingInputId));
  assert.equal(active.pendingInputs.length, 0);
  assert.equal(drained, undefined);
  assert.equal(events.filter((event) => event.type === "turn_steer_discarded").length, 1);
});
