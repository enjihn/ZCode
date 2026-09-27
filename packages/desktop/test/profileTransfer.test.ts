import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  exportZCodeTransfer,
  importZCodeTransfer,
  inspectZCodeTransfer,
  recoverInterruptedZCodeTransfer,
  ZCodeTransferError,
} from "../src/main/profileTransfer.js";
import { writeEncryptedTransfer } from "../src/main/profileTransferArchive.js";

const PASSPHRASE = "test passphrase with enough length";

function projectMemoryName(directory: string): string {
  const normalized = resolve(directory);
  const slug = basename(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return `${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

async function fixture() {
  const root = await mkdtemp(join("/tmp", "zcode-transfer-test-"));
  const sourceHomeDir = join(root, "mac-user");
  const sourceProfileDir = join(sourceHomeDir, ".zcode");
  const sourceWorkspaceDir = join(sourceHomeDir, "Projects", "hyperresearch-zcode-smoke");
  const oldTempWorkspace = "/tmp/zcode-web-replay-smoke/workspace";
  const targetHomeDir = join(root, "windows-user");
  const targetProfileDir = join(targetHomeDir, ".zcode");
  const targetWorkspaceDir = join(targetHomeDir, "Projects", "hyperresearch-zcode-smoke");
  const archivePath = join(root, "private.zcode-transfer");
  await mkdir(join(sourceProfileDir, "v2"), { recursive: true });
  await mkdir(join(sourceProfileDir, "cli", "db"), { recursive: true });
  await mkdir(join(sourceProfileDir, "cli", "artifacts", "sess-1"), { recursive: true });
  const defaultWorkspace = join(sourceProfileDir, "workspace", "default");
  const sourceMemoryName = projectMemoryName(defaultWorkspace);
  await mkdir(join(sourceProfileDir, "cli", "memories", "projects", sourceMemoryName, "memory"), {
    recursive: true,
  });
  await mkdir(join(sourceProfileDir, "workspace", "default"), { recursive: true });
  await mkdir(sourceWorkspaceDir, { recursive: true });
  await writeFile(
    join(sourceProfileDir, "v2", "setting.json"),
    JSON.stringify({
      recentProjects: [oldTempWorkspace],
      lastWorkspaceSession: [
        { kind: "local", workspacePath: join(sourceProfileDir, "workspace", "default") },
        { kind: "local", workspacePath: sourceWorkspaceDir },
      ],
    }),
  );
  await writeFile(
    join(sourceProfileDir, "v2", "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        defaultModelSelection: { providerId: "local", modelId: "glm-5.3-flash" },
        providerConfigRules: {
          providerRules: [
            { providerId: "local", config: { access: { apiKey: "fixture-private-key" } } },
            {
              providerId: "hyperresearch-local",
              config: { access: { apiKey: "fixture-private-key" } },
            },
          ],
        },
      },
    }),
  );
  await writeFile(join(sourceProfileDir, "cli", "artifacts", "sess-1", "image.txt"), "image-data");
  await writeFile(
    join(sourceProfileDir, "cli", "memories", "projects", sourceMemoryName, "memory", "MEMORY.md"),
    "Remember this",
  );
  const externalMedia = join(sourceHomeDir, "photo.jpg");
  await writeFile(externalMedia, "photo-bytes");
  const cli = new DatabaseSync(join(sourceProfileDir, "cli", "db", "db.sqlite"));
  cli.exec(`
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
  cli
    .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)")
    .run("sess-1", "proj_old_default", null, defaultWorkspace, defaultWorkspace);
  cli
    .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)")
    .run("sess-2", "proj_old_hyperresearch", null, sourceWorkspaceDir, sourceWorkspaceDir);
  cli
    .prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)")
    .run("sess-3", "proj_old_temp", null, oldTempWorkspace, oldTempWorkspace);
  cli.prepare("INSERT INTO permission VALUES (?)").run("proj_old_default");
  cli.prepare("INSERT INTO input_history VALUES (?, ?)").run("input-1", "proj_old_default");
  cli
    .prepare("INSERT INTO message VALUES (?, ?)")
    .run(
      "msg-1",
      JSON.stringify({ cwd: defaultWorkspace, text: "Historical prose stays unchanged" }),
    );
  cli.prepare("INSERT INTO part VALUES (?, ?)").run(
    "part-1",
    JSON.stringify({
      type: "file",
      source: { path: externalMedia, text: { value: externalMedia } },
      url: "zcode-artifact://sess-1/image",
    }),
  );
  cli
    .prepare("INSERT INTO part VALUES (?, ?)")
    .run("part-2", JSON.stringify({ type: "tool", state: { output: { path: defaultWorkspace } } }));
  cli.close();
  const tasks = new DatabaseSync(join(sourceProfileDir, "v2", "tasks-index.sqlite"));
  tasks.exec(`
    CREATE TABLE tasks (workspace_key TEXT, workspace_path TEXT, task_id TEXT, meta_json TEXT,
      PRIMARY KEY (workspace_key, task_id));
    CREATE TABLE task_group_members (workspace_key TEXT, workspace_path TEXT);
    CREATE TABLE task_group_workspace_bootstraps (workspace_key TEXT);
    CREATE TABLE automations (workspace_key TEXT, workspace_path TEXT);
    CREATE TABLE automation_runs (workspace_key TEXT);
    CREATE TABLE off_peak_tasks (workspace_key TEXT, workspace_path TEXT);
  `);
  tasks
    .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?)")
    .run(
      defaultWorkspace,
      defaultWorkspace,
      "sess-1",
      JSON.stringify({ workspacePath: defaultWorkspace, title: "Transferred chat" }),
    );
  tasks.close();
  const additionalPayloadDir = join(root, "hyperresearch-payload");
  await mkdir(join(additionalPayloadDir, "workspace"), { recursive: true });
  await writeFile(join(additionalPayloadDir, "source.bundle"), "git-bundle-fixture");
  await writeFile(join(additionalPayloadDir, "workspace", "notes.md"), "research notes");
  return {
    root,
    sourceHomeDir,
    sourceProfileDir,
    sourceWorkspaceDir,
    targetHomeDir,
    targetProfileDir,
    targetWorkspaceDir,
    archivePath,
    additionalPayloadDir,
    externalMedia,
  };
}

