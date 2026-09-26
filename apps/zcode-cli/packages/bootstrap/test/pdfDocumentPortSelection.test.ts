import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionPort, PdfDocumentPort } from "@zcode/contracts";
import { resolvePdfDocumentPort } from "../src/app/pdf-document-port.js";

const trace = { traceId: "pdf-port-selection-test" } as never;

async function withRuntime<T>(
  electronVersion: string | undefined,
  runAsNode: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previousElectron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  if (electronVersion === undefined) {
    Reflect.deleteProperty(process.versions, "electron");
  } else {
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      value: electronVersion,
    });
  }
  if (runAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = runAsNode;
  try {
    return await run();
  } finally {
    if (previousElectron) Object.defineProperty(process.versions, "electron", previousElectron);
    else Reflect.deleteProperty(process.versions, "electron");
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
  }
}

test("Electron Node selects bundled PDF.js after its launch environment is sanitized", async () => {
  const executionPort = {
    run: async () => {
      throw new Error("Unexpected Poppler execution");
    },
  } as unknown as ExecutionPort;
  const filePath = join(tmpdir(), `zcode-missing-pdf-${randomUUID()}.pdf`);

  await withRuntime("38.0.0", undefined, async () => {
    const port = resolvePdfDocumentPort({ executionPort });
    await assert.rejects(port.getPageCount({ filePath, trace }), { code: "io_error" });
  });
});

test("normal Node keeps Poppler even if a launch-only Electron flag is present", async () => {
  const commands: string[] = [];
  const executionPort = {
    run: async (request: { command: { file: string } }) => {
      commands.push(request.command.file);
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "Pages: 4\n" },
        stderr: { text: "" },
      };
    },
  } as unknown as ExecutionPort;

  await withRuntime(undefined, "1", async () => {
    const port = resolvePdfDocumentPort({ executionPort });
    assert.equal(await port.getPageCount({ filePath: "/sample.pdf", trace }), 4);
    assert.deepEqual(commands, ["pdfinfo"]);
  });
});

test("an explicit PDF port overrides either runtime default", async () => {
  const explicitPort: PdfDocumentPort = {
    getPageCount: async () => 9,
    renderPages: async () => [],
  };
  const executionPort = {
    run: async () => {
      throw new Error("Unexpected default PDF adapter use");
    },
  } as unknown as ExecutionPort;

  await withRuntime("38.0.0", undefined, async () => {
    const port = resolvePdfDocumentPort({ executionPort, explicitPort });
    assert.strictEqual(port, explicitPort);
    assert.equal(await port.getPageCount({ filePath: "/sample.pdf", trace }), 9);
  });
});
