import assert from "node:assert/strict";
import test from "node:test";
import { TurnMachineImpl } from "../src/agent/turn-machine.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { runRegularTurnLoop } from "../src/runtime/methods/turn-loop.js";

test("a Guide arriving during awaited Todo preparation enters the first provider request", async () => {
  const events: Array<{ type: string; payload: unknown; sequenceNumber: number }> = [];
  const runtime = new AgentRuntime("session-pre-request" as never, { agentName: "ZCode" }, {
    eventStore: {
      append: async (event: (typeof events)[number]) => {
        const stored = { ...event, sequenceNumber: events.length + 1 };
        events.push(stored);
        return stored;
      },
      getEvents: async () => events,
    },
    sessionStore: {
      promoteSessionInput: async () => undefined,
      saveSessionInput: async () => undefined,
    },
  } as never);
  const turnId = "turn-pre-request";
  const traceContext = {
    ...(runtime as unknown as { rootTraceContext: Record<string, unknown> }).rootTraceContext,
    turnId,
  };
  const activeTurn = runtime.beginActiveTurn(
    turnId as never,
    traceContext as never,
    "regular",
    true,
  );
  let enterTodoRead!: () => void;
  const todoReadStarted = new Promise<void>((resolve) => {
    enterTodoRead = resolve;
  });
  let finishTodoRead!: () => void;
  const todoRead = new Promise<void>((resolve) => {
    finishTodoRead = resolve;
  });
  const stopAtProviderBoundary = new Error("provider request captured");
  Object.assign(runtime as object, {
    autoCompactIfNeeded: async () => "skipped",
    getTools: () => [{ name: "TodoWrite" }],
    initializeMcp: async () => undefined,
    microcompactIfNeeded: async () => undefined,
    persistAssistantMessage: async () => {
      throw stopAtProviderBoundary;
    },
    persistSyntheticUserNoticeForSession: async () => undefined,
    readSessionTodosForContext: async () => {
      enterTodoRead();
      await todoRead;
      return [];
    },
  });
  const turnMachine = TurnMachineImpl.create(
    "session-pre-request" as never,
    1,
    "Initial request",
    traceContext.traceId as never,
    turnId as never,
  );
  const state = {
    activeTurn,
    currentUserMessageId: "message-initial",
    events: [],
    model: {
      modelId: "GLM-5.3-Flash",
      providerId: "glm",
      optionSpecs: { maxOutputTokens: { max: 4096 } },
      properties: { supportsMidConversationSystem: false },
    },
    modelStepCount: 0,
    repeatedToolCallStreakCount: 0,
    toolCallCount: 0,
    turnAbortSignal: new AbortController().signal,
    turnMachine: new TurnMachineImpl(turnMachine.start()),
    turnRequestState: {
      entries: [
        ...Array.from({ length: 10 }, (_, index) => ({
          message: { role: "assistant" as const, content: `Earlier answer ${index}` },
        })),
        { message: { role: "user" as const, content: "Initial request" } },
      ],
      outputTokenContinuationCount: 0,
    },
    turnTraceContext: traceContext,
  } as never;

  const loop = runRegularTurnLoop.call(runtime as never, state);
  try {
    await todoReadStarted;
    const accepted = await runtime.admitPrompt("Guide during Todo preparation", undefined, {
      delivery: "start_turn",
      queueDelivery: "guide",
      inputId: "command-late-guide",
    });
    assert.equal(accepted.kind, "queued");
    assert.equal(accepted.delivery, "guide");
  } finally {
    finishTodoRead();
  }
  await assert.rejects(loop, (error) => error === stopAtProviderBoundary);
  const request = (state as { turnMachine: TurnMachineImpl }).turnMachine.state.modelRequest;
  assert.ok(request);
  assert.equal(
    request.messages.filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("Guide during Todo preparation"),
    ).length,
    1,
  );
});
