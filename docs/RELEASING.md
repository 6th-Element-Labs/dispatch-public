# Releasing Dispatch

This repository contains release snapshots. Prepare source in the private
canonical repository. Build and publish from the tagged public snapshot.

## One-time Apple setup

The certificate must be **Developer ID Application**. An Apple Development
certificate is not valid for distribution outside the App Store.

1. Create a Developer ID Application certificate in the Apple Developer portal.
2. Install it in Keychain Access.
3. Export it as a password-protected `DeveloperID.p12`.
4. Create an App Store Connect API key with Developer access.
5. Download its `.p8` once and keep an encrypted backup.
6. Record the issuer ID, key ID, and Apple Team ID.

Confirm the signing identity:

```bash
security find-identity -v -p codesigning
```

## Protected GitHub environment

Create a `release` environment with required approval. Add secrets
interactively. Never write their values to a repository file or shell log.

```bash
base64 -i DeveloperID.p12 | pbcopy
gh secret set APPLE_CERTIFICATE --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_CERTIFICATE_PASSWORD --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_SIGNING_IDENTITY --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_API_ISSUER --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_API_KEY --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_API_KEY_P8 --env release --repo 6th-Element-Labs/dispatch-public
gh secret set APPLE_TEAM_ID --env release --repo 6th-Element-Labs/dispatch-public
gh secret set KEYCHAIN_PASSWORD --env release --repo 6th-Element-Labs/dispatch-public
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release --repo 6th-Element-Labs/dispatch-public
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release --repo 6th-Element-Labs/dispatch-public
```

`TAURI_SIGNING_PRIVATE_KEY` and its password are added after updater setup.
Keep a separate encrypted offline backup of that private key.

## Source and tag

1. Verify private `main` and the public export.
2. Export the release snapshot with the exact version.
3. Push the public `Release vX.Y.Z` commit.
4. Wait for public Linux and macOS CI.
5. Create and push the annotated `vX.Y.Z` tag.
6. Approve the protected release environment after checking the source SHA.

The workflow creates a draft release. It does not publish it.

## Draft acceptance

Download both draft DMGs and `SHA256SUMS.txt`. Verify the checksum of each DMG, updater archive, signature, and `latest.json`, then check each mounted app:

```bash
shasum -a 256 -c SHA256SUMS.txt
xcrun stapler validate Dispatch_0.1.2_arm64.dmg
spctl --assess --type open --context context:primary-signature Dispatch_0.1.2_arm64.dmg
codesign --verify --deep --strict /Volumes/Dispatch/Dispatch.app
spctl --assess --type execute /Volumes/Dispatch/Dispatch.app
xcrun stapler validate /Volumes/Dispatch/Dispatch.app
```

Run the DMG checks for both `arm64` and `x86_64` before publication.

On clean Apple Silicon and Intel Macs running macOS 14 or later, test each matching DMG:

1. Mount the DMG.
2. Copy Dispatch to Applications.
3. Launch it from Finder without bypassing Gatekeeper.
4. Verify the missing-Codex state.
5. Connect a real Codex Gmail account.
6. Verify bundled service startup and logs.
7. Complete the updater acceptance procedure in `docs/UPDATES.md`.
   Record archive SHA-256, manifest SHA-256, and the installed version after restart.

Use synthetic or redacted evidence. Do not attach private mail or credentials.

## Publication and recovery

Publish only after every draft check passes. Published assets are immutable.
Never replace a DMG, updater archive, signature, checksum file, or
`latest.json` under an existing version.

If a published release is faulty, create a new patch release. If signing,
notarization, stapling, or updater verification fails, leave the release as a
draft and repair the workflow before creating the next release tag.

If both signed build jobs pass but the draft assembly job fails, repair the
assembly code on public `main`. Run `recover-release-draft` with the original
tag and release workflow run ID. Its protected recovery job checks that the
tag points to that run's source SHA and that both signed build jobs passed. It
then verifies the original artifacts and creates a draft without rebuilding or
moving the tag.
