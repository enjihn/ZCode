import { stat } from "node:fs/promises";
import { join } from "node:path";

const WINDOWS_RESOURCES = Object.freeze([
  "glm/zcode.cjs",
  "glm/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "glm/node_modules/@napi-rs/canvas/package.json",
  "glm/packages/browser-use-plugin/.zcode-plugin/plugin.json",
  "glm/packages/browser-use-plugin/skills/control-browser/SKILL.md",
  "glm/packages/node-repl-host/dist/mcp/server.js",
  "glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md",
  "tools/ripgrep/rg.exe",
]);

export async function assertWindowsPackagedResources(resourcesDir, arch) {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`[bundle] unsupported Windows resource check architecture: ${arch}`);
  }

  const missing = [];
  const paths = [
    ...WINDOWS_RESOURCES,
    `glm/node_modules/@napi-rs/canvas-win32-${arch}-msvc/skia.win32-${arch}-msvc.node`,
  ];
  for (const relativePath of paths) {
    const resourcePath = join(resourcesDir, ...relativePath.split("/"));
    const resource = await stat(resourcePath).catch(() => null);
    if (!resource?.isFile() || resource.size === 0) {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[bundle] Windows installer is missing resources:\n- ${missing.join("\n- ")}`);
  }
}
