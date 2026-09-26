import assert from "node:assert/strict";
import test from "node:test";
import { shouldUseOfficialDesktopUpdates } from "../../shared/src/env.js";
import { shouldShowDesktopUpdateEntry } from "../../ui/src/lib/desktopUpdateMenu.js";
import { resolveDesktopProductIdentity } from "../scripts/desktop-product-identity.mjs";

test("the local fork keeps the production install identity and disables official updates", () => {
  const productionEnv = { ZCODE_ENV: "production" };
  const identity = resolveDesktopProductIdentity(productionEnv);
  assert.equal(identity.flavor, "production");
  assert.equal(identity.appId, "dev.zcode.app");
  assert.equal(identity.productName, "ZCode");
  assert.equal(shouldUseOfficialDesktopUpdates(identity.flavor), false);
  assert.equal(shouldShowDesktopUpdateEntry(identity.flavor), false);
});

test("official updater and update entry remain disabled for preview identity", () => {
  const identity = resolveDesktopProductIdentity({
    ZCODE_ENV: "production",
    ZCODE_PREVIEW_IDENTITY: "1",
  });
  assert.equal(identity.flavor, "preview");
  assert.equal(shouldUseOfficialDesktopUpdates(identity.flavor), false);
  assert.equal(shouldShowDesktopUpdateEntry(identity.flavor), false);
});
