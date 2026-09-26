import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelInputMessage, PdfDocumentPort } from "@zcode/contracts";
import { projectMessagesForPdfInput } from "../src/runtime/helpers/pdf-input-projection.js";

const trace = { traceId: "pdf-projection-test" } as never;
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function createPdfPort(pageCounts: number[], paths?: string[]): PdfDocumentPort {
  let countIndex = 0;
  return {
    async getPageCount(request) {
      paths?.push(request.filePath);
      return pageCounts[countIndex++];
    },
    async renderPages(request) {
      return Array.from({ length: request.lastPage - request.firstPage + 1 }, (_, index) => ({
        data: jpeg,
        mediaType: "image/jpeg" as const,
        pageNumber: request.firstPage + index,
      }));
    },
  };
}

test("Local composer PDF projects to two page-labeled images without changing history", async () => {
  const original: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare both pages" },
        {
          type: "file",
          mediaType: "application/pdf",
          name: "notes.pdf",
          source: { id: "attachment-1", kind: "local_file", path: "/tmp/notes.pdf" },
        },
      ],
    },
  ];
  const snapshot = structuredClone(original);
  const paths: string[] = [];
  const projected = await projectMessagesForPdfInput(original, {
    mode: "rendered-pages",
    pdfDocumentPort: createPdfPort([2], paths),
    trace,
  });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(paths, ["/tmp/notes.pdf"]);
  assert.deepEqual(
    (projected[0]?.content as Array<{ type: string; text?: string }>).map((block) => block.type),
    ["text", "text", "image", "text", "image"],
  );
  const content = projected[0]!.content as Array<{ type: string; text?: string; dataUrl?: string }>;
  assert.match(content[1]!.text!, /notes\.pdf.*page 1 of 2/i);
  assert.match(content[3]!.text!, /notes\.pdf.*page 2 of 2/i);
  assert.equal(
    content[2]!.dataUrl,
    `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
  );
  assert.equal(content[4]!.dataUrl, content[2]!.dataUrl);
  assert.equal(
    content.some((block) => block.type === "file"),
    false,
  );
});

test("Local Read-result PDF materializes its data URL and projects in replay too", async () => {
  const pdf = Buffer.from("%PDF-1.4\nread-result\n");
  const messages: ModelInputMessage[] = [
    {
      role: "tool",
      toolCallId: "read-1",
      content: [
        { type: "text", text: "PDF file read" },
        {
          type: "file",
          mediaType: "application/pdf",
          name: "read.pdf",
          dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
        },
      ],
    },
  ];
  const seen: Buffer[] = [];
  const port: PdfDocumentPort = {
    async getPageCount({ filePath }) {
      seen.push(await readFile(filePath));
      return 2;
    },
    async renderPages({ filePath }) {
      seen.push(await readFile(filePath));
      return [1, 2].map((pageNumber) => ({ pageNumber, mediaType: "image/jpeg", data: jpeg }));
    },
  };
  const first = await projectMessagesForPdfInput(messages, {
    mode: "rendered-pages",
    pdfDocumentPort: port,
    trace,
  });
  const replay = await projectMessagesForPdfInput(messages, {
    mode: "rendered-pages",
    pdfDocumentPort: port,
    trace,
  });
  assert.deepEqual(first, replay);
  assert.equal(seen.length, 4);
  for (const value of seen) assert.deepEqual(value, pdf);
  assert.equal((messages[0]!.content as Array<{ type: string }>)[1]!.type, "file");
});

test("replayed composer PDF uses durable data when its original local path is gone", async () => {
  const pdf = Buffer.from("%PDF-1.4\nreplayed-attachment\n");
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          name: "replay.pdf",
          dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
          source: {
            id: "replayed-local-file",
            kind: "local_file",
            path: "/tmp/zcode-path-that-no-longer-exists.pdf",
          },
        },
      ],
    },
  ];
  const port: PdfDocumentPort = {
    async getPageCount({ filePath }) {
      assert.deepEqual(await readFile(filePath), pdf);
      return 1;
    },
    async renderPages() {
      return [{ data: jpeg, mediaType: "image/jpeg", pageNumber: 1 }];
    },
  };
  const projected = await projectMessagesForPdfInput(messages, {
    mode: "rendered-pages",
    pdfDocumentPort: port,
    trace,
  });
  assert.equal((projected[0]!.content as Array<{ type: string }>)[1]!.type, "image");
});

test("native PDF providers keep their original file parts", async () => {
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,AA==" },
      ],
    },
  ];
  const projected = await projectMessagesForPdfInput(messages, { mode: "native", trace });
  assert.equal(projected, messages);
});

test("Local rejects an oversized document with a page-range error", async () => {
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          source: { id: "long", kind: "local_file", path: "/tmp/long.pdf" },
        },
      ],
    },
  ];
  await assert.rejects(
    projectMessagesForPdfInput(messages, {
      mode: "rendered-pages",
      pdfDocumentPort: createPdfPort([21]),
      trace,
    }),
    /21 pages.*20 pages.*range/i,
  );
});

test("Local enforces the 20-page aggregate request limit", async () => {
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          source: { id: "a", kind: "local_file", path: "/tmp/a.pdf" },
        },
        {
          type: "file",
          mediaType: "application/pdf",
          source: { id: "b", kind: "local_file", path: "/tmp/b.pdf" },
        },
      ],
    },
  ];
  await assert.rejects(
    projectMessagesForPdfInput(messages, {
      mode: "rendered-pages",
      pdfDocumentPort: createPdfPort([11, 10]),
      trace,
    }),
    /21 pages.*20 pages.*range/i,
  );
});
