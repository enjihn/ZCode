import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { importZCodeTransfer, ZCodeTransferError } from "../src/main/profileTransfer.js";
import { writeEncryptedTransfer } from "../src/main/profileTransferArchive.js";

const PASSPHRASE = "windows integration fixture passphrase";
const MAC_PROFILE = "/Users/transfer-fixture/.zcode";
const MAC_DEFAULT_WORKSPACE = `${MAC_PROFILE}/workspace/default`;
const MAC_DEFAULT_MEMORY = `default-${createHash("sha256").update(MAC_DEFAULT_WORKSPACE).digest("hex").slice(0, 16)}`;
const MAC_RESEARCH_WORKSPACE = "/Users/transfer-fixture/Projects/hyperresearch-zcode-smoke";
const MAC_TEMP_WORKSPACE = "/tmp/zcode-web-replay-smoke/workspace";

async function createChatDatabase(path: string): Promise<void> {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, directory TEXT, path TEXT);
      CREATE TABLE permission (project_id TEXT PRIMARY KEY);
      CREATE TABLE input_history (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE local_setting (scope TEXT, scope_id TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE session_entry (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE workflow_run (cwd TEXT);
      CREATE TABLE dwf_run (cwd TEXT);
      CREATE TABLE workflow_definition (script_path TEXT);
    `);
    const insert = database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)");
    insert.run("default-chat", "old-default", null, MAC_DEFAULT_WORKSPACE, MAC_DEFAULT_WORKSPACE);
    insert.run(
      "research-chat",
      "old-research",
      null,
      MAC_RESEARCH_WORKSPACE,
      MAC_RESEARCH_WORKSPACE,
    );
    insert.run("temp-chat", "old-temp", null, MAC_TEMP_WORKSPACE, MAC_TEMP_WORKSPACE);
    database
      .prepare("INSERT INTO message VALUES (?, ?)")
      .run("historical", JSON.stringify({ text: `Historical path: ${MAC_DEFAULT_WORKSPACE}` }));
  } finally {
    database.close();
  }
}

async function createTaskDatabase(path: string): Promise<void> {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, task_id TEXT, meta_json TEXT,
        PRIMARY KEY (workspace_key, task_id));
      CREATE TABLE task_group_members (workspace_key TEXT, workspace_path TEXT);
      CREATE TABLE task_group_workspace_bootstraps (workspace_key TEXT);
      CREATE TABLE automations (workspace_key TEXT, workspace_path TEXT);
      CREATE TABLE automation_runs (workspace_key TEXT);
      CREATE TABLE off_peak_tasks (workspace_key TEXT, workspace_path TEXT);
    `);
    database
      .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?)")
      .run(
        MAC_DEFAULT_WORKSPACE,
        MAC_DEFAULT_WORKSPACE,
        "default-chat",
        JSON.stringify({ workspacePath: MAC_DEFAULT_WORKSPACE }),
      );
  } finally {
    database.close();
  }
}

