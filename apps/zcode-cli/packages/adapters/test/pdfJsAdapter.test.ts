import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPdfJsPdfDocumentAdapter } from "../src/pdf/index.js";

const trace = { traceId: "pdf-js-adapter-test" } as never;

function twoPagePdf(): Buffer {
  const streams = [
    "BT /F1 20 Tf 20 50 Td (PAGE ONE) Tj ET",
    "BT /F1 20 Tf 20 50 Td (PAGE TWO) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.map(
      (stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ),
  ];
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(parts.join("")));
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  }
  const xrefStart = Buffer.byteLength(parts.join(""));
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) {
    parts.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  return Buffer.from(parts.join(""), "latin1");
}

test("PDF.js counts and renders distinct JPEG pages without Poppler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-pdfjs-test-"));
  const filePath = join(directory, "two-pages.pdf");
  try {
    await writeFile(filePath, twoPagePdf());
    const port = createPdfJsPdfDocumentAdapter();
    assert.equal(await port.getPageCount({ filePath, trace }), 2);
    const pages = await port.renderPages({ filePath, firstPage: 1, lastPage: 2, trace });
    assert.deepEqual(
      pages.map(({ pageNumber, mediaType }) => [pageNumber, mediaType]),
      [
        [1, "image/jpeg"],
        [2, "image/jpeg"],
      ],
    );
    for (const page of pages) {
      assert.deepEqual(page.data.slice(0, 2), Uint8Array.of(0xff, 0xd8));
      assert.ok(page.data.length > 1_000);
    }
    assert.notDeepEqual(pages[0]?.data, pages[1]?.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF.js reports cancellation before reading a document", async () => {
  const controller = new AbortController();
  controller.abort();
  const port = createPdfJsPdfDocumentAdapter();
  await assert.rejects(
    port.renderPages(
      { filePath: "/unused.pdf", firstPage: 1, lastPage: 1, trace },
      { signal: controller.signal },
    ),
    { code: "cancelled" },
  );
});
