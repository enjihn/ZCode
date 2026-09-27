import { app, BrowserWindow, dialog } from "electron";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  importZCodeTransfer,
  inspectZCodeTransfer,
  recoverInterruptedZCodeTransfer,
  ZCodeTransferError,
} from "./profileTransfer.js";
import { restoreHyperResearchPayload } from "./hyperResearchTransfer.js";
import { shouldOfferMacSetupImport } from "./profileTransferOnboardingPolicy.js";

const IMPORT_ARGUMENT = "--import-mac-setup";
const OFFER_MARKER = "mac-setup-import-offered";

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function buildPassphraseHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Import Mac Setup</title>
<style>
  body { color-scheme: light dark; font: menu; color: CanvasText; background: Canvas; margin: 22px; }
  label { display: block; margin-bottom: 8px; }
  input { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  button { padding: 7px 16px; font: inherit; }
</style></head><body>
<form id="form"><label for="passphrase">Transfer archive passphrase</label>
<input id="passphrase" type="password" autocomplete="off" required autofocus>
<div class="actions"><button id="cancel" type="button">Cancel</button><button type="submit">Import</button></div></form>
<script>
  document.getElementById('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (document.getElementById('passphrase').value) document.title = 'zcode-transfer-submit';
  });
  document.getElementById('cancel').addEventListener('click', () => { document.title = 'zcode-transfer-cancel'; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') document.title = 'zcode-transfer-cancel';
  });
</script></body></html>`;
}

async function requestPassphrase(): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 420,
      height: 205,
      title: "Import Mac Setup",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.on("closed", () => finish(undefined));
    win.on("page-title-updated", (event, title) => {
      if (title === "zcode-transfer-cancel") {
        event.preventDefault();
        finish(undefined);
      } else if (title === "zcode-transfer-submit") {
        event.preventDefault();
        void win.webContents
          .executeJavaScript("document.getElementById('passphrase').value")
          .then((value: unknown) => finish(typeof value === "string" ? value : undefined))
          .catch(() => finish(undefined));
      }
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildPassphraseHtml())}`);
  });
}

function showProgressWindow(message: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 430,
    height: 120,
    title: "Import Mac Setup",
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Import Mac Setup</title></head>
  <body style="color-scheme: light dark; font: menu; color: CanvasText; background: Canvas; padding: 16px;">${message}</body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

async function markOffered(markerPath: string): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, "1\n", { mode: 0o600 });
}

function safeImportError(error: unknown): string {
  if (error instanceof ZCodeTransferError) {
    switch (error.code) {
      case "authentication_failed":
        return "The passphrase is incorrect or the archive is damaged.";
      case "unsupported_version":
        return "This transfer archive requires a newer version of ZCode.";
      case "target_busy":
        return "Another transfer or pending HyperResearch setup is using this profile. Finish it before importing again.";
      default:
        return "The transfer archive is invalid or damaged. Your previous data was preserved.";
    }
  }
  return "Setup could not be imported. Your previous data was preserved.";
}

function safeHyperResearchError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("git is required") || message.startsWith("uv is required")) {
    return message;
  }
  if (
    message.startsWith("Existing HyperResearch source") ||
    message.startsWith("Existing HyperResearch workspace")
  ) {
    return "A HyperResearch folder already exists at the Windows destination. Review it before retrying; no folder was overwritten.";
  }
  return "HyperResearch dependency, browser, or skill setup did not finish. Check the Windows setup guide and retry on the next ZCode launch.";
}

async function finishHyperResearchSetup(payloadDir: string, homeDir: string): Promise<boolean> {
  const progress = showProgressWindow("Setting up HyperResearch for Windows…");
  try {
    await restoreHyperResearchPayload({ payloadDir, userHome: homeDir });
    return true;
  } catch (error) {
    if (!progress.isDestroyed()) progress.close();
    await dialog.showMessageBox({
      type: "warning",
      title: "HyperResearch setup pending",
      message: "ZCode data was imported, but HyperResearch setup is incomplete.",
      detail: `${safeHyperResearchError(error)} Your imported chats and settings are safe.`,
      buttons: ["Continue"],
    });
    return false;
  } finally {
    if (!progress.isDestroyed()) progress.close();
  }
}