test("encrypted transfer preserves providers, chats, media, memories and remaps identities", async () => {
  const data = await fixture();
  try {
    const exported = await exportZCodeTransfer({ ...data, passphrase: PASSPHRASE });
    assert.ok(exported.fileCount >= 8);
    assert.equal(exported.missingExternalMediaCount, 0);
    const publicInfo = await inspectZCodeTransfer(data.archivePath);
    assert.equal(publicInfo.formatVersion, 1);
    const encryptedBytes = await readFile(data.archivePath);
    assert.equal(encryptedBytes.includes(Buffer.from("fixture-private-key")), false);
    await mkdir(data.targetProfileDir, { recursive: true });
    await writeFile(join(data.targetProfileDir, "existing.txt"), "old-profile");
    const imported = await importZCodeTransfer({
      archivePath: data.archivePath,
      passphrase: PASSPHRASE,
      targetProfileDir: data.targetProfileDir,
      targetHomeDir: data.targetHomeDir,
      targetWorkspaceDir: data.targetWorkspaceDir,
    });
    assert.equal(imported.sessionCount, 3);
    assert.equal(await readFile(join(imported.backupDir!, "existing.txt"), "utf8"), "old-profile");
    assert.equal(
      await readFile(join(imported.importedPayloadDir!, "source.bundle"), "utf8"),
      "git-bundle-fixture",
    );
    assert.equal(
      await readFile(
        join(data.targetProfileDir, "cli", "artifacts", "sess-1", "image.txt"),
        "utf8",
      ),
      "image-data",
    );
    assert.equal(
      await readFile(
        join(
          data.targetProfileDir,
          "cli",
          "memories",
          "projects",
          projectMemoryName(join(data.targetProfileDir, "workspace", "default")),
          "memory",
          "MEMORY.md",
        ),
        "utf8",
      ),
      "Remember this",
    );
    const provider = JSON.parse(
      await readFile(join(data.targetProfileDir, "v2", "provider_config.json"), "utf8"),
    );
    assert.equal(provider.config.defaultModelSelection.providerId, "local");
    assert.equal(provider.config.providerConfigRules.providerRules.length, 2);
    const cli = new DatabaseSync(join(data.targetProfileDir, "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    const sessions = cli
      .prepare("SELECT id, project_id, directory FROM session ORDER BY id")
      .all() as Array<{
      id: string;
      project_id: string;
      directory: string;
    }>;
    assert.deepEqual(
      sessions.map((row) => row.id),
      ["sess-1", "sess-2", "sess-3"],
    );
    assert.equal(sessions[0]?.directory, join(data.targetProfileDir, "workspace", "default"));
    assert.equal(sessions[1]?.directory, data.targetWorkspaceDir);
    assert.ok(sessions[2]?.directory.includes("imported-mac"));
    assert.ok(sessions.every((row) => !row.project_id.startsWith("proj_old_")));
    const part = JSON.parse(
      (cli.prepare("SELECT data FROM part WHERE id = 'part-1'").get() as { data: string }).data,
    );
    assert.ok(part.source.path.startsWith(join(data.targetProfileDir, "imported-media")));
    assert.equal(await readFile(part.source.path, "utf8"), "photo-bytes");
    assert.equal(part.source.text.value, data.externalMedia);
    const tool = JSON.parse(
      (cli.prepare("SELECT data FROM part WHERE id = 'part-2'").get() as { data: string }).data,
    );
    assert.equal(tool.state.output.path, join(data.sourceProfileDir, "workspace", "default"));
    cli.close();
    const tasks = new DatabaseSync(join(data.targetProfileDir, "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    const task = tasks.prepare("SELECT workspace_key, meta_json FROM tasks").get() as {
      workspace_key: string;
      meta_json: string;
    };
    assert.equal(task.workspace_key, join(data.targetProfileDir, "workspace", "default"));
    assert.equal(JSON.parse(task.meta_json).workspacePath, task.workspace_key);
    tasks.close();
    assert.equal((await stat(imported.importedTemporaryWorkspaceDir!)).isDirectory(), true);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("wrong passphrase and damaged ciphertext leave the target profile intact", async () => {
  const data = await fixture();
  try {
    await exportZCodeTransfer({ ...data, passphrase: PASSPHRASE });
    await mkdir(data.targetProfileDir, { recursive: true });
    await writeFile(join(data.targetProfileDir, "existing.txt"), "old-profile");
    await assert.rejects(
      importZCodeTransfer({ ...data, passphrase: "another long passphrase" }),
      (error: unknown) =>
        error instanceof ZCodeTransferError && error.code === "authentication_failed",
    );
    assert.equal(
      await readFile(join(data.targetProfileDir, "existing.txt"), "utf8"),
      "old-profile",
    );
    const archive = await readFile(data.archivePath);
    archive[archive.length - 1] ^= 0xff;
    await writeFile(data.archivePath, archive);
    await assert.rejects(
      importZCodeTransfer({ ...data, passphrase: PASSPHRASE }),
      (error: unknown) =>
        error instanceof ZCodeTransferError && error.code === "authentication_failed",
    );
    assert.equal(
      await readFile(join(data.targetProfileDir, "existing.txt"), "utf8"),
      "old-profile",
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("unsafe paths and occupied payload targets are rejected without replacing a profile", async () => {
  const data = await fixture();
  try {
    await assert.rejects(
      writeEncryptedTransfer(join(data.root, `${randomUUID()}.zcode-transfer`), PASSPHRASE, [
        { archivePath: "profile/../v2/credentials.json", contents: Buffer.from("bad") },
      ]),
      (error: unknown) => error instanceof ZCodeTransferError && error.code === "invalid_payload",
    );
    await assert.rejects(
      writeEncryptedTransfer(join(data.root, `${randomUUID()}.zcode-transfer`), PASSPHRASE, [
        { archivePath: "profile/v2/credentials.json", contents: Buffer.from("bad") },
      ]),
      (error: unknown) => error instanceof ZCodeTransferError && error.code === "invalid_payload",
    );
    await exportZCodeTransfer({ ...data, passphrase: PASSPHRASE });
    await mkdir(data.targetProfileDir, { recursive: true });
    await writeFile(join(data.targetProfileDir, "existing.txt"), "old-profile");
    await mkdir(`${data.targetProfileDir}.imported-hyperresearch`);
    await assert.rejects(
      importZCodeTransfer({ ...data, passphrase: PASSPHRASE }),
      (error: unknown) => error instanceof ZCodeTransferError && error.code === "target_busy",
    );
    assert.equal(
      await readFile(join(data.targetProfileDir, "existing.txt"), "utf8"),
      "old-profile",
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("oversized source media is rejected before archive publication", async () => {
  const data = await fixture();
  try {
    const oversized = join(data.sourceProfileDir, "cli", "artifacts", "too-large.bin");
    const handle = await open(oversized, "w");
    try {
      await handle.truncate(128 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(
      exportZCodeTransfer({ ...data, passphrase: PASSPHRASE }),
      (error: unknown) => error instanceof ZCodeTransferError && error.code === "invalid_payload",
    );
    await assert.rejects(stat(data.archivePath), { code: "ENOENT" });
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("startup recovery restores the previous profile after interrupted backup rename", async () => {
  const data = await fixture();
  try {
    await mkdir(data.targetProfileDir, { recursive: true });
    await writeFile(join(data.targetProfileDir, "existing.txt"), "old-profile");
    const backupDir = `${data.targetProfileDir}.backup-interrupted`;
    const stagingDir = join(data.targetHomeDir, ".zcode-transfer-import-interrupted");
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "staged.txt"), "incomplete-import");
    await writeFile(
      `${data.targetProfileDir}.transfer-journal`,
      JSON.stringify({
        formatVersion: 1,
        hadTarget: true,
        backupDir,
        stagingDir,
        hasPayload: true,
      }),
    );
    await rename(data.targetProfileDir, backupDir);
    assert.equal(await recoverInterruptedZCodeTransfer(data.targetProfileDir), "restored");
    assert.equal(
      await readFile(join(data.targetProfileDir, "existing.txt"), "utf8"),
      "old-profile",
    );
    await assert.rejects(stat(stagingDir), { code: "ENOENT" });
    assert.equal(await recoverInterruptedZCodeTransfer(data.targetProfileDir), "none");
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
