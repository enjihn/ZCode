import assert from "node:assert/strict";
import test from "node:test";
import { shouldOfferMacSetupImport } from "../src/main/profileTransferOnboardingPolicy.js";

test("a new packaged Windows profile receives the first-launch import offer", () => {
  assert.equal(
    shouldOfferMacSetupImport({
      platform: "win32",
      isPackaged: true,
      explicitRequest: false,
      offerDismissed: false,
      hasExistingProfile: false,
    }),
    true,
  );
});

test("ordinary launches do not interrupt existing profiles or repeat a dismissed offer", () => {
  for (const override of [{ hasExistingProfile: true }, { offerDismissed: true }]) {
    assert.equal(
      shouldOfferMacSetupImport({
        platform: "win32",
        isPackaged: true,
        explicitRequest: false,
        offerDismissed: false,
        hasExistingProfile: false,
        ...override,
      }),
      false,
    );
  }
});

test("explicit Windows import request reopens the flow without affecting other platforms", () => {
  assert.equal(
    shouldOfferMacSetupImport({
      platform: "win32",
      isPackaged: true,
      explicitRequest: true,
      offerDismissed: true,
      hasExistingProfile: true,
    }),
    true,
  );
  assert.equal(
    shouldOfferMacSetupImport({
      platform: "darwin",
      isPackaged: true,
      explicitRequest: true,
      offerDismissed: false,
      hasExistingProfile: false,
    }),
    false,
  );
});
