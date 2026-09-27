import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertWindowsPackagedResources } from "./windows-packaged-resources.mjs";

test("Windows package check requires PDF, native Canvas, official plugins, skills, and tools", async () => {
  const resourcesDir = await mkdtemp(join(tmpdir(), "zcode-win-resources-"));
  const paths = [
    "glm/zcode.cjs",
    "glm/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "glm/node_modules/@napi-rs/canvas/package.json",
    "glm/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
    "glm/packages/browser-use-plugin/.zcode-plugin/plugin.json",
    "glm/packages/browser-use-plugin/skills/control-browser/SKILL.md",
    "glm/packages/node-repl-host/dist/mcp/server.js",
    "glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
    "tools/ripgrep/rg.exe",
  ];
  try {
    for (const relativePath of paths) {
      const filePath = join(resourcesDir, ...relativePath.split("/"));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "present");
    }
    await assertWindowsPackagedResources(resourcesDir, "x64");
    await rm(join(resourcesDir, "glm/node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    await assert.rejects(
      assertWindowsPackagedResources(resourcesDir, "x64"),
      /glm\/node_modules\/pdfjs-dist\/legacy\/build\/pdf\.mjs/,
    );
    await assert.rejects(
      assertWindowsPackagedResources(resourcesDir, "arm64"),
      /canvas-win32-arm64/,
    );
    await assert.rejects(assertWindowsPackagedResources(resourcesDir, "x86"), /architecture/);
  } finally {
    await rm(resourcesDir, { recursive: true, force: true });
  }
});
