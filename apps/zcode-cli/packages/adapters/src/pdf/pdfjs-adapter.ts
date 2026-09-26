import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import {
  PdfDocumentPortError,
  READ_PDF_INFO_TIMEOUT_MS,
  READ_PDF_RENDER_TIMEOUT_MS,
  type PdfDocumentPageCountRequest,
  type PdfDocumentPort,
  type PdfDocumentRenderPagesRequest,
  type PdfDocumentRenderedPage,
} from "@zcode/contracts";

const RENDER_SCALE = 100 / 72;

export function createPdfJsPdfDocumentAdapter(): PdfDocumentPort {
  return new PdfJsPdfDocumentAdapter();
}

class PdfJsPdfDocumentAdapter implements PdfDocumentPort {
  async getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number> {
    return withPdfDocument(
      request.filePath,
      READ_PDF_INFO_TIMEOUT_MS,
      options?.signal,
      async (document) => document.numPages,
    );
  }

  async renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]> {
    return withPdfDocument(
      request.filePath,
      READ_PDF_RENDER_TIMEOUT_MS,
      options?.signal,
      async (document, signal) => {
        if (
          !Number.isSafeInteger(request.firstPage) ||
          !Number.isSafeInteger(request.lastPage) ||
          request.firstPage < 1 ||
          request.lastPage < request.firstPage ||
          request.lastPage > document.numPages
        ) {
          throw new PdfDocumentPortError(
            "page_out_of_range",
            `Requested pages ${request.firstPage}-${request.lastPage} are outside this PDF's 1-${document.numPages} page range.`,
          );
        }
        const { createCanvas } = await import("@napi-rs/canvas");
        const pages: PdfDocumentRenderedPage[] = [];
        for (let pageNumber = request.firstPage; pageNumber <= request.lastPage; pageNumber += 1) {
          signal.throwIfAborted();
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const renderTask = page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
            viewport,
            background: "rgb(255,255,255)",
          });
          const onAbort = () => renderTask.cancel();
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            await renderTask.promise;
            signal.throwIfAborted();
            const jpeg = await canvas.encode("jpeg", 80);
            signal.throwIfAborted();
            pages.push({
              data: new Uint8Array(jpeg),
              mediaType: "image/jpeg",
              pageNumber,
            });
          } finally {
            signal.removeEventListener("abort", onAbort);
            page.cleanup();
          }
        }
        return pages;
      },
    );
  }
}

type PdfDocument = Awaited<
  ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>["promise"]
>;

async function withPdfDocument<T>(
  filePath: string,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (document: PdfDocument, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref();
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout.signal]) : timeout.signal;
  let loadingTask:
    | ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>
    | undefined;
  try {
    signal.throwIfAborted();
    const data = new Uint8Array(await readFile(filePath, { signal }));
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    signal.throwIfAborted();
    const assetRoot = resolvePdfJsAssetRoot();
    loadingTask = getDocument({
      data,
      cMapUrl: join(assetRoot, "cmaps") + sep,
      cMapPacked: true,
      standardFontDataUrl: join(assetRoot, "standard_fonts") + sep,
      wasmUrl: join(assetRoot, "wasm") + sep,
      useSystemFonts: true,
      isEvalSupported: false,
    });
    const task = loadingTask;
    const onAbort = () => {
      void task.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const document = await task.promise;
      signal.throwIfAborted();
      if (document.numPages < 1) {
        throw new PdfDocumentPortError(
          "corrupted",
          "PDF reports 0 pages (empty page tree). The PDF may be invalid.",
        );
      }
      return await operation(document, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    throw classifyPdfJsError(error, parentSignal, timeout.signal, timeoutMs);
  } finally {
    clearTimeout(timer);
    await loadingTask?.destroy();
  }
}

function resolvePdfJsAssetRoot(): string {
  // CLI bundle is a standalone CJS file. Resolve assets from its entry point so the
  // packaged Agent and the source test both find the same installed package layout.
  const entry = resolve(process.argv[1] ?? join(process.cwd(), "zcode.cjs"));
  return dirname(createRequire(entry).resolve("pdfjs-dist/package.json"));
}

function classifyPdfJsError(
  error: unknown,
  parentSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): PdfDocumentPortError {
  if (parentSignal?.aborted) {
    return new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
      cause: error,
    });
  }
  if (timeoutSignal.aborted) {
    return new PdfDocumentPortError(
      "timeout",
      `PDF page extraction timed out after ${timeoutMs}ms.`,
      { cause: error },
    );
  }
  if (error instanceof PdfDocumentPortError) return error;
  if (error instanceof Error) {
    if (error.name === "PasswordException") {
      return new PdfDocumentPortError(
        "password_protected",
        "PDF is password-protected. Please provide an unprotected version.",
        { cause: error },
      );
    }
    if (error.name === "InvalidPDFException" || error.name === "MissingPDFException") {
      return new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.", {
        cause: error,
      });
    }
    if ("code" in error && error.code === "EACCES") {
      return new PdfDocumentPortError(
        "permission_denied",
        "Unable to read PDF because permission was denied.",
        { cause: error },
      );
    }
    if ("code" in error && error.code === "ENOENT") {
      return new PdfDocumentPortError("io_error", "PDF file was not found.", { cause: error });
    }
  }
  return new PdfDocumentPortError("process_failed", "Could not render PDF pages.", {
    cause: error,
  });
}
