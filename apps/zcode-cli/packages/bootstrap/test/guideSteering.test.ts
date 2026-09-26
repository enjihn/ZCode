import assert from "node:assert/strict";
import test from "node:test";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

// Load the command entrypoint first because its handler registry has a circular ESM edge.
await import("../src/zcode-protocol-v4/commands/executor.js");
const { sessionFlowHandlers } =
  await import("../src/zcode-protocol-v4/commands/handlers/session-flow.js");

test("plain Enter uses the session Guide preference when the projected routing is stale", async () => {
  const sent: { input: unknown; options: Record<string, unknown> }[] = [];
  const record = {
    activeBotDeliveryTarget: undefined,
    app: {
      getMode: () => "build",
      getModel: () => "glm:GLM-5.3-Flash",
      runtime: {
        getPlanEnabled: () => false,
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "GLM-5.3-Flash" }),
      },
      sendInput: async (input: unknown, options: Record<string, unknown>) => {
        sent.push({ input, options });
        return {
          kind: "queued" as const,
          delivery: "guide" as const,
          pendingInputId: "pending-steer",
          queueLength: 1,
          turnId: "turn-running",
        };
      },
      sessionId: "session-guide",
    },
    persistence: "immediate" as const,
  };
  const host = {
    getInputRoutingMode: () => "startNow" as const,
    getRecord: () => record,
    getSessionFollowupMode: () => "guide" as const,
  } as unknown as V4CommandCoreHost;
  const envelope = {
    clientId: "desktop-client",
    commandId: "command-steer",
    payload: { text: "Please prioritize the failing test" },
    sessionId: "session-guide",
    type: "sendText",
  } as unknown as CommandEnvelope;

  const accepted = await sessionFlowHandlers.sendText(host, envelope);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options.queueDelivery, "guide");
  assert.equal(
    (sent[0]?.options.intent as { requestedDelivery?: string } | undefined)?.requestedDelivery,
    "guide",
  );
  assert.deepEqual(accepted, {
    type: "inputAccepted",
    delivery: "guide",
    inputId: "command-steer",
  });
});

test("Queue preference remains a future input even if the projected route says Guide", async () => {
  const sent: Array<{ options: Record<string, unknown> }> = [];
  const record = {
    activeBotDeliveryTarget: undefined,
    app: {
      getMode: () => "build",
      getModel: () => "glm:GLM-5.3-Flash",
      runtime: {
        getPlanEnabled: () => false,
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "GLM-5.3-Flash" }),
      },
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        sent.push({ options });
        return {
          kind: "queued" as const,
          delivery: "queue" as const,
          pendingInputId: "pending-future",
          queueLength: 1,
          turnId: "turn-running",
        };
      },
      sessionId: "session-queue",
    },
    persistence: "immediate" as const,
  };
  const host = {
    getInputRoutingMode: () => "guide" as const,
    getRecord: () => record,
    getSessionFollowupMode: () => "queue" as const,
  } as unknown as V4CommandCoreHost;
  const envelope = {
    clientId: "desktop-client",
    commandId: "command-queue",
    payload: { text: "Run this next" },
    sessionId: "session-queue",
    type: "sendText",
  } as unknown as CommandEnvelope;

  const accepted = await sessionFlowHandlers.sendText(host, envelope);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.options.queueDelivery, undefined);
  assert.equal(
    (sent[0]?.options.intent as { requestedDelivery?: string } | undefined)?.requestedDelivery,
    "queue",
  );
  assert.deepEqual(accepted, {
    type: "inputAccepted",
    delivery: "queue",
    inputId: "command-queue",
  });
});

test("explicit Send now preempts and starts a new turn despite a Guide preference", async () => {
  const calls: string[] = [];
  const sent: Array<{ options: Record<string, unknown> }> = [];
  const record = {
    activeBotDeliveryTarget: undefined,
    app: {
      getMode: () => "build",
      getModel: () => "glm:GLM-5.3-Flash",
      readTarget: async () => null,
      runtime: {
        acquireForegroundPromotionLease: () => {
          calls.push("acquire");
          return { kind: "acquired" as const, leaseId: "send-now:command-now" };
        },
        getActiveForegroundExecutionId: () => undefined,
        getPlanEnabled: () => false,
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "GLM-5.3-Flash" }),
        releaseForegroundPromotionLease: () => calls.push("release"),
        stopActiveForegroundExecution: () => {
          calls.push("stop");
          return { kind: "stopped" as const, foregroundExecutionId: "running" };
        },
      },
      sendInput: async (_input: unknown, options: Record<string, unknown>) => {
        calls.push("admit");
        sent.push({ options });
        return { kind: "started" as const, turnId: "turn-new", completion: Promise.resolve({}) };
      },
      sessionId: "session-send-now",
    },
    persistence: "immediate" as const,
  };
  const host = {
    getInputRoutingMode: () => "guide" as const,
    getRecord: () => record,
    getSessionFollowupMode: () => "guide" as const,
  } as unknown as V4CommandCoreHost;
  const envelope = {
    clientId: "desktop-client",
    commandId: "command-now",
    payload: { text: "Stop and handle this now", requestedDelivery: "startNow" },
    sessionId: "session-send-now",
    type: "sendText",
  } as unknown as CommandEnvelope;

  const accepted = await sessionFlowHandlers.sendText(host, envelope);

  assert.deepEqual(calls, ["acquire", "stop", "admit", "release"]);
  assert.equal(sent[0]?.options.requireIdle, true);
  assert.equal(sent[0]?.options.inputPresentation, "user_steer");
  assert.deepEqual(accepted, {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: "command-now",
  });
});
