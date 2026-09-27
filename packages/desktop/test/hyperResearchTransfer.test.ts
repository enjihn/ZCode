import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createWindowsStopHookCommand,
  quoteGeneratedWindowsHyperResearchCommands,
  rewriteWindowsStopHook,
  stageHyperResearchPayload,
} from "../src/main/hyperResearchTransfer.js";

const execFile = promisify(execFileCallback);

test("stages the exact clean source commit and only portable workspace data", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-hyperresearch-transfer-"));
  try {
    const sourceRepoPath = join(root, "source");
    const workspacePath = join(root, "workspace");
    const payloadDir = join(root, "payload");
    await mkdir(sourceRepoPath);
    await mkdir(join(workspacePath, "research"), { recursive: true });
    await mkdir(join(workspacePath, ".hyperresearch", "templates"), { recursive: true });
    await mkdir(join(workspacePath, ".zcode", "agents"), { recursive: true });
    await writeFile(join(sourceRepoPath, "pyproject.toml"), "[project]\nname='hyperresearch'\n");
    await writeFile(join(sourceRepoPath, "uv.lock"), "locked\n");
    await writeFile(join(workspacePath, "research", "note.md"), "portable note\n");
    await writeFile(join(workspacePath, ".hyperresearch", "config.toml"), "[vault]\n");
    const vaultDatabase = new DatabaseSync(
      join(workspacePath, ".hyperresearch", "hyperresearch.db"),
    );
    vaultDatabase.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('fixture note')");
    vaultDatabase.close();
    await writeFile(join(workspacePath, ".hyperresearch", "templates", "note.md"), "template\n");
    await writeFile(
      join(workspacePath, ".zcode", "agents", "mac.md"),
      "/Users/mac/.venv/bin/hyperresearch\n",
    );
    await execFile("git", ["init", "-b", "feature/zcode-local-glm", sourceRepoPath]);
    await execFile("git", ["-C", sourceRepoPath, "add", "."]);
    await execFile("git", [
      "-C",
      sourceRepoPath,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const { stdout: expectedHead } = await execFile("git", [
      "-C",
      sourceRepoPath,
      "rev-parse",
      "HEAD",
    ]);

    const result = await stageHyperResearchPayload({ sourceRepoPath, workspacePath, payloadDir });
    const manifest = JSON.parse(await readFile(join(result, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.commit, expectedHead.trim());
    assert.equal(manifest.branch, "feature/zcode-local-glm");
    assert.equal(manifest.workspaceName, "hyperresearch-zcode-smoke");
    assert.equal(
      await readFile(join(result, "workspace", "research", "note.md"), "utf8"),
      "portable note\n",
    );
    assert.deepEqual(await readdir(join(result, "workspace")), [".hyperresearch", "research"]);
    assert.equal(
      await readFile(join(result, "workspace", ".hyperresearch", "templates", "note.md"), "utf8"),
      "template\n",
    );
    const bundle = await readFile(join(result, "source.bundle"));
    assert.equal(manifest.bundleSha256, createHash("sha256").update(bundle).digest("hex"));
    await execFile("git", ["bundle", "verify", join(result, "source.bundle")]);
    const cloned = join(root, "cloned");
    await execFile("git", [
      "clone",
      "--branch",
      manifest.branch,
      join(result, "source.bundle"),
      cloned,
    ]);
    const { stdout: cloneHead } = await execFile("git", ["-C", cloned, "rev-parse", "HEAD"]);
    assert.equal(cloneHead.trim(), expectedHead.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quotes Windows executable paths with spaces in generated research instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-hyperresearch-spaces-"));
  try {
    const skill = join(root, ".zcode", "skills", "hyperresearch", "SKILL.md");
    await mkdir(join(root, ".zcode", "skills", "hyperresearch"), { recursive: true });
    const bare = "C:/Users/Eric Smith/Projects/hyperresearch-zcode/.venv/Scripts/hyperresearch.exe";
    await writeFile(skill, `Run ${bare} run resume --json\n`);
    await quoteGeneratedWindowsHyperResearchCommands(root, bare.replaceAll("/", "\\"));
    await quoteGeneratedWindowsHyperResearchCommands(root, bare.replaceAll("/", "\\"));
    assert.equal(await readFile(skill, "utf8"), `Run "${bare}" run resume --json\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a dirty source rather than omitting local work", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-hyperresearch-dirty-"));
  try {
    const sourceRepoPath = join(root, "source");
    await mkdir(sourceRepoPath);
    await execFile("git", ["init", "-b", "feature/zcode-local-glm", sourceRepoPath]);
    await writeFile(join(sourceRepoPath, "uv.lock"), "uncommitted\n");
    await assert.rejects(
      stageHyperResearchPayload({
        sourceRepoPath,
        workspacePath: join(root, "workspace"),
        payloadDir: join(root, "payload"),
      }),
      /clean Git checkout/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rewrites generated Stop hook for Windows cmd without changing other hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-hyperresearch-hook-"));
  try {
    const configPath = join(root, ".zcode", "config.json");
    await mkdir(join(root, ".zcode"));
    await writeFile(
      configPath,
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            Stop: [
              { hooks: [{ type: "command", command: "echo leave-me-alone" }] },
              {
                hooks: [
                  {
                    type: "command",
                    command: "HYPERRESEARCH_PLATFORM=zcode /Users/mac/hpr run stop-gate",
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "/Users/mac/hpr run zcode-claim" }],
              },
            ],
          },
        },
      }),
    );
    const exe = "C:\\Users\\Eric\\Projects\\hyperresearch-zcode\\.venv\\Scripts\\hyperresearch.exe";
    await rewriteWindowsStopHook(configPath, exe);
    const once = await readFile(configPath, "utf8");
    await rewriteWindowsStopHook(configPath, exe);
    assert.equal(await readFile(configPath, "utf8"), once);
    const parsed = JSON.parse(once);
    assert.equal(parsed.hooks.events.Stop[0].hooks[0].command, "echo leave-me-alone");
    assert.equal(parsed.hooks.events.Stop[1].hooks[0].command, createWindowsStopHookCommand(exe));
    assert.equal(parsed.hooks.events.Stop[1].hooks[0].shell, "cmd.exe");
    assert.equal(
      parsed.hooks.events.PostToolUse[0].hooks[0].command,
      '"C:/Users/Eric/Projects/hyperresearch-zcode/.venv/Scripts/hyperresearch.exe" run zcode-claim',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
