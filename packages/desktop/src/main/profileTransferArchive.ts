import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { appendFile, copyFile, link, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { ZipFile } from "yazl";

const MAGIC = Buffer.from("ZCODEXFER", "ascii");
const VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENCRYPTED_BYTES = 512 * 1024 * 1024;

export type ZCodeTransferErrorCode =
  | "invalid_format"
  | "unsupported_version"
  | "authentication_failed"
  | "invalid_payload"
  | "target_busy";

export class ZCodeTransferError extends Error {
  constructor(
    public readonly code: ZCodeTransferErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ZCodeTransferError";
  }
}

export interface TransferFile {
  archivePath: string;
  absolutePath?: string;
  contents?: Buffer;
}

function validateEntryName(name: string): void {
  const segments = name.split("/");
  if (
    !name ||
    name.length > 1024 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[:<>"|?*]/u.test(segment) ||
        [...segment].some((character) => character.charCodeAt(0) < 32) ||
        /[. ]$/u.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    posix.normalize(name) !== name
  ) {
    throw new ZCodeTransferError("invalid_payload", "Transfer contains an unsafe file path.");
  }
}

function validatePayloadPath(name: string): void {
  validateEntryName(name);
  const exactProfileFiles = new Set([
    "profile/v2/setting.json",
    "profile/v2/provider_config.json",
    "profile/v2/tasks-index.sqlite",
    "profile/cli/db/db.sqlite",
  ]);
  const profileDirectories = [
    "profile/cli/artifacts/",
    "profile/cli/video-cache/",
    "profile/cli/rollout/",
    "profile/cli/memories/",
    "profile/cli/agents/",
    "profile/workspace/default/",
    "profile/imported-media/",
  ];
  if (
    name !== "manifest.json" &&
    !exactProfileFiles.has(name) &&
    !profileDirectories.some((directory) => name.startsWith(directory)) &&
    !name.startsWith("hyperresearch/")
  ) {
    throw new ZCodeTransferError("invalid_payload", "Transfer contains an unexpected file.");
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 12) {
    throw new ZCodeTransferError(
      "invalid_format",
      "Transfer passphrase must be at least 12 characters.",
    );
  }
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived as Buffer);
      },
    );
  });
}

export async function inspectEncryptedTransfer(
  archivePath: string,
): Promise<{ formatVersion: 1; encryptedBytes: number }> {
  const archiveStat = await stat(archivePath);
  if (
    !archiveStat.isFile() ||
    archiveStat.size < HEADER_BYTES + TAG_BYTES + 1 ||
    archiveStat.size > MAX_ENCRYPTED_BYTES
  ) {
    throw new ZCodeTransferError("invalid_format", "Transfer archive size is invalid.");
  }
  const handle = await open(archivePath, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const read = await handle.read(header, 0, HEADER_BYTES, 0);
    if (read.bytesRead !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ZCodeTransferError("invalid_format", "This is not a ZCode transfer archive.");
    }
    if (header[MAGIC.length] !== VERSION) {
      throw new ZCodeTransferError(
        "unsupported_version",
        "Transfer archive version is unsupported.",
      );
    }
    return { formatVersion: VERSION, encryptedBytes: archiveStat.size - HEADER_BYTES - TAG_BYTES };
  } finally {
    await handle.close();
  }
}

