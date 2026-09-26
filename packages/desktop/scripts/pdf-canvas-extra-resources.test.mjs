import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import desktopConfig from "../electron-builder.config.js";

const require = createRequire(import.meta.url);
const { FileMatcher, copyFiles } = require("app-builder-lib/out/fileMatcher.js");

test("desktop extra resources copy PDF.js and target Canvas native from Agent node_modules", async () => {
  const resource = desktopConfig.extraResources.find((item) => item.to === "glm/node_modules");
  assert.ok(resource, "Agent node_modules must have its own extraResources matcher");
  const directory = await mkdtemp(join(tmpdir(), "zcode-pdf-extra-resources-test-"));
  const source = join(directory, resource.from);
  const target = join(directory, "out", resource.to);
  try {
    const files = [
      ["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs"],
      ["@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node", "canvas"],
      ["pdfjs-dist/legacy/build/pdf.mjs.map", "sourcemap"],
    ];
    for (const [relativePath, content] of files) {
      const path = join(source, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const matcher = new FileMatcher(source, target, (value) => value, resource.filter);
    await copyFiles([matcher]);
    assert.equal(await readFile(join(target, files[0][0]), "utf8"), "pdfjs");
    assert.equal(await readFile(join(target, files[1][0]), "utf8"), "canvas");
    await assert.rejects(readFile(join(target, files[2][0])));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
