import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, posix, resolve, sep } from "node:path";
import { ZCodeTransferError } from "./profileTransferArchive.js";

const nodeRequire = createRequire(import.meta.url);
// Keep node:sqlite external when tsup bundles the Electron main process.
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export interface ProfileTransferManifest {
  formatVersion: 1;
  sourceProfileDir: string;
  sourceWorkspaceDir: string;
  mediaPaths: Record<string, string>;
  createdAt: string;
}

export interface MigrationOptions {
  stagedProfileDir: string;
  sourceProfileDir: string;
  sourceWorkspaceDir: string;
  targetProfileDir: string;
  targetWorkspaceDir: string;
  mediaPaths: Record<string, string>;
}

function projectIdFromDirectory(directory: string): string {
  const slug = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `proj_${slug || "default"}`;
}

function projectMemoryName(
  directory: string,
  workspaceIdentity: string | null,
  sourceIsMac: boolean,
): string {
  const identity = workspaceIdentity?.trim();
  const normalized = sourceIsMac ? posix.resolve(directory) : resolve(directory);
  const key =
    identity ||
    (process.platform === "win32" && !sourceIsMac ? normalized.toLowerCase() : normalized);
  const slug = identity
    ? "project"
    : (sourceIsMac ? posix.basename(normalized) : basename(normalized))
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "project";
  return `${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

class PathMapper {
  readonly mappings = new Map<string, string>();
  readonly importedWorkspacePaths = new Set<string>();
  readonly projectMemoryNames = new Map<string, string>();

  constructor(private readonly options: MigrationOptions) {
    this.mappings.set(options.sourceProfileDir, options.targetProfileDir);
    this.mappings.set(options.sourceWorkspaceDir, options.targetWorkspaceDir);
    for (const [source, archiveRelative] of Object.entries(options.mediaPaths)) {
      if (!archiveRelative.startsWith("profile/imported-media/")) {
        throw new ZCodeTransferError("invalid_payload", "Transfer media mapping is invalid.");
      }
      this.mappings.set(
        source,
        join(options.targetProfileDir, ...archiveRelative.slice(8).split("/")),
      );
    }
  }

  registerWorkspace(source: string): string {
    const mapped = this.mapPath(source);
    if (mapped !== source) return mapped;
    if (!source.startsWith("/")) return source;
    const label =
      basename(source) === "workspace"
        ? basename(source.slice(0, -"/workspace".length))
        : basename(source);
    const safeLabel =
      label
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .slice(0, 36) || "workspace";
    const suffix = createHash("sha256").update(source).digest("hex").slice(0, 8);
    const destination = join(
      this.options.targetProfileDir,
      "workspace",
      "imported-mac",
      `${safeLabel}-${suffix}`,
    );
    this.mappings.set(source, destination);
    this.importedWorkspacePaths.add(destination);
    return destination;
  }

  mapPath(value: string): string {
    for (const [source, target] of [...this.mappings].sort((a, b) => b[0].length - a[0].length)) {
      if (value === source) return target;
      if (value.startsWith(`${source}/`)) {
        return join(target, ...value.slice(source.length + 1).split("/"));
      }
    }
    return value;
  }

  registerProjectMemory(
    sourceDirectory: string,
    targetDirectory: string,
    workspaceId: string | null,
  ): void {
    const sourceName = projectMemoryName(sourceDirectory, workspaceId, true);
    const targetName = projectMemoryName(targetDirectory, workspaceId, false);
    if (sourceName !== targetName) this.projectMemoryNames.set(sourceName, targetName);
  }

  async migrateProjectMemories(): Promise<void> {
    const projectsRoot = join(this.options.stagedProfileDir, "cli", "memories", "projects");
    for (const [sourceName, targetName] of this.projectMemoryNames) {
      const source = join(projectsRoot, sourceName);
      if (!(await stat(source).catch(() => null))) continue;
      const target = join(projectsRoot, targetName);
      if (await stat(target).catch(() => null)) {
        throw new ZCodeTransferError(
          "invalid_payload",
          "Transferred project memories conflict after path remapping.",
        );
      }
      await rename(source, target);
    }
  }

  async createImportedDirectories(): Promise<void> {
    for (const destination of this.importedWorkspacePaths) {
      const relative = destination.slice(this.options.targetProfileDir.length + 1);
      await mkdir(join(this.options.stagedProfileDir, ...relative.split(sep)), { recursive: true });
    }
  }
}

function checkDatabase(database: import("node:sqlite").DatabaseSync): void {
  const result = database.prepare("PRAGMA quick_check").get() as
    | { quick_check?: string }
    | undefined;
  if (result?.quick_check !== "ok") {
    throw new ZCodeTransferError("invalid_payload", "Transferred chat database is corrupt.");
  }
}

function remapRuntimeJsonColumn(
  database: import("node:sqlite").DatabaseSync,
  table: "message" | "part",
  mapper: PathMapper,
): void {
  const rows = database.prepare(`SELECT id, data AS value FROM ${table}`).all() as Array<{
    id: string;
    value: string;
  }>;
  const update = database.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (table === "message") {
      const path = parsed.path;
      if (!path || typeof path !== "object" || Array.isArray(path)) continue;
      const runtimePath = path as Record<string, unknown>;
      for (const key of ["cwd", "root"]) {
        if (typeof runtimePath[key] === "string") {
          runtimePath[key] = mapper.mapPath(runtimePath[key]);
        }
      }
    } else {
      if (parsed.type !== "file") continue;
      const source = parsed.source;
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      const fileSource = source as Record<string, unknown>;
      if (typeof fileSource.path === "string") {
        fileSource.path = mapper.mapPath(fileSource.path);
      }
    }
    const remapped = JSON.stringify(parsed);
    if (remapped !== row.value) update.run(remapped, row.id);
  }
}

function migrateCliDatabase(path: string, mapper: PathMapper): number {
  const database = new DatabaseSync(path);
  try {
    checkDatabase(database);
    const sessions = database
      .prepare("SELECT id, project_id, workspace_id, directory, path FROM session")
      .all() as Array<{
      id: string;
      project_id: string;
      workspace_id: string | null;
      directory: string;
      path: string | null;
    }>;
    const projectIds = new Map<string, string>();
    for (const session of sessions) {
      const mappedDirectory = mapper.registerWorkspace(session.directory);
      projectIds.set(session.project_id, projectIdFromDirectory(mappedDirectory));
      mapper.registerProjectMemory(session.directory, mappedDirectory, session.workspace_id);
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const updateSession = database.prepare(
        "UPDATE session SET project_id = ?, directory = ?, path = ? WHERE id = ?",
      );
      for (const session of sessions) {
        const directory = mapper.mapPath(session.directory);
        updateSession.run(
          projectIdFromDirectory(directory),
          directory,
          session.path ? mapper.mapPath(session.path) : null,
          session.id,
        );
      }
      for (const [source, destination] of projectIds) {
        database
          .prepare("UPDATE permission SET project_id = ? WHERE project_id = ?")
          .run(destination, source);
        database
          .prepare("UPDATE input_history SET project_id = ? WHERE project_id = ?")
          .run(destination, source);
        database
          .prepare("UPDATE local_setting SET scope_id = ? WHERE scope = 'project' AND scope_id = ?")
          .run(destination, source);
      }
      remapRuntimeJsonColumn(database, "message", mapper);
      remapRuntimeJsonColumn(database, "part", mapper);
      for (const [table, column] of [
        ["workflow_run", "cwd"],
        ["dwf_run", "cwd"],
        ["workflow_definition", "script_path"],
      ] as const) {
        const rows = database
          .prepare(`SELECT rowid AS id, ${column} AS value FROM ${table}`)
          .all() as Array<{
          id: number;
          value: string | null;
        }>;
        const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
        for (const row of rows) {
          if (row.value) update.run(mapper.mapPath(row.value), row.id);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    checkDatabase(database);
    return sessions.length;
  } finally {
    database.close();
  }
}

function migrateTaskDatabase(path: string, mapper: PathMapper): void {
  const database = new DatabaseSync(path);
  try {
    checkDatabase(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "tasks",
        "task_group_members",
        "task_group_workspace_bootstraps",
        "automations",
        "automation_runs",
        "off_peak_tasks",
      ]) {
        const columns = new Set(
          (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
            (column) => column.name,
          ),
        );
        for (const column of ["workspace_key", "workspace_path"] as const) {
          if (!columns.has(column)) continue;
          const rows = database
            .prepare(`SELECT rowid AS id, ${column} AS value FROM ${table}`)
            .all() as Array<{
            id: number;
            value: string;
          }>;
          const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
          for (const row of rows) {
            const mapped = mapper.registerWorkspace(row.value);
            if (mapped !== row.value) update.run(mapped, row.id);
          }
        }
      }
      const rows = database
        .prepare("SELECT rowid AS id, meta_json AS value FROM tasks")
        .all() as Array<{
        id: number;
        value: string;
      }>;
      const updateMeta = database.prepare("UPDATE tasks SET meta_json = ? WHERE rowid = ?");
      for (const row of rows) {
        const meta = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof meta.workspacePath === "string") {
          meta.workspacePath = mapper.mapPath(meta.workspacePath);
        }
        const remapped = JSON.stringify(meta);
        if (remapped !== row.value) updateMeta.run(remapped, row.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    checkDatabase(database);
  } finally {
    database.close();
  }
}

async function migrateSettings(path: string, mapper: PathMapper): Promise<void> {
  const settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ZCodeTransferError("invalid_payload", "Transfer settings are invalid.");
  }
  const recent = settings.recentProjects;
  if (Array.isArray(recent)) {
    settings.recentProjects = recent.map((entry) =>
      typeof entry === "string" ? mapper.registerWorkspace(entry) : entry,
    );
  }
  const sessions = settings.lastWorkspaceSession;
  if (Array.isArray(sessions)) {
    settings.lastWorkspaceSession = sessions.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const object = entry as Record<string, unknown>;
      return {
        ...object,
        workspacePath:
          typeof object.workspacePath === "string"
            ? mapper.registerWorkspace(object.workspacePath)
            : object.workspacePath,
      };
    });
  }
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export async function migrateStagedProfile(
  options: MigrationOptions,
): Promise<{ sessionCount: number; importedTemporaryWorkspaceDir?: string }> {
  const mapper = new PathMapper(options);
  const sessionCount = migrateCliDatabase(
    join(options.stagedProfileDir, "cli", "db", "db.sqlite"),
    mapper,
  );
  await mapper.migrateProjectMemories();
  migrateTaskDatabase(join(options.stagedProfileDir, "v2", "tasks-index.sqlite"), mapper);
  await migrateSettings(join(options.stagedProfileDir, "v2", "setting.json"), mapper);
  await mapper.createImportedDirectories();
  return {
    sessionCount,
    importedTemporaryWorkspaceDir: [...mapper.importedWorkspacePaths][0],
  };
}
