#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultOutputDir = join(homedir(), "Desktop", "ZCode-Windows11-x64-Transfer");
const archiveName = "ZCode-Profile.zcode-transfer";

function parseArgs(args) {
  const options = { out: defaultOutputDir };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help") {
      return { help: true };
    }
    if (!["--installer", "--archive", "--build-commit", "--out"].includes(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    options[name.slice(2).replace("build-commit", "buildCommit")] = value;
  }
  if (!options.installer || !options.archive || !options.buildCommit) {
    throw new Error("--installer, --archive, and --build-commit are required");
  }
  return options;
}

async function assertRegularFile(path, label) {
  const file = await lstat(path).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`${label} must be a nonempty regular file`);
  }
}

async function assertPeInstaller(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await file.read(header, 0, 2, 0);
    if (bytesRead !== 2 || header.toString("ascii") !== "MZ") {
      throw new Error("Installer is not a Windows executable");
    }
  } finally {
    await file.close();
  }
}

async function assertEncryptedTransferArchive(path) {
  const archive = await lstat(path);
  if (archive.size < 55) {
    throw new Error("Transfer archive is too short to contain encrypted content");
  }
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(10);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 10 || header.toString("ascii", 0, 9) !== "ZCODEXFER" || header[9] !== 1) {
      throw new Error("Transfer archive has an unsupported encrypted format");
    }
  } finally {
    await file.close();
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function startHere({ installerName, buildCommit }) {
  return `# Start Here: ZCode for Windows 11 x64

This kit contains the unsigned ZCode installer from fork commit \`${buildCommit}\` and an encrypted copy of your Mac ZCode setup. Keep the transfer file and its passphrase private. The GLM model continues running on your GX10; this PC must be on the same LAN.

## Install

1. On the Windows PC, install [Git for Windows](https://git-scm.com/install/windows) and [uv](https://docs.astral.sh/uv/getting-started/installation/). In PowerShell, run \`winget install --id Git.Git -e --source winget\` and \`winget install --id astral-sh.uv -e\`, then reopen PowerShell. An internet connection is needed for the first HyperResearch dependency and browser setup.
2. In PowerShell, run \`Get-FileHash .\\${installerName} -Algorithm SHA256\` and \`Get-FileHash .\\${archiveName} -Algorithm SHA256\`. Compare the hashes with \`SHA256SUMS.txt\` in this folder.
3. Run \`${installerName}\`. It is unsigned, so Windows may show a publisher warning. Continue only after the hashes match.
4. Launch ZCode. At the first-launch **Import Mac Setup** prompt, select \`${archiveName}\` and enter the transfer passphrase. If the prompt was skipped, close ZCode, locate \`ZCode.exe\` in the installation directory you chose, and run \`& "C:\\path\\to\\ZCode.exe" --import-mac-setup\` in PowerShell.
5. Let ZCode finish profile import and restart. HyperResearch setup may take longer while Python 3.12 dependencies and Chromium are installed. Sign back in to Z.ai; Mac account credentials cannot be transferred.

If HyperResearch dependency setup reports missing Git or uv after installation, close ZCode and launch it from a newly opened PowerShell so it inherits the updated PATH (or sign out and back in). ZCode will offer to retry the pending setup, including the browser, Stop hook, and agents.

The encrypted archive can be imported again if the app reports a profile import failure. Follow the app's rollback or retry message before retrying.

## Check on this PC

- In About, confirm the commit matches \`${buildCommit.slice(0, 8)}\`. Local is the default provider and shows GLM-5.3-Flash with a 1,048,576-token context, a blank personal output-token override, and Low/High/Max reasoning controls.
- Open several imported chats and their attachments. Open the HyperResearch workspace and skill. Exercise Browser Use, which uses the bundled node-repl runtime.
- In disposable chats, test Local text, all three reasoning levels, a tool call, structured JSON, a photo, a short video, a two-page PDF, Guide steering, and remote Web replay.

This kit has not passed those Windows 11 on-device checks until you run them. Official automatic updates are disabled for this fork; future updates use another validated fork build and transfer/backup flow.
`;
}

export async function assembleWindowsTransferKit({ installer, archive, buildCommit, out }) {
  if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
    throw new Error("--build-commit must be a full 40-character Git commit ID");
  }
  const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const installerName = `ZCode-${packageJson.version}-win-x64.exe`;
  const installerPath = resolve(installer);
  const archivePath = resolve(archive);
  const outputDir = resolve(out);

  if (basename(installerPath) !== installerName) {
    throw new Error(`Expected Windows x64 installer named ${installerName}`);
  }
  if (!archivePath.endsWith(".zcode-transfer")) {
    throw new Error("Archive must have a .zcode-transfer extension");
  }
  await assertRegularFile(installerPath, "Installer");
  await assertPeInstaller(installerPath);
  await assertRegularFile(archivePath, "Archive");
  await assertEncryptedTransferArchive(archivePath);
  if (await lstat(outputDir).catch(() => null)) {
    throw new Error(`Kit destination already exists: ${outputDir}`);
  }

  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  try {
    const copiedInstaller = join(outputDir, installerName);
    const copiedArchive = join(outputDir, archiveName);
    await copyFile(installerPath, copiedInstaller, constants.COPYFILE_EXCL);
    await copyFile(archivePath, copiedArchive, constants.COPYFILE_EXCL);
    await Promise.all([chmod(copiedInstaller, 0o600), chmod(copiedArchive, 0o600)]);

    const [installerHash, archiveHash] = await Promise.all([
      sha256(copiedInstaller),
      sha256(copiedArchive),
    ]);
    await writeFile(
      join(outputDir, "SHA256SUMS.txt"),
      `${installerHash}  ${installerName}\n${archiveHash}  ${archiveName}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(outputDir, "BUILD_INFO.json"),
      `${JSON.stringify({ buildCommit, version: packageJson.version, platform: "win32-x64" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(join(outputDir, "START_HERE.md"), startHere({ installerName, buildCommit }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }

  return outputDir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        "Usage: node scripts/assemble-windows-transfer-kit.mjs --installer <ZCode-*-win-x64.exe> --archive <encrypted.zcode-transfer> --build-commit <40-hex> [--out <directory>]\n",
      );
    } else {
      const outputDir = await assembleWindowsTransferKit(options);
      process.stdout.write(`Private kit ready: ${outputDir}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
