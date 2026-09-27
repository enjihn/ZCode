import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const nodeRequire = createRequire(import.meta.url);
// tsup preserves the node: specifier for this built-in only through createRequire.
const { DatabaseSync, backup } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

const MANIFEST_VERSION = 1;
const WORKSPACE_NAME = "hyperresearch-zcode-smoke";
const SOURCE_NAME = "hyperresearch-zcode";
const MARKER_NAME = ".zcode-transfer-hyperresearch.json";
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const HEX_COMMIT = /^[a-f0-9]{40}$/u;

interface HyperResearchManifest {
  version: 1;
  branch: string;
  commit: string;
  bundleSha256: string;
  workspaceName: typeof WORKSPACE_NAME;
}

interface StageOptions {
  sourceRepoPath: string;
  workspacePath: string;
  payloadDir: string;
}

interface RestoreOptions {
  payloadDir: string;
  userHome: string;
}

export interface HyperResearchRestoreResult {
  sourcePath: string;
  workspacePath: string;
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFile(file, args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyPortableTree(source: string, target: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new Error("HyperResearch workspace contains a symlink");
  if (sourceInfo.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    return;
  }
  if (!sourceInfo.isDirectory())
    throw new Error("HyperResearch workspace contains an unsupported file");
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source)) {
    await copyPortableTree(join(source, name), join(target, name));
  }
}

async function snapshotVaultDatabase(source: string, destination: string): Promise<void> {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
}

function parseManifest(raw: string): HyperResearchManifest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid HyperResearch manifest");
  const manifest = value as Record<string, unknown>;
  if (
    manifest.version !== MANIFEST_VERSION ||
    typeof manifest.branch !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(manifest.branch) ||
    manifest.branch.includes("..") ||
    typeof manifest.commit !== "string" ||
    !HEX_COMMIT.test(manifest.commit) ||
    typeof manifest.bundleSha256 !== "string" ||
    !HEX_SHA256.test(manifest.bundleSha256) ||
    manifest.workspaceName !== WORKSPACE_NAME
  ) {
    throw new Error("Unsupported HyperResearch payload manifest");
  }
  return manifest as unknown as HyperResearchManifest;
}

