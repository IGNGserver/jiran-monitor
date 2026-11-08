# Android credential storage

The Kotlin client stores exactly one secret: the Hub connection (`hubUrl`, the legacy owner secret, the revocable `hub_session_token`, and the plaintext-transport opt-in). It never stores provider API keys, OAuth refresh tokens or account cookies — those live in the Hub, encrypted with `JIRAN_SECRET` (see `docs/configuration.md`).

`ConnectionStore` writes that state to an `EncryptedSharedPreferences` file (`token_monitor_hub`) whose key is a `MasterKey` in the Android Keystore (AES-256-GCM key, AES-256-SIV names, AES-256-GCM values). Construction is lazy and happens on `Dispatchers.IO`, because Keystore unwrap and file parsing can block a cold start.

## Why this needs a plan

`androidx.security:security-crypto` is deprecated upstream and is no longer receiving fixes. Two consequences matter more than the deprecation warning itself:

- The library's `EncryptedSharedPreferences` implementation has no key-rotation path, so a future Keystore invalidation (device restore, lock-screen change on some OEMs, app data migration) surfaces as a decryption failure rather than a recoverable state.
- The project cannot adopt a replacement without migrating a live file: existing installs keep a working session token in the current format, and dropping the library without reading that file would silently sign every user out.

## Migration outline

1. **Add a reader for the existing format.** Keep `androidx.security:security-crypto` as a compile dependency until step 4 is released, and read the current file through it exactly once at startup.
2. **Write the new store beside it.** A small `HubCredentialFile` encrypted with an Android-Keystore AES-GCM key (`KeyGenParameterSpec` with `setUserAuthenticationRequired(false)`, `setRandomizedEncryptionRequired(true)`), versioned with a `schemaVersion` field, written to a temp file and renamed atomically. This mirrors the desktop's `credentialStore` contract: verify the new store before removing the old one, and never replace an unreadable store with an empty document.
3. **Migrate on read.** If the new store is absent and the legacy file decrypts, write the new store, verify it by reading it back, then delete the legacy keys. If the legacy file exists but cannot be decrypted, clear it and require re-entry of the Hub URL and token — a decryption failure must never be reported as "not configured", which would look like a fresh install.
4. **Drop the dependency** in a later release, after one release cycle of read-migration, so an interrupted upgrade still finds the legacy file.
5. **Cover the failure modes with JVM tests.** The store must stay free of Compose and of Android framework calls a JVM test cannot run: inject `readFile`/`writeFile`/`cipher` seams (as `HistoryRefreshCoordinator` and `ApkDownloader` already do), and assert version rejection, corrupt-file handling, atomic-rename failure, and "legacy readable → new store verified → legacy removed" ordering.

## Interim rules

- Do not add a second encrypted-preference file for new state; extend `ConnectionConfig` and its single storage contract.
- Do not log `hubUrl`, `secret` or `sessionToken`, and do not include them in crash reports.
- `ConnectionConfig.secret` is legacy: once the Hub issues a session token, `credential` prefers the token and the owner secret is cleared on the next successful save.
