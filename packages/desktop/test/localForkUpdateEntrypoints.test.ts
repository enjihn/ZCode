import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { PlatformChannels } from "../../shared/src/channels.js";

// tsx runs outside Vite/tsup, so provide the production build defines before importing main.
Object.assign(globalThis, { __ZCODE_ENV__: "production", __ZCODE_PRODUCT_FLAVOR__: "production" });

const calls = { check: 0, feed: 0, ipc: 0, prompt: 0 };
const updater = {
  checkForUpdates: async () => {
    calls.check += 1;
  },
  setFeedURL: () => {
    calls.feed += 1;
  },
  on: () => {},
};
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

mock.module("electron", {
  exports: {
    app: { isPackaged: true, getVersion: () => "3.14.3" },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
    ipcMain: {
      handle: () => {
        calls.ipc += 1;
      },
      on: () => {
        calls.ipc += 1;
      },
    },
    Menu: { getApplicationMenu: () => null },
  },
});
mock.module("electron-updater", {
  exports: { default: { autoUpdater: updater }, CancellationToken: class {} },
});
mock.module(new URL("../src/main/logger.ts", import.meta.url), { exports: { logger } });
mock.module(new URL("../src/main/manifestUpdateProvider.ts", import.meta.url), {
  exports: { getElectronReleasePlatform: () => "darwin", ManifestUpdateProvider: class {} },
});
mock.module(new URL("../src/main/forceUpdatePrompt.ts", import.meta.url), {
  exports: {
    showForceUpdatePrompt: () => {
      calls.prompt += 1;
    },
  },
});

const {
  initAutoUpdater,
  checkForUpdateMenuClick,
  getAutoUpdaterState,
  hydratePendingPostUpdateReleaseNotes,
  refreshAutoUpdaterReleaseChannel,
  requestForceAutoUpdate,
} = await import("../src/main/autoUpdater.js");
const { maybeBlockStartupForForceUpdate } = await import("../src/main/forceUpdateGuard.js");
const { ZCODE_PRODUCT_FLAVOR } = await import("../../shared/src/env.js");

test("packaged fork refuses automatic updater initialization even when explicitly enabled", async () => {
  assert.equal(ZCODE_PRODUCT_FLAVOR, "production");
  await initAutoUpdater({ enabled: true });
  assert.deepEqual(calls, { check: 0, feed: 0, ipc: 0, prompt: 0 });
  assert.deepEqual(getAutoUpdaterState(), { kind: "idle", enabled: false });
});

test("stale official update state is ignored without changing saved settings", async () => {
  let settingsReads = 0;
  let settingsWrites = 0;
  await hydratePendingPostUpdateReleaseNotes({
    get: async () => {
      settingsReads += 1;
      return { pendingPostUpdateReleaseNotes: { version: "999.0.0" } };
    },
    update: async () => {
      settingsWrites += 1;
    },
  } as Parameters<typeof hydratePendingPostUpdateReleaseNotes>[0]);
  assert.equal(settingsReads, 0);
  assert.equal(settingsWrites, 0);
  assert.deepEqual(getAutoUpdaterState(), { kind: "idle", enabled: false });
});

test("changing preview-update preference cannot reach the official feed", () => {
  refreshAutoUpdaterReleaseChannel(true);
  assert.equal(calls.check, 0);
});

test("manual update entry does not reach the official feed", () => {
  const sent: Array<[string, unknown]> = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) },
  };
  checkForUpdateMenuClick(window as Parameters<typeof checkForUpdateMenuClick>[0]);
  assert.deepEqual(sent, [[PlatformChannels.UpdateCheckResult, { kind: "dev-skipped" }]]);
  assert.equal(calls.check, 0);
});

test("direct force-update request is rejected without an updater check", () => {
  const states: unknown[] = [];
  requestForceAutoUpdate((state) => states.push(state));
  assert.deepEqual(states, [
    { kind: "dev-skipped", message: "official updates disabled for this build" },
  ]);
  assert.equal(calls.check, 0);
});

test("remote minimum-version gate does not fetch or block fork startup", async () => {
  let fetched = false;
  let blocked = false;
  const result = await maybeBlockStartupForForceUpdate({
    locale: "en-US",
    logger,
    fetchRemoteConfig: async () => {
      fetched = true;
      return { forceUpdate: { minimalVersion: "999.0.0" } };
    },
    onBlocked: () => {
      blocked = true;
    },
  });
  assert.deepEqual(result, { blocked: false });
  assert.equal(fetched, false);
  assert.equal(blocked, false);
  assert.equal(calls.prompt, 0);
});
