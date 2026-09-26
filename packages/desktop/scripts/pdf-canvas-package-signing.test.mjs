import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { signPackagedPdfCanvasBinary } from "./pdf-canvas-package-signing.mjs";

test(
  "signs the packaged arm64 Canvas addon inside the Agent resources",
  { skip: process.platform !== "darwin" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-pdf-canvas-sign-test-"));
    const resourcesDir = join(directory, "Contents/Resources");
    const addon = join(
      resourcesDir,
      "glm/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
    );
    try {
      await mkdir(dirname(addon), { recursive: true });
      await copyFile(
        join(process.cwd(), "node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node"),
        addon,
      );
      signPackagedPdfCanvasBinary({
        resourcesDir,
        platformKey: "darwin-arm64",
        signingIdentity: "-",
      });
      const verification = spawnSync("codesign", ["--verify", "--strict", addon], {
        encoding: "utf8",
      });
      assert.equal(verification.status, 0, verification.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
