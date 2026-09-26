// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

const CANVAS_PLATFORM_PACKAGE = {
  "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
  "darwin-x64": "@napi-rs/canvas-darwin-x64",
  "linux-arm64": "@napi-rs/canvas-linux-arm64-gnu",
  "linux-x64": "@napi-rs/canvas-linux-x64-gnu",
  "win32-arm64": "@napi-rs/canvas-win32-arm64-msvc",
  "win32-x64": "@napi-rs/canvas-win32-x64-msvc",
};

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const canvasPlatformPackage = CANVAS_PLATFORM_PACKAGE[platformKey];
  if (!canvasPlatformPackage) {
    throw new Error(`[stage:agent-bundle] unsupported Canvas platform: ${platformKey}`);
  }
  // 根因：Agent 在 resources/glm 独立运行，app.asar 中的 renderer 依赖无法从这里解析。
  // PDF.js Node 渲染需要 Canvas native，只暂存当前目标平台，避免带入其他架构二进制。
  for (const moduleName of ["pdfjs-dist", "@napi-rs/canvas", canvasPlatformPackage]) {
    const source = resolve(repoRoot, "node_modules", moduleName);
    const target = resolve(glmDir, "node_modules", moduleName);
    if (!existsSync(source)) {
      throw new Error(`[stage:agent-bundle] missing PDF renderer dependency: ${source}`);
    }
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true });
  }
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
