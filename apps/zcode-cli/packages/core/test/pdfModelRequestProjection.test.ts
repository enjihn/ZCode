import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Model, ModelInputMessage, ModelRequest, PdfDocumentPort } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { runModelTextRequest } from "../src/runtime/methods/model.js";
import type { RunModelTextRequestOptions } from "../src/runtime/types.js";

test("nonstream Local request gives the model labeled PDF page images, never the PDF file part", async () => {
  const pdf = Buffer.from("%PDF-1.4\ntwo-page-model-request\n");
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "What differs between these pages?" },
        {
          type: "file",
          mediaType: "application/pdf",
          name: "comparison.pdf",
          dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
      ],
    },
  ];
  const originalMessages = structuredClone(messages);
  const pageImages = [Uint8Array.of(0xff, 0xd8, 1), Uint8Array.of(0xff, 0xd8, 2)];
  const renderedRanges: Array<[number, number]> = [];
  const pdfDocumentPort: PdfDocumentPort = {
    async getPageCount({ filePath }) {
      assert.deepEqual(await readFile(filePath), pdf);
      return 2;
    },
    async renderPages({ filePath, firstPage, lastPage }) {
      assert.deepEqual(await readFile(filePath), pdf);
      renderedRanges.push([firstPage, lastPage]);
      return pageImages.map((data, index) => ({
        data,
        mediaType: "image/jpeg" as const,
        pageNumber: index + 1,
      }));
    },
  };
  const requests: ModelRequest[] = [];
  const model = {
    providerId: "local-personal",
    modelId: "glm-5.3-flash",
    properties: {
      contextWindow: 1_048_576,
      pdfInputMode: "rendered-pages",
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
    },
    async generateText(request: ModelRequest) {
      requests.push(request);
      return { text: "Page two differs", finishReason: "stop", usage: {}, toolCalls: [] };
    },
  } as unknown as Model;
  const runtime = {
    artifactStore: undefined,
    pdfDocumentPort,
    config: { taskType: "foreground", modelContextBudgetStrategy: "preflight-v1" },
    agentTelemetry: { actorKind: "main" },
    createModelStatusSink: () => undefined,
    buildContextUsageSnapshot: () => undefined,
    buildContextUsageBreakdownFromSnapshot: () => [],
    logContextUsageSnapshot: () => undefined,
    shouldStreamModelText: () => false,
  } as unknown as AgentRuntimeInternal;
  const options = {
    assistantMessageId: "assistant-pdf-test",
    events: [],
    latestRealUserMessageIndex: 0,
    messages,
    model,
    tools: [],
    traceContext: { traceId: "pdf-model-request-test", spanId: "request-1" },
  } as RunModelTextRequestOptions;

  const result = await runModelTextRequest.call(runtime, options);

  assert.equal(result.text, "Page two differs");
  assert.deepEqual(renderedRanges, [[1, 2]]);
  assert.equal(requests.length, 1);
  const providerContent = requests[0]!.messages[0]!.content;
  assert.ok(Array.isArray(providerContent));
  assert.deepEqual(
    providerContent.map((block) => block.type),
    ["text", "text", "image", "text", "image"],
  );
  assert.match(
    providerContent[1]!.type === "text" ? providerContent[1].text : "",
    /comparison\.pdf: page 1 of 2/,
  );
  assert.match(
    providerContent[3]!.type === "text" ? providerContent[3].text : "",
    /comparison\.pdf: page 2 of 2/,
  );
  for (const [index, bytes] of pageImages.entries()) {
    const block = providerContent[2 + index * 2]!;
    assert.equal(block.type, "image");
    if (block.type === "image") {
      assert.equal(
        block.dataUrl,
        `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
      );
    }
  }
  assert.equal(
    providerContent.some((block) => block.type === "file"),
    false,
  );
  assert.deepEqual(messages, originalMessages);
});