/** Runs before the normal Host/window startup. Returns true when startup should stop. */
export async function runMacSetupImportOnStartup(options: {
  profileDir: string;
  homeDir: string;
}): Promise<boolean> {
  if (process.platform !== "win32" || !app.isPackaged) return false;

  const userDataDir = app.getPath("userData");
  const offerMarker = join(userDataDir, OFFER_MARKER);
  const pendingPayloadDir = `${options.profileDir}.imported-hyperresearch`;
  const explicitRequest = process.argv.includes(IMPORT_ARGUMENT);

  try {
    const recovery = await recoverInterruptedZCodeTransfer(options.profileDir);
    if (recovery === "restored") {
      await dialog.showMessageBox({
        type: "info",
        title: "Import Mac Setup",
        message:
          "An interrupted transfer was rolled back. Your previous ZCode profile was restored.",
        buttons: ["Continue"],
      });
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Import Mac Setup",
      message: safeImportError(error),
      detail:
        "ZCode has not opened this profile. Resolve the transfer recovery issue before relaunching.",
      buttons: ["Quit"],
    });
    app.quit();
    return true;
  }

  if (await exists(pendingPayloadDir)) {
    const { response } = await dialog.showMessageBox({
      type: "question",
      title: "Finish HyperResearch setup",
      message: "Finish setting up HyperResearch for Windows?",
      detail: "Git for Windows and uv are required.",
      buttons: ["Set up", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0 && (await finishHyperResearchSetup(pendingPayloadDir, options.homeDir))) {
      await rm(pendingPayloadDir, { recursive: true, force: true });
    }
  }

  const hasExistingProfile =
    (await exists(join(options.profileDir, "cli", "db", "db.sqlite"))) ||
    (await exists(join(options.profileDir, "v2", "provider_config.json")));
  const shouldOffer = shouldOfferMacSetupImport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    explicitRequest,
    offerDismissed: await exists(offerMarker),
    hasExistingProfile,
  });
  if (!shouldOffer) return false;

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Import Mac Setup",
    message: "Import your ZCode setup from Mac?",
    detail:
      "Select your encrypted .zcode-transfer file. Your existing Windows data will be backed up before replacement.",
    buttons: ["Import…", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    await markOffered(offerMarker);
    return false;
  }

  const selected = await dialog.showOpenDialog({
    title: "Select ZCode transfer archive",
    properties: ["openFile"],
    filters: [{ name: "ZCode transfer", extensions: ["zcode-transfer"] }],
  });
  const archivePath = selected.canceled ? undefined : selected.filePaths[0];
  if (!archivePath) {
    await markOffered(offerMarker);
    return false;
  }

  try {
    await inspectZCodeTransfer(archivePath);
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Import Mac Setup",
      message: safeImportError(error),
      buttons: ["OK"],
    });
    return false;
  }

  if (hasExistingProfile) {
    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "Replace Windows ZCode profile?",
      message: "This will replace the current Windows ZCode profile after making a backup.",
      buttons: ["Back up and replace", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (confirmation.response !== 0) return false;
  }

  const passphrase = await requestPassphrase();
  if (!passphrase) return false;

  const progress = showProgressWindow("Importing your ZCode setup…");
  let importedPayloadDir: string | undefined;
  try {
    const imported = await importZCodeTransfer({
      archivePath,
      passphrase,
      targetProfileDir: options.profileDir,
      targetHomeDir: options.homeDir,
    });
    importedPayloadDir = imported.importedPayloadDir;
  } catch (error) {
    if (!progress.isDestroyed()) progress.close();
    await dialog.showMessageBox({
      type: "error",
      title: "Import Mac Setup",
      message: safeImportError(error),
      buttons: ["OK"],
    });
    return false;
  } finally {
    if (!progress.isDestroyed()) progress.close();
  }

  await markOffered(offerMarker);
  if (importedPayloadDir) {
    if (await finishHyperResearchSetup(importedPayloadDir, options.homeDir)) {
      await rm(importedPayloadDir, { recursive: true, force: true });
    }
  }

  await dialog.showMessageBox({
    type: "info",
    title: "Import Mac Setup",
    message: "Your ZCode setup was imported. ZCode will restart now.",
    detail: "Sign in to Z.ai again after restart. Mac account credentials are not transferred.",
    buttons: ["Restart"],
  });
  app.relaunch({ args: process.argv.filter((arg) => arg !== IMPORT_ARGUMENT).slice(1) });
  app.quit();
  return true;
}
