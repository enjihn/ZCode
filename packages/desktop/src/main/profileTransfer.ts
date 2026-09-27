/* eslint-disable max-lines -- Profile export, import, and crash recovery share one atomic transfer boundary. */
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import {
  inspectEncryptedTransfer,
  readEncryptedTransfer,
  writeEncryptedTransfer,
  ZCodeTransferError,
  type TransferFile,
} from "./profileTransferArchive.js";
import { migrateStagedProfile, type ProfileTransferManifest } from "./profileTransferMigration.js";

export { ZCodeTransferError } from "./profileTransferArchive.js";
export type { ZCodeTransferErrorCode } from "./profileTransferArchive.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync, backup } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

export interface ExportZCodeTransferOptions {
  sourceProfileDir: string;
  sourceHomeDir: string;
  sourceWorkspaceDir: string;
  additionalPayloadDir?: string;
  archivePath: string;
  passphrase: string;
}

export interface ImportZCodeTransferOptions {
  archivePath: string;
  passphrase: string;
  targetProfileDir: string;
  targetHomeDir: string;
  targetWorkspaceDir?: string;
}

export interface ImportZCodeTransferResult {
  backupDir?: string;
  importedPayloadDir?: string;
  sessionCount: number;
  importedTemporaryWorkspaceDir?: string;
}

