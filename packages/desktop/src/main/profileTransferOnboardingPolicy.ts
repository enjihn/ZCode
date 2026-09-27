export interface MacSetupImportLaunch {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  explicitRequest: boolean;
  offerDismissed: boolean;
  hasExistingProfile: boolean;
}

/** Existing Windows data is never replaced through an automatic first-launch offer. */
export function shouldOfferMacSetupImport(launch: MacSetupImportLaunch): boolean {
  if (launch.platform !== "win32" || !launch.isPackaged) return false;
  if (launch.explicitRequest) return true;
  return !launch.offerDismissed && !launch.hasExistingProfile;
}
