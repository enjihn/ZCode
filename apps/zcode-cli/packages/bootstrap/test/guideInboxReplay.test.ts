import assert from "node:assert/strict";
import test from "node:test";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";

function sendText(commandId: string) {
  return {
    clientId: "desktop-client",
    commandId,
    issuedAt: Date.now(),
    payload: { text: `Guide from ${commandId}` },
    sessionId: "session-guide",
    type: "sendText",
  };
}

test("Guide command retries, session ordering, and reconnect replay keep one admission", async () => {
  const host = { getRevision: () => 3, getLogEpoch: () => "epoch-1" };
  const inbox = new CommandInbox(host);
  const firstCommand = sendText("guide-command-1");
  const first = await inbox.handle(firstCommand);
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;
  assert.equal(first.admissionSeq, 1);

  const secondPending = inbox.handle(sendText("guide-command-2"));
  const retryPending = inbox.handle(firstCommand);
  first.settle({
    status: "accepted",
    result: { type: "inputAccepted", delivery: "guide", inputId: "guide-command-1" },
  });

  const retry = await retryPending;
  const second = await secondPending;
  assert.equal(retry.kind, "ack");
  if (retry.kind === "ack") {
    assert.equal(retry.ack.status, "duplicate");
    assert.deepEqual(retry.ack.result, {
      type: "inputAccepted",
      delivery: "guide",
      inputId: "guide-command-1",
    });
  }
  assert.equal(second.kind, "execute");
  if (second.kind === "execute") {
    assert.equal(second.admissionSeq, 2);
    second.settle({ status: "accepted" });
  }

  const recovered = new CommandInbox({
    ...host,
    lookupTranscriptCommand: ({ commandId }: { commandId: string }) =>
      commandId === "guide-command-1"
        ? {
            commandId,
            status: "accepted" as const,
            revisionAtDecision: 3,
            result: {
              type: "inputAccepted" as const,
              delivery: "guide" as const,
              inputId: commandId,
            },
          }
        : null,
  });
  const reconnectRetry = await recovered.handle(firstCommand);
  assert.equal(reconnectRetry.kind, "ack");
  if (reconnectRetry.kind === "ack") {
    assert.equal(reconnectRetry.ack.status, "duplicate");
    assert.equal(reconnectRetry.ack.result?.type, "inputAccepted");
  }
});
