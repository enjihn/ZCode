import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { READ_PDF_MAX_PAGES_PER_REQUEST } from "@zcode/contracts";
import type {
  ModelInputMessage,
  ModelMessageContentBlock,
  PdfDocumentPort,
  TraceContext,
} from "../deps.js";

interface PdfInputProjectionOptions {
  mode: "native" | "rendered-pages";
  pdfDocumentPort?: PdfDocumentPort;
  signal?: AbortSignal;
  trace: TraceContext;
}

/** Project request-local PDF pages for models whose chat API accepts images but not file parts. */
export async function projectMessagesForPdfInput(
  messages: ModelInputMessage[],
  options: PdfInputProjectionOptions,
): Promise<ModelInputMessage[]> {
  if (options.mode !== "rendered-pages") return messages;
  if (!messages.some((message) => Array.isArray(message.content) && message.content.some(isPdf))) {
    return messages;
  }
  if (!options.pdfDocumentPort) {
    throw new Error(
      "PDF page rendering is unavailable for this model. Try again after updating ZCode.",
    );
  }

  let totalPages = 0;
  const projected: ModelInputMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      projected.push(message);
      continue;
    }
    const content: ModelMessageContentBlock[] = [];
    let changed = false;
    for (const block of message.content) {
      if (!isPdf(block)) {
        content.push(block);
        continue;
      }
      changed = true;
      const rendered = await withPdfFile(block, async (filePath) => {
        const pageCount = await options.pdfDocumentPort!.getPageCount(
          { filePath, trace: options.trace },
          { signal: options.signal },
        );
        if (!pageCount || !Number.isSafeInteger(pageCount) || pageCount < 1) {
          throw new Error(`Unable to determine page count for ${pdfName(block)}.`);
        }
        totalPages += pageCount;
        if (totalPages > READ_PDF_MAX_PAGES_PER_REQUEST) {
          throw new Error(
            `PDF input has ${totalPages} pages; the limit is ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per model request. Use Read with a smaller page range (for example, pages: "1-20").`,
          );
        }
        const pages = await options.pdfDocumentPort!.renderPages(
          { filePath, firstPage: 1, lastPage: pageCount, trace: options.trace },
          { signal: options.signal },
        );
        if (
          pages.length !== pageCount ||
          pages.some((page, index) => page.pageNumber !== index + 1)
        ) {
          throw new Error(`PDF renderer returned incomplete pages for ${pdfName(block)}.`);
        }
        return pages.flatMap((page): ModelMessageContentBlock[] => [
          { type: "text", text: `${pdfName(block)}: page ${page.pageNumber} of ${pageCount}` },
          {
            type: "image",
            mediaType: page.mediaType,
            dataUrl: `data:${page.mediaType};base64,${Buffer.from(page.data).toString("base64")}`,
          },
        ]);
      });
      content.push(...rendered);
    }
    projected.push(changed ? { ...message, content } : message);
  }
  return projected;
}

function isPdf(
  block: ModelMessageContentBlock,
): block is Extract<ModelMessageContentBlock, { type: "file" }> {
  return (
    block.type === "file" &&
    block.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
  );
}

function pdfName(block: Extract<ModelMessageContentBlock, { type: "file" }>): string {
  return (
    block.name ??
    block.source?.placeholder ??
    (block.source?.path ? basename(block.source.path) : "PDF")
  );
}

async function withPdfFile<T>(
  block: Extract<ModelMessageContentBlock, { type: "file" }>,
  useFile: (filePath: string) => Promise<T>,
): Promise<T> {
  // Persisted attachment bytes survive a renamed/deleted original file during replay.
  const encoded = /^data:application\/pdf(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/iu.exec(
    block.dataUrl ?? "",
  )?.[1];
  if (!encoded) {
    if (block.source?.path) return useFile(block.source.path);
    throw new Error(`PDF data is unavailable for ${pdfName(block)}.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "zcode-model-pdf-"));
  try {
    const filePath = join(directory, "input.pdf");
    await writeFile(filePath, Buffer.from(encoded, "base64"));
    return await useFile(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
