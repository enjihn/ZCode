import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { exportZCodeTransfer } from "../packages/desktop/src/main/profileTransfer.js";
import { stageHyperResearchPayload } from "../packages/desktop/src/main/hyperResearchTransfer.js";

function requestHiddenAnswer(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = `return text returned of (display dialog ${JSON.stringify(prompt)} default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue")`;
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let answer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      answer += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error("Passphrase entry was cancelled."));
      else resolve(answer.replace(/\r?\n$/, ""));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function isZCodeRunning(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("pgrep", ["-x", "ZCode"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve(code === 0);
      else reject(new Error("Could not determine whether ZCode is running."));
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The source profile exporter must run on the Mac holding the ZCode profile.");
  }

  const homeDir = homedir();
  const archivePath = process.argv[2] ?? join(homeDir, "Desktop", "ZCode-Mac-Setup.zcode-transfer");
  if (!archivePath.endsWith(".zcode-transfer")) {
    throw new Error("The output file must have a .zcode-transfer extension.");
  }
  if (await exists(archivePath)) {
    throw new Error("The output archive already exists; choose a new file path.");
  }
  if (await isZCodeRunning()) {
    throw new Error("Quit ZCode before exporting so chats and attachments are consistent.");
  }

  const passphrase = await requestHiddenAnswer(
    "Choose a passphrase for your private ZCode transfer archive.",
  );
  if (passphrase.length < 12) {
    throw new Error("Choose a passphrase of at least 12 characters.");
  }
  const confirmation = await requestHiddenAnswer(
    "Enter the transfer passphrase again to confirm it.",
  );
  if (passphrase !== confirmation) {
    throw new Error("The passphrases did not match.");
  }

  const payloadDir = await mkdtemp(join(tmpdir(), "zcode-hyperresearch-transfer-"));
  try {
    await stageHyperResearchPayload({
      sourceRepoPath: join(homeDir, "Projects", "hyperresearch-zcode"),
      workspacePath: join(homeDir, "Projects", "hyperresearch-zcode-smoke"),
      payloadDir,
    });
    const exported = await exportZCodeTransfer({
      sourceProfileDir: join(homeDir, ".zcode"),
      sourceHomeDir: homeDir,
      sourceWorkspaceDir: join(homeDir, "Projects", "hyperresearch-zcode-smoke"),
      additionalPayloadDir: join(payloadDir, "hyperresearch"),
      archivePath,
      passphrase,
    });
    process.stdout.write(`Encrypted ZCode transfer archive: ${exported.archivePath}\n`);
  } finally {
    await rm(payloadDir, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Export failed."}\n`);
  process.exitCode = 1;
});