interface TransferJournal {
  formatVersion: 1;
  hadTarget: boolean;
  backupDir?: string;
  stagingDir: string;
  hasPayload: boolean;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function collectDirectory(
  source: string,
  archivePrefix: string,
  files: TransferFile[],
): Promise<void> {
  if (!(await exists(source))) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const absolutePath = join(source, entry.name);
    const archivePath = `${archivePrefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new ZCodeTransferError("invalid_payload", "Transfer source contains a symbolic link.");
    }
    if (entry.isDirectory()) {
      await collectDirectory(absolutePath, archivePath, files);
    } else if (entry.isFile()) {
      files.push({ archivePath, absolutePath });
    } else {
      throw new ZCodeTransferError(
        "invalid_payload",
        "Transfer source contains an unsupported file.",
      );
    }
  }
}

async function snapshotDatabase(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").get() as { quick_check?: string };
    if (quickCheck.quick_check !== "ok") {
      throw new ZCodeTransferError("invalid_payload", "Source ZCode database is corrupt.");
    }
    await backup(database, destination);
  } finally {
    database.close();
  }
}

async function collectExternalMedia(
  databasePath: string,
  files: TransferFile[],
): Promise<{ paths: Record<string, string>; missing: number }> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const mediaPaths = new Set<string>();
  try {
    const rows = database.prepare("SELECT data FROM part").all() as Array<{ data: string }>;
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!data || typeof data !== "object" || (data as { type?: string }).type !== "file") {
        continue;
      }
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, entry] of Object.entries(value)) {
          if (
            (key === "path" || key === "file_path" || key === "filePath") &&
            typeof entry === "string" &&
            entry.startsWith("/")
          ) {
            mediaPaths.add(entry);
          } else if (typeof entry === "object") {
            visit(entry);
          }
        }
      };
      visit(data);
    }
  } finally {
    database.close();
  }
  const paths: Record<string, string> = {};
  const seenRealPaths = new Map<string, string>();
  let missing = 0;
  for (const source of mediaPaths) {
    let canonical: string;
    try {
      canonical = await realpath(source);
      const info = await lstat(canonical);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        missing += 1;
        continue;
      }
    } catch {
      missing += 1;
      continue;
    }
    let archivePath = seenRealPaths.get(canonical);
    if (!archivePath) {
      const suffix = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
      const safeName = basename(canonical)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 80);
      archivePath = `profile/imported-media/${suffix}-${safeName}`;
      files.push({ archivePath, absolutePath: canonical });
      seenRealPaths.set(canonical, archivePath);
    }
    paths[source] = archivePath;
  }
  return { paths, missing };
}

function validateManifest(value: unknown): ProfileTransferManifest {
  if (!value || typeof value !== "object") {
    throw new ZCodeTransferError("invalid_payload", "Transfer manifest is invalid.");
  }
  const manifest = value as Partial<ProfileTransferManifest>;
  if (
    manifest.formatVersion !== 1 ||
    typeof manifest.sourceProfileDir !== "string" ||
    !manifest.sourceProfileDir.startsWith("/") ||
    typeof manifest.sourceWorkspaceDir !== "string" ||
    !manifest.sourceWorkspaceDir.startsWith("/") ||
    typeof manifest.createdAt !== "string" ||
    !manifest.mediaPaths ||
    typeof manifest.mediaPaths !== "object" ||
    Array.isArray(manifest.mediaPaths)
  ) {
    throw new ZCodeTransferError("invalid_payload", "Transfer manifest is invalid.");
  }
  for (const [source, target] of Object.entries(manifest.mediaPaths)) {
    if (
      !source.startsWith("/") ||
      typeof target !== "string" ||
      !target.startsWith("profile/imported-media/")
    ) {
      throw new ZCodeTransferError("invalid_payload", "Transfer media mapping is invalid.");
    }
  }
  return manifest as ProfileTransferManifest;
}

function journalPathFor(targetProfileDir: string): string {
  return `${targetProfileDir}.transfer-journal`;
}

function lockPathFor(targetProfileDir: string): string {
  return `${targetProfileDir}.transfer-lock`;
}

async function acquireTransferLock(
  targetProfileDir: string,
): Promise<import("node:fs/promises").FileHandle> {
  const lockPath = lockPathFor(targetProfileDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.sync();
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number | undefined;
      try {
        pid = (JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number }).pid;
      } catch {
        // A crashed process may leave a partial lock; do not remove a fresh one.
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs < 30_000) break;
      }
      if (typeof pid === "number" && pid > 0) {
        try {
          process.kill(pid, 0);
          break;
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") break;
        }
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new ZCodeTransferError("target_busy", "Another ZCode transfer is in progress.");
}

async function releaseTransferLock(
  targetProfileDir: string,
  handle: import("node:fs/promises").FileHandle,
): Promise<void> {
  await handle.close();
  await rm(lockPathFor(targetProfileDir), { force: true });
}

async function writeTransferJournal(
  targetProfileDir: string,
  journal: TransferJournal,
): Promise<void> {
  const journalPath = journalPathFor(targetProfileDir);
  const handle = await open(journalPath, "wx", 0o600);
  let written = false;
  try {
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
    written = true;
  } finally {
    await handle.close();
    if (!written) await rm(journalPath, { force: true });
  }
}

async function readTransferJournal(targetProfileDir: string): Promise<TransferJournal | null> {
  const path = journalPathFor(targetProfileDir);
  if (!(await exists(path))) return null;
  let journal: TransferJournal;
  try {
    journal = JSON.parse(await readFile(path, "utf8")) as TransferJournal;
  } catch {
    throw new ZCodeTransferError("invalid_payload", "ZCode transfer recovery journal is damaged.");
  }
  if (
    journal.formatVersion !== 1 ||
    typeof journal.hadTarget !== "boolean" ||
    typeof journal.hasPayload !== "boolean" ||
    typeof journal.stagingDir !== "string" ||
    normalize(journal.stagingDir) !== journal.stagingDir ||
    dirname(journal.stagingDir) !== dirname(targetProfileDir) ||
    !basename(journal.stagingDir).startsWith(".zcode-transfer-import-") ||
    (journal.hadTarget &&
      (typeof journal.backupDir !== "string" ||
        normalize(journal.backupDir) !== journal.backupDir ||
        dirname(journal.backupDir) !== dirname(targetProfileDir) ||
        !basename(journal.backupDir).startsWith(`${basename(targetProfileDir)}.backup-`)))
  ) {
    throw new ZCodeTransferError("invalid_payload", "ZCode transfer recovery journal is invalid.");
  }
  return journal;
}

async function recoverLocked(
  targetProfileDir: string,
  forceRollback = false,
): Promise<"none" | "restored" | "completed"> {
  const journal = await readTransferJournal(targetProfileDir);
  if (!journal) return "none";
  const payloadDir = `${targetProfileDir}.imported-hyperresearch`;
  const targetExists = await exists(targetProfileDir);
  const backupExists = Boolean(journal.backupDir && (await exists(journal.backupDir)));
  const payloadExists = await exists(payloadDir);
  let outcome: "none" | "restored" | "completed" = "none";
  if (journal.hadTarget && backupExists) {
    if (!targetExists || forceRollback || (journal.hasPayload && !payloadExists)) {
      if (targetExists) await rm(targetProfileDir, { recursive: true, force: true });
      if (payloadExists) await rm(payloadDir, { recursive: true, force: true });
      await rename(journal.backupDir!, targetProfileDir);
      outcome = "restored";
    } else {
      outcome = "completed";
    }
  } else if (journal.hadTarget) {
    if (!targetExists) {
      throw new ZCodeTransferError(
        "invalid_payload",
        "ZCode profile and recovery backup are both missing.",
      );
    }
    outcome = "none";
  } else if (targetExists) {
    if (forceRollback || (journal.hasPayload && !payloadExists)) {
      await rm(targetProfileDir, { recursive: true, force: true });
      if (payloadExists) await rm(payloadDir, { recursive: true, force: true });
      outcome = "restored";
    } else {
      outcome = "completed";
    }
  }
  await rm(journal.stagingDir, { recursive: true, force: true });
  await rm(journalPathFor(targetProfileDir), { force: true });
  return outcome;
}

export async function recoverInterruptedZCodeTransfer(
  targetProfileDir: string,
): Promise<"none" | "restored" | "completed"> {
  await mkdir(dirname(targetProfileDir), { recursive: true });
  const lock = await acquireTransferLock(targetProfileDir);
  try {
    return await recoverLocked(targetProfileDir);
  } finally {
    await releaseTransferLock(targetProfileDir, lock);
  }
}

export async function exportZCodeTransfer(
  options: ExportZCodeTransferOptions,
): Promise<{ archivePath: string; fileCount: number; missingExternalMediaCount: number }> {
  if (options.sourceProfileDir !== join(options.sourceHomeDir, ".zcode")) {
    throw new ZCodeTransferError(
      "invalid_payload",
      "ZCode profile path does not match the source home.",
    );
  }
  if (await exists(options.archivePath)) {
    throw new ZCodeTransferError("target_busy", "The transfer archive already exists.");
  }
  const stagingDir = await mkdtemp(join(tmpdir(), ".zcode-transfer-snapshot-"));
  const files: TransferFile[] = [];
  try {
    for (const [relative, archivePath] of [
      ["v2/setting.json", "profile/v2/setting.json"],
      ["v2/provider_config.json", "profile/v2/provider_config.json"],
    ] as const) {
      const absolutePath = join(options.sourceProfileDir, ...relative.split("/"));
      if (!(await exists(absolutePath))) {
        throw new ZCodeTransferError("invalid_payload", "Required ZCode settings are missing.");
      }
      files.push({ archivePath, absolutePath });
    }
    for (const relative of ["cli/db/db.sqlite", "v2/tasks-index.sqlite"] as const) {
      const source = join(options.sourceProfileDir, ...relative.split("/"));
      const snapshot = join(stagingDir, ...relative.split("/"));
      await snapshotDatabase(source, snapshot);
      files.push({ archivePath: `profile/${relative}`, absolutePath: snapshot });
    }
    for (const relative of [
      "cli/artifacts",
      "cli/video-cache",
      "cli/rollout",
      "cli/memories",
      "cli/agents",
      "workspace/default",
    ]) {
      await collectDirectory(
        join(options.sourceProfileDir, ...relative.split("/")),
        `profile/${relative}`,
        files,
      );
    }
    const media = await collectExternalMedia(join(stagingDir, "cli", "db", "db.sqlite"), files);
    if (options.additionalPayloadDir) {
      if (!(await exists(options.additionalPayloadDir))) {
        throw new ZCodeTransferError(
          "invalid_payload",
          "HyperResearch transfer payload is missing.",
        );
      }
      await collectDirectory(options.additionalPayloadDir, "hyperresearch", files);
    }
    let expandedBytes = 0;
    for (const file of files) {
      const size = file.contents?.length ?? (await stat(file.absolutePath!)).size;
      expandedBytes += size;
      if (size > MAX_FILE_BYTES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new ZCodeTransferError("invalid_payload", "Transfer data exceeds the size limit.");
      }
    }
    const manifest: ProfileTransferManifest = {
      formatVersion: 1,
      sourceProfileDir: options.sourceProfileDir,
      sourceWorkspaceDir: options.sourceWorkspaceDir,
      mediaPaths: media.paths,
      createdAt: new Date().toISOString(),
    };
    files.push({ archivePath: "manifest.json", contents: Buffer.from(JSON.stringify(manifest)) });
    await writeEncryptedTransfer(options.archivePath, options.passphrase, files);
    return {
      archivePath: options.archivePath,
      fileCount: files.length,
      missingExternalMediaCount: media.missing,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

export async function inspectZCodeTransfer(
  archivePath: string,
): Promise<{ formatVersion: 1; encryptedBytes: number }> {
  return inspectEncryptedTransfer(archivePath);
}

export async function importZCodeTransfer(
  options: ImportZCodeTransferOptions,
): Promise<ImportZCodeTransferResult> {
  const targetWorkspaceDir =
    options.targetWorkspaceDir ??
    join(options.targetHomeDir, "Projects", "hyperresearch-zcode-smoke");
  const parentDir = dirname(options.targetProfileDir);
  const payloadDir = `${options.targetProfileDir}.imported-hyperresearch`;
  await mkdir(parentDir, { recursive: true });
  const lock = await acquireTransferLock(options.targetProfileDir);
  let stagingDir: string | undefined;
  let backupDir: string | undefined;
  let payloadPlaced = false;
  try {
    await recoverLocked(options.targetProfileDir);
    stagingDir = await mkdtemp(join(parentDir, ".zcode-transfer-import-"));
    const names = await readEncryptedTransfer(options.archivePath, options.passphrase, stagingDir);
    const required = [
      "manifest.json",
      "profile/v2/setting.json",
      "profile/v2/provider_config.json",
      "profile/v2/tasks-index.sqlite",
      "profile/cli/db/db.sqlite",
    ];
    if (!required.every((name) => names.includes(name))) {
      throw new ZCodeTransferError("invalid_payload", "Transfer is missing required ZCode data.");
    }
    const manifest = validateManifest(
      JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8")),
    );
    const stagedProfileDir = join(stagingDir, "profile");
    const providerConfig = JSON.parse(
      await readFile(join(stagedProfileDir, "v2", "provider_config.json"), "utf8"),
    ) as { schemaVersion?: unknown; config?: unknown };
    if (providerConfig?.schemaVersion !== 1 || !providerConfig.config) {
      throw new ZCodeTransferError("invalid_payload", "Transfer provider settings are invalid.");
    }
    const migration = await migrateStagedProfile({
      stagedProfileDir,
      sourceProfileDir: manifest.sourceProfileDir,
      sourceWorkspaceDir: manifest.sourceWorkspaceDir,
      targetProfileDir: options.targetProfileDir,
      targetWorkspaceDir,
      mediaPaths: manifest.mediaPaths,
    });
    const hasPayload = names.some((name) => name.startsWith("hyperresearch/"));
    if (hasPayload && (await exists(payloadDir))) {
      throw new ZCodeTransferError(
        "target_busy",
        "A previous HyperResearch transfer payload exists.",
      );
    }
    const hadTarget = await exists(options.targetProfileDir);
    if (hadTarget) {
      backupDir = `${options.targetProfileDir}.backup-${new Date()
        .toISOString()
        .replace(/[^0-9]/g, "")
        .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    }
    await writeTransferJournal(options.targetProfileDir, {
      formatVersion: 1,
      hadTarget,
      ...(backupDir ? { backupDir } : {}),
      stagingDir,
      hasPayload,
    });
    if (hadTarget) {
      await rename(options.targetProfileDir, backupDir!);
    }
    try {
      await rename(stagedProfileDir, options.targetProfileDir);
      if (hasPayload) {
        await rename(join(stagingDir, "hyperresearch"), payloadDir);
        payloadPlaced = true;
      }
    } catch (error) {
      await recoverLocked(options.targetProfileDir, true);
      backupDir = undefined;
      throw error;
    }
    await rm(journalPathFor(options.targetProfileDir), { force: true });
    return {
      ...(backupDir ? { backupDir } : {}),
      ...(payloadPlaced ? { importedPayloadDir: payloadDir } : {}),
      ...migration,
    };
  } catch (error) {
    if (error instanceof ZCodeTransferError) throw error;
    throw new ZCodeTransferError("invalid_payload", "ZCode transfer could not be imported.");
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    await releaseTransferLock(options.targetProfileDir, lock);
  }
}