/** Stage the clean, exact source commit and portable vault data for the encrypted archive. */
export async function stageHyperResearchPayload(options: StageOptions): Promise<string> {
  const { sourceRepoPath, workspacePath, payloadDir } = options;
  const status = await run("git", [
    "-C",
    sourceRepoPath,
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  if (status) throw new Error("HyperResearch source must be a clean Git checkout");
  const branch = await run("git", ["-C", sourceRepoPath, "symbolic-ref", "--short", "HEAD"]);
  const commit = await run("git", ["-C", sourceRepoPath, "rev-parse", "HEAD"]);
  if (!HEX_COMMIT.test(commit)) throw new Error("HyperResearch source HEAD is invalid");
  const destination = join(payloadDir, "hyperresearch");
  await mkdir(payloadDir, { recursive: true });
  await mkdir(destination);
  const bundlePath = join(destination, "source.bundle");
  await run("git", ["-C", sourceRepoPath, "bundle", "create", bundlePath, branch]);
  await run("git", ["-C", sourceRepoPath, "bundle", "verify", bundlePath]);

  const portableWorkspace = join(destination, "workspace");
  await copyPortableTree(join(workspacePath, "research"), join(portableWorkspace, "research"));
  await copyPortableTree(
    join(workspacePath, ".hyperresearch", "config.toml"),
    join(portableWorkspace, ".hyperresearch", "config.toml"),
  );
  const templates = join(workspacePath, ".hyperresearch", "templates");
  if (await exists(templates)) {
    await copyPortableTree(templates, join(portableWorkspace, ".hyperresearch", "templates"));
  }
  await snapshotVaultDatabase(
    join(workspacePath, ".hyperresearch", "hyperresearch.db"),
    join(portableWorkspace, ".hyperresearch", "hyperresearch.db"),
  );
  const manifest: HyperResearchManifest = {
    version: MANIFEST_VERSION,
    branch,
    commit,
    bundleSha256: await sha256(bundlePath),
    workspaceName: WORKSPACE_NAME,
  };
  await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return destination;
}

function quotedWindowsExecutable(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (/[\r\n"%]/u.test(normalized)) throw new Error("Unsupported HyperResearch executable path");
  return `"${normalized}"`;
}

export function createWindowsStopHookCommand(executablePath: string): string {
  return `set HYPERRESEARCH_PLATFORM=zcode&& ${quotedWindowsExecutable(executablePath)} run stop-gate`;
}

/** The upstream generated POSIX environment assignment does not execute under Windows cmd. */
export async function rewriteWindowsStopHook(
  configPath: string,
  executablePath: string,
): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    hooks?: {
      events?: Record<
        string,
        Array<{ hooks?: Array<{ type?: string; command?: string; shell?: string }> }>
      >;
    };
  };
  const events = config.hooks?.events;
  if (!events?.Stop || !events.PostToolUse) {
    throw new Error("HyperResearch workspace hooks were not generated");
  }
  let stopCount = 0;
  let claimCount = 0;
  for (const entry of events.Stop) {
    for (const hook of entry.hooks ?? []) {
      if (
        hook.type === "command" &&
        hook.command?.includes("HYPERRESEARCH_PLATFORM=zcode") &&
        hook.command.includes("run stop-gate")
      ) {
        hook.command = createWindowsStopHookCommand(executablePath);
        hook.shell = "cmd.exe";
        stopCount += 1;
      }
    }
  }
  for (const entry of events.PostToolUse) {
    for (const hook of entry.hooks ?? []) {
      if (hook.type === "command" && hook.command?.includes("run zcode-claim")) {
        hook.command = `${quotedWindowsExecutable(executablePath)} run zcode-claim`;
        hook.shell = "cmd.exe";
        claimCount += 1;
      }
    }
  }
  if (stopCount !== 1 || claimCount !== 1) {
    throw new Error("HyperResearch workspace hook configuration is ambiguous");
  }
  const nextPath = `${configPath}.zcode-transfer-next`;
  try {
    await writeFile(nextPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(nextPath, configPath);
  } finally {
    await rm(nextPath, { force: true });
  }
}

async function requireTool(file: string, installUrl: string): Promise<void> {
  try {
    await run(file, ["--version"]);
  } catch {
    throw new Error(
      `${file} is required to finish HyperResearch setup. Install it from ${installUrl}, restart ZCode, and retry setup.`,
    );
  }
}

export async function quoteGeneratedWindowsHyperResearchCommands(
  root: string,
  executablePath: string,
): Promise<void> {
  const bare = executablePath.replaceAll("\\", "/");
  if (!/\s/u.test(bare)) return;
  const quoted = quotedWindowsExecutable(executablePath);
  const candidates = [
    join(root, "AGENTS.md"),
    join(root, ".zcode", "skills", "hyperresearch", "SKILL.md"),
  ];
  for (const directory of [
    join(root, ".zcode", "agents"),
    join(root, ".hyperresearch", "zcode", "steps"),
  ]) {
    if (!(await exists(directory))) continue;
    for (const name of await readdir(directory)) {
      if (name.startsWith("hyperresearch-") && name.endsWith(".md")) {
        candidates.push(join(directory, name));
      }
    }
  }
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    const content = await readFile(path, "utf8");
    // The HyperResearch renderer emits an unquoted executable in its Markdown commands.
    let rewritten = "";
    let cursor = 0;
    for (
      let index = content.indexOf(bare, cursor);
      index !== -1;
      index = content.indexOf(bare, cursor)
    ) {
      rewritten += content.slice(cursor, index);
      const alreadyQuoted = content[index - 1] === '"' && content[index + bare.length] === '"';
      rewritten += alreadyQuoted ? bare : quoted;
      cursor = index + bare.length;
    }
    rewritten += content.slice(cursor);
    if (rewritten !== content) await writeFile(path, rewritten, "utf8");
  }
}

async function ensureSource(
  sourcePath: string,
  bundlePath: string,
  manifest: HyperResearchManifest,
): Promise<void> {
  const marker = join(sourcePath, ".git", MARKER_NAME);
  if (await exists(sourcePath)) {
    if (!(await exists(marker)))
      throw new Error(`Existing HyperResearch source is not from this transfer: ${sourcePath}`);
    const saved = parseManifest(await readFile(marker, "utf8"));
    if (saved.commit !== manifest.commit || saved.bundleSha256 !== manifest.bundleSha256) {
      throw new Error(`Existing HyperResearch source belongs to another transfer: ${sourcePath}`);
    }
  } else {
    const temp = await mkdtemp(join(dirname(sourcePath), ".hyperresearch-source-"));
    try {
      await run("git", ["clone", "--branch", manifest.branch, bundlePath, temp]);
      await writeFile(join(temp, ".git", MARKER_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      await run("git", [
        "-C",
        temp,
        "remote",
        "set-url",
        "origin",
        "https://github.com/jordan-gibbs/hyperresearch.git",
      ]);
      await rename(temp, sourcePath);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const head = await run("git", ["-C", sourcePath, "rev-parse", "HEAD"]);
  if (head !== manifest.commit)
    throw new Error("Restored HyperResearch source commit does not match payload");
}

async function ensureWorkspace(
  workspacePath: string,
  payloadWorkspacePath: string,
  manifest: HyperResearchManifest,
): Promise<void> {
  const marker = join(workspacePath, MARKER_NAME);
  if (await exists(workspacePath)) {
    if (!(await exists(marker)))
      throw new Error(
        `Existing HyperResearch workspace is not from this transfer: ${workspacePath}`,
      );
    const saved = parseManifest(await readFile(marker, "utf8"));
    if (saved.commit !== manifest.commit || saved.bundleSha256 !== manifest.bundleSha256) {
      throw new Error(
        `Existing HyperResearch workspace belongs to another transfer: ${workspacePath}`,
      );
    }
    return;
  }
  const temp = await mkdtemp(join(dirname(workspacePath), ".hyperresearch-workspace-"));
  try {
    await copyPortableTree(payloadWorkspacePath, temp);
    await writeFile(join(temp, MARKER_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temp, workspacePath);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** Retryable Windows setup after the profile import has committed. */
export async function restoreHyperResearchPayload(
  options: RestoreOptions,
): Promise<HyperResearchRestoreResult> {
  if (process.platform !== "win32") throw new Error("HyperResearch restore must run on Windows");
  const { payloadDir, userHome } = options;
  const manifest = parseManifest(await readFile(join(payloadDir, "manifest.json"), "utf8"));
  const bundlePath = join(payloadDir, "source.bundle");
  if ((await sha256(bundlePath)) !== manifest.bundleSha256) {
    throw new Error("HyperResearch source bundle checksum failed");
  }
  await requireTool("git", "https://git-scm.com/install/windows");
  await requireTool("uv", "https://docs.astral.sh/uv/getting-started/installation/");
  const projects = join(userHome, "Projects");
  await mkdir(projects, { recursive: true });
  const sourcePath = join(projects, SOURCE_NAME);
  const workspacePath = join(projects, WORKSPACE_NAME);
  await ensureSource(sourcePath, bundlePath, manifest);
  await ensureWorkspace(workspacePath, join(payloadDir, "workspace"), manifest);

  await run("uv", ["python", "install", "3.12"], sourcePath);
  await run(
    "uv",
    ["sync", "--locked", "--python", "3.12", "--extra", "mcp", "--extra", "crawl4ai"],
    sourcePath,
  );
  const python = join(sourcePath, ".venv", "Scripts", "python.exe");
  const hpr = join(sourcePath, ".venv", "Scripts", "hyperresearch.exe");
  if (!(await exists(python)) || !(await exists(hpr))) {
    throw new Error("HyperResearch Windows virtual environment is incomplete; retry setup");
  }
  // Crawl4AI prefers patchright when installed; each browser package has its own Chromium registry.
  await run(python, ["-m", "patchright", "install", "chromium"], sourcePath);
  await run(python, ["-m", "playwright", "install", "chromium"], sourcePath);
  await run(hpr, ["install", "--global", "--target", "zcode", "--json"], sourcePath);
  await run(hpr, ["install", workspacePath, "--target", "zcode", "--json"], sourcePath);
  await rewriteWindowsStopHook(join(workspacePath, ".zcode", "config.json"), hpr);
  await quoteGeneratedWindowsHyperResearchCommands(userHome, hpr);
  await quoteGeneratedWindowsHyperResearchCommands(workspacePath, hpr);

  const globalAgents = (await readdir(join(userHome, ".zcode", "agents"))).filter((name) =>
    /^hyperresearch-.*\.md$/u.test(name),
  );
  if (
    globalAgents.length !== 15 ||
    !(await exists(join(userHome, ".zcode", "skills", "hyperresearch", "SKILL.md")))
  ) {
    throw new Error("HyperResearch global skill and 15 agents were not generated; retry setup");
  }
  return { sourcePath, workspacePath };
}
