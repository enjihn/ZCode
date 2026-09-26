import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runCommand } from "../../../scripts/spawn-command.mjs";

export function signPackagedPdfCanvasBinary({ resourcesDir, platformKey, signingIdentity }) {
  if (platformKey !== "darwin-arm64" && platformKey !== "darwin-x64") {
    throw new Error(`Unsupported macOS Canvas target: ${platformKey}`);
  }
  const arch = platformKey.slice("darwin-".length);
  const addonPath = resolve(
    resourcesDir,
    "glm",
    "node_modules",
    "@napi-rs",
    `canvas-darwin-${arch}`,
    `skia.darwin-${arch}.node`,
  );
  if (!existsSync(addonPath)) {
    throw new Error(`Packaged PDF Canvas addon is missing: ${addonPath}`);
  }
  const signArgs = ["--force", "--sign", signingIdentity, "--options", "runtime"];
  if (signingIdentity !== "-") signArgs.push("--timestamp");
  runCommand("codesign", [...signArgs, addonPath], { cwd: resourcesDir, env: process.env });
  runCommand("codesign", ["--verify", "--strict", addonPath], {
    cwd: resourcesDir,
    env: process.env,
  });
  return addonPath;
}
