import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

test("staged desktop Agent includes PDF.js and only its target Canvas binary", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "zcode-agent-stage-test-"));
  const files = [
    ["apps/zcode-cli/packages/cli/dist/zcode.cjs", "agent"],
    ["node_modules/pdfjs-dist/package.json", "pdfjs"],
    ["node_modules/pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-code"],
    ["node_modules/@napi-rs/canvas/index.js", "canvas"],
    ["node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node", "arm64"],
    ["node_modules/@napi-rs/canvas-darwin-x64/skia.darwin-x64.node", "x64"],
  ];
  try {
    for (const [path, content] of files) {
      const target = join(repoRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    stageAgentBundle({ repoRoot, platformKey: "darwin-arm64", log: () => {} });
    const glmDir = join(repoRoot, "packages/desktop/bundled-agents/darwin-arm64/glm");
    assert.equal(
      await readFile(join(glmDir, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"), "utf8"),
      "pdfjs-code",
    );
    assert.equal(
      await readFile(
        join(glmDir, "node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node"),
        "utf8",
      ),
      "arm64",
    );
    await assert.rejects(
      readFile(join(glmDir, "node_modules/@napi-rs/canvas-darwin-x64/skia.darwin-x64.node")),
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
