import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assembleWindowsTransferKit } from "./assemble-windows-transfer-kit.mjs";

const commit = "a".repeat(40);
const { version } = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
);
const transferBytes = Buffer.concat([
  Buffer.from("ZCODEXFER", "ascii"),
  Buffer.from([1]),
  Buffer.alloc(16),
  Buffer.alloc(12),
  Buffer.from("encrypted"),
  Buffer.alloc(16),
]);

test("kit assembly copies only installer and opaque encrypted archive with checksums", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-kit-test-"));
  const installer = join(temp, `ZCode-${version}-win-x64.exe`);
  const archive = join(temp, "private.zcode-transfer");
  const out = join(temp, "kit");
  const installerBytes = Buffer.from("MZtest-installer");
  const archiveBytes = transferBytes;
  try {
    await writeFile(installer, installerBytes);
    await writeFile(archive, archiveBytes);
    assert.equal(
      await assembleWindowsTransferKit({ installer, archive, buildCommit: commit, out }),
      out,
    );
    assert.deepEqual(await readFile(join(out, `ZCode-${version}-win-x64.exe`)), installerBytes);
    assert.deepEqual(await readFile(join(out, "ZCode-Profile.zcode-transfer")), archiveBytes);

    const installerHash = createHash("sha256").update(installerBytes).digest("hex");
    const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
    assert.equal(
      await readFile(join(out, "SHA256SUMS.txt"), "utf8"),
      `${installerHash}  ZCode-${version}-win-x64.exe\n${archiveHash}  ZCode-Profile.zcode-transfer\n`,
    );
    assert.match(await readFile(join(out, "START_HERE.md"), "utf8"), /Import Mac Setup/);
    assert.match(await readFile(join(out, "BUILD_INFO.json"), "utf8"), new RegExp(commit));
    assert.equal((await stat(out)).mode & 0o777, 0o700);
    assert.equal((await stat(join(out, "ZCode-Profile.zcode-transfer"))).mode & 0o777, 0o600);

    await assert.rejects(
      assembleWindowsTransferKit({ installer, archive, buildCommit: commit, out }),
      /already exists/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("kit assembly rejects a mislabeled installer before creating output", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-kit-test-"));
  const installer = join(temp, `ZCode-${version}-win-x64.exe`);
  const archive = join(temp, "private.zcode-transfer");
  const out = join(temp, "kit");
  try {
    await writeFile(installer, "not-a-pe");
    await writeFile(archive, transferBytes);
    await assert.rejects(
      assembleWindowsTransferKit({ installer, archive, buildCommit: commit, out }),
      /not a Windows executable/,
    );
    await assert.rejects(stat(out), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("kit assembly rejects a file mislabeled as an encrypted transfer archive", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-kit-test-"));
  const installer = join(temp, `ZCode-${version}-win-x64.exe`);
  const archive = join(temp, "private.zcode-transfer");
  const out = join(temp, "kit");
  try {
    await writeFile(installer, "MZtest-installer");
    await writeFile(archive, Buffer.alloc(60));
    await assert.rejects(
      assembleWindowsTransferKit({ installer, archive, buildCommit: commit, out }),
      /unsupported encrypted format/,
    );
    await assert.rejects(stat(out), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
