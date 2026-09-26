# Locally installed fork update policy

## Product rule and identity

The `enjihn/ZCode` desktop build keeps the production ZCode product flavor, bundle ID,
application name, and existing `~/.zcode` and Electron user-data locations. Its installed
binary is updated only from a separately validated build of this fork. An upstream release
must never silently replace it or block startup merely because upstream raised a minimum
version. This applies to packaged builds and local development runs.

## Owner and interface

The shared build policy `OFFICIAL_DESKTOP_UPDATES_ENABLED` owns whether official desktop
updates are available. The desktop main process applies it to updater initialization,
mandatory-update admission, menu commands, and direct update requests. The renderer only
derives visibility from that policy; it does not maintain another update-enabled state.
The policy is deliberately fixed for this fork rather than read from settings or an
untrusted remote response. Product flavor still determines app identity and data paths.

## Event order and failure semantics

```text
startup -> product identity/data paths -> policy check
                                  |-> disabled: no updater feed or polling
                                  |-> disabled: no remote minimum-version request/gate
                                  `-> create the main window normally
manual menu/IPC request -> policy check -> no official check, download, or install
```

The updater must fail closed even if an update entry point is invoked directly. Disabling
official updates ignores any stale pending official update state without deleting existing
settings or cached data; an accepted fork build
and its installation process own migration and rollback. Other endpoint configuration is
outside this policy.

## Acceptance

- A production-flavor fork build retains the production app ID and name while official
  update capability is disabled.
- Startup does not initialize the official updater or fetch the minimum-version config;
  an upstream minimum version cannot block the main window.
- Automatic checks, manual Check for Updates, and direct force-update requests cannot
  reach the official update feed. Desktop update entries are hidden.
- Preview behavior remains disabled and production endpoint/provider behavior is unchanged.