export async function writeEncryptedTransfer(
  archivePath: string,
  passphrase: string,
  files: readonly TransferFile[],
): Promise<void> {
  const names = new Set<string>();
  if (files.length > MAX_ENTRIES) {
    throw new ZCodeTransferError("invalid_payload", "Transfer has too many files.");
  }
  for (const file of files) {
    validatePayloadPath(file.archivePath);
    const folded = file.archivePath.toLowerCase();
    if (names.has(folded) || Boolean(file.absolutePath) === Boolean(file.contents)) {
      throw new ZCodeTransferError("invalid_payload", "Transfer has a duplicate or invalid file.");
    }
    names.add(folded);
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, nonce]);
  const key = await deriveKey(passphrase, salt);
  const temporaryPath = join(
    dirname(archivePath),
    `.zcode-transfer-${randomBytes(12).toString("hex")}.tmp`,
  );
  const zip = new ZipFile();
  try {
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(temporaryPath, header, { flag: "wx", mode: 0o600 });
    for (const file of files) {
      if (file.absolutePath) {
        zip.addFile(file.absolutePath, file.archivePath);
      } else {
        zip.addBuffer(file.contents!, file.archivePath);
      }
    }
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(header);
    const writing = pipeline(
      zip.outputStream,
      cipher,
      createWriteStream(temporaryPath, { flags: "a", mode: 0o600 }),
    );
    zip.end();
    await writing;
    await appendFile(temporaryPath, cipher.getAuthTag());
    if ((await stat(temporaryPath)).size > MAX_ENCRYPTED_BYTES) {
      throw new ZCodeTransferError("invalid_payload", "Transfer archive exceeds the size limit.");
    }
    // Same-directory hard link is an atomic no-clobber publish on APFS and NTFS.
    // exFAT transfer drives cannot hard-link; exclusive copy still cannot replace a prior kit.
    try {
      await link(temporaryPath, archivePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EPERM") throw error;
      await copyFile(temporaryPath, archivePath, constants.COPYFILE_EXCL);
    }
  } finally {
    key.fill(0);
    await rm(temporaryPath, { force: true });
  }
}

async function decryptToZip(
  archivePath: string,
  passphrase: string,
  zipPath: string,
): Promise<void> {
  const archiveStat = await stat(archivePath);
  await inspectEncryptedTransfer(archivePath);
  const handle = await open(archivePath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, archiveStat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const nonce = header.subarray(HEADER_BYTES - NONCE_BYTES);
  const key = await deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(archivePath, {
          start: HEADER_BYTES,
          end: archiveStat.size - TAG_BYTES - 1,
        }),
        decipher,
        createWriteStream(zipPath, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      throw new ZCodeTransferError(
        "authentication_failed",
        "The passphrase is incorrect or the transfer archive is damaged.",
      );
    }
  } finally {
    key.fill(0);
  }
}

async function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Could not open transfer ZIP"));
      else resolve(zip);
    });
  });
}

async function extractZip(zipPath: string, destinationDir: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  const seen = new Set<string>();
  const extracted: string[] = [];
  let expandedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (finished) return;
      finished = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      void (async () => {
        const name = entry.fileName;
        validatePayloadPath(name);
        const folded = name.toLowerCase();
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          entry.fileName.endsWith("/") ||
          (unixMode !== 0 && unixMode !== 0o100000) ||
          seen.has(folded) ||
          seen.size >= MAX_ENTRIES ||
          entry.uncompressedSize > MAX_FILE_BYTES ||
          expandedBytes + entry.uncompressedSize > MAX_EXPANDED_BYTES
        ) {
          throw new ZCodeTransferError(
            "invalid_payload",
            "Transfer contains unsafe or excessive files.",
          );
        }
        seen.add(folded);
        expandedBytes += entry.uncompressedSize;
        const target = join(destinationDir, ...name.split("/"));
        await mkdir(dirname(target), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((resolveStream, rejectStream) => {
          zip.openReadStream(entry, (error, result) => {
            if (error || !result) rejectStream(error ?? new Error("Could not read transfer entry"));
            else resolveStream(result);
          });
        });
        await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o600 }));
        extracted.push(name);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  return extracted;
}

export async function readEncryptedTransfer(
  archivePath: string,
  passphrase: string,
  stagingDir: string,
): Promise<string[]> {
  const zipPath = join(stagingDir, "payload.zip");
  try {
    await decryptToZip(archivePath, passphrase, zipPath);
    return await extractZip(zipPath, stagingDir);
  } catch (error) {
    if (error instanceof ZCodeTransferError) throw error;
    throw new ZCodeTransferError("invalid_payload", "Transfer archive content is invalid.");
  } finally {
    await rm(zipPath, { force: true });
  }
}