test(
  "Windows imports a Mac-format archive, remaps active paths, and preserves its profile on wrong passphrase",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-win-import-"));
    const targetHomeDir = join(root, "windows-home");
    const targetProfileDir = join(targetHomeDir, ".zcode");
    const targetResearchWorkspace = join(targetHomeDir, "Projects", "hyperresearch-zcode-smoke");
    const archivePath = join(root, "synthetic-mac.zcode-transfer");
    const chatDatabasePath = join(root, "chat.sqlite");
    const taskDatabasePath = join(root, "tasks.sqlite");
    try {
      await createChatDatabase(chatDatabasePath);
      await createTaskDatabase(taskDatabasePath);
      const providerConfig = {
        schemaVersion: 1,
        config: {
          defaultModelSelection: { providerId: "local", modelId: "glm-5.3-flash" },
          providerConfigRules: {
            providerRules: [
              { providerId: "local", config: { access: { apiKey: "fixture-only-key" } } },
              {
                providerId: "hyperresearch-local",
                config: { access: { apiKey: "fixture-only-key" } },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "local",
                modelId: "glm-5.3-flash",
                config: {
                  properties: {
                    contextWindow: 1_048_576,
                    pdfInputMode: "rendered-pages",
                    inputFormat: { supportsImage: true, supportsVideo: true, supportsPdf: true },
                  },
                  optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } },
                },
              },
            ],
            manualProviderModelRules: [],
          },
        },
      };
      await writeEncryptedTransfer(archivePath, PASSPHRASE, [
        {
          archivePath: "manifest.json",
          contents: Buffer.from(
            JSON.stringify({
              formatVersion: 1,
              sourceProfileDir: MAC_PROFILE,
              sourceWorkspaceDir: MAC_RESEARCH_WORKSPACE,
              mediaPaths: {},
              createdAt: new Date().toISOString(),
            }),
          ),
        },
        {
          archivePath: "profile/v2/setting.json",
          contents: Buffer.from(
            JSON.stringify({
              recentProjects: [MAC_RESEARCH_WORKSPACE, MAC_TEMP_WORKSPACE],
              lastWorkspaceSession: [{ kind: "local", workspacePath: MAC_DEFAULT_WORKSPACE }],
            }),
          ),
        },
        {
          archivePath: "profile/v2/provider_config.json",
          contents: Buffer.from(JSON.stringify(providerConfig)),
        },
        { archivePath: "profile/v2/tasks-index.sqlite", absolutePath: taskDatabasePath },
        { archivePath: "profile/cli/db/db.sqlite", absolutePath: chatDatabasePath },
        {
          archivePath: `profile/cli/memories/projects/${MAC_DEFAULT_MEMORY}/memory/MEMORY.md`,
          contents: Buffer.from("Transferred project memory"),
        },
        {
          archivePath: "hyperresearch/workspace/notes.md",
          contents: Buffer.from("Research notes"),
        },
      ]);

      await mkdir(targetProfileDir, { recursive: true });
      await writeFile(join(targetProfileDir, "previous.txt"), "previous Windows profile");
      await assert.rejects(
        importZCodeTransfer({
          archivePath,
          passphrase: "incorrect fixture passphrase",
          targetProfileDir,
          targetHomeDir,
          targetWorkspaceDir: targetResearchWorkspace,
        }),
        (error: unknown) =>
          error instanceof ZCodeTransferError && error.code === "authentication_failed",
      );
      assert.equal(
        await readFile(join(targetProfileDir, "previous.txt"), "utf8"),
        "previous Windows profile",
      );
      assert.deepEqual(
        (await readdir(targetHomeDir)).filter((name) => name.startsWith(".zcode.backup-")),
        [],
      );

      const imported = await importZCodeTransfer({
        archivePath,
        passphrase: PASSPHRASE,
        targetProfileDir,
        targetHomeDir,
        targetWorkspaceDir: targetResearchWorkspace,
      });
      assert.equal(imported.sessionCount, 3);
      const windowsDefaultWorkspace = join(targetProfileDir, "workspace", "default");
      const windowsDefaultMemory = `default-${createHash("sha256").update(windowsDefaultWorkspace.toLowerCase()).digest("hex").slice(0, 16)}`;
      assert.equal(
        await readFile(
          join(
            targetProfileDir,
            "cli",
            "memories",
            "projects",
            windowsDefaultMemory,
            "memory",
            "MEMORY.md",
          ),
          "utf8",
        ),
        "Transferred project memory",
      );
      assert.equal(
        await readFile(join(imported.backupDir!, "previous.txt"), "utf8"),
        "previous Windows profile",
      );
      assert.equal(
        await readFile(join(imported.importedPayloadDir!, "workspace", "notes.md"), "utf8"),
        "Research notes",
      );
      const provider = JSON.parse(
        await readFile(join(targetProfileDir, "v2", "provider_config.json"), "utf8"),
      ) as typeof providerConfig;
      assert.deepEqual(provider, providerConfig);
      assert.equal(provider.config.defaultModelSelection.providerId, "local");
      assert.equal(
        provider.config.modelConfigRules.providerModelRules[0]?.config.properties.contextWindow,
        1_048_576,
      );
      assert.equal(
        "maxOutputTokens" in
          provider.config.modelConfigRules.providerModelRules[0]!.config.properties,
        false,
      );

      const chat = new DatabaseSync(join(targetProfileDir, "cli", "db", "db.sqlite"), {
        readOnly: true,
      });
      try {
        const sessions = chat
          .prepare("SELECT id, directory, path FROM session ORDER BY id")
          .all() as Array<{ id: string; directory: string; path: string }>;
        assert.deepEqual(
          sessions.map((row) => row.id),
          ["default-chat", "research-chat", "temp-chat"],
        );
        assert.equal(sessions[0]?.directory, join(targetProfileDir, "workspace", "default"));
        assert.equal(sessions[1]?.directory, targetResearchWorkspace);
        assert.ok(
          sessions[2]?.directory.startsWith(join(targetProfileDir, "workspace", "imported-mac")),
        );
        assert.ok(sessions.every((row) => row.path === row.directory));
        const historical = chat
          .prepare("SELECT data FROM message WHERE id = 'historical'")
          .get() as {
          data: string;
        };
        assert.match(historical.data, /\/Users\/transfer-fixture\/\.zcode/);
      } finally {
        chat.close();
      }
      const tasks = new DatabaseSync(join(targetProfileDir, "v2", "tasks-index.sqlite"), {
        readOnly: true,
      });
      try {
        const task = tasks
          .prepare("SELECT workspace_key, workspace_path, meta_json FROM tasks")
          .get() as {
          workspace_key: string;
          workspace_path: string;
          meta_json: string;
        };
        const expectedDefault = join(targetProfileDir, "workspace", "default");
        assert.equal(task.workspace_key, expectedDefault);
        assert.equal(task.workspace_path, expectedDefault);
        assert.equal(JSON.parse(task.meta_json).workspacePath, expectedDefault);
      } finally {
        tasks.close();
      }
      const settings = JSON.parse(
        await readFile(join(targetProfileDir, "v2", "setting.json"), "utf8"),
      );
      assert.equal(settings.recentProjects[0], targetResearchWorkspace);
      assert.ok(
        settings.recentProjects[1].startsWith(join(targetProfileDir, "workspace", "imported-mac")),
      );
      assert.equal(
        settings.lastWorkspaceSession[0].workspacePath,
        join(targetProfileDir, "workspace", "default"),
      );
      assert.equal((await stat(imported.importedTemporaryWorkspaceDir!)).isDirectory(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
