# Dispatch updates

Dispatch checks one stable channel:

`https://github.com/6th-Element-Labs/dispatch-public/releases/latest/download/latest.json`

The check starts after services start. It does not block mail or Codex. Development
builds do not poll the production channel.

## What you see

1. If an update exists, Dispatch asks before download. Choose **Download** or **Not Now**.
2. After the download verifies, Dispatch asks again. Choose **Install and Restart** or **Later**.
3. Install waits until mail and Codex are idle. If work is still running, Dispatch keeps the current app.
4. A failed check, download, verification, or install leaves the current app usable.

Use **Dispatch > Check for Updates…** to run the same check by hand. A manual
check shows the last or current error. A launch-time network error does not
open a blocking dialog.

## Recovery

- If download or signature verification fails, stay on the installed version.
- If install fails, Dispatch resumes drained services and stays on the installed version.
- If a published release is faulty, install the next patch release. Do not replace assets under an existing tag.

Do not set `dangerousInsecureTransportProtocol` in the production config.

## Two-version acceptance

Run this on both Apple Silicon and Intel Macs. Record redacted evidence in the private release checklist. Do not commit keys, passwords, or real mail.

1. Build and install `0.1.0`.
2. Build `0.1.6`.
3. Create a test `latest.json` with `darwin-aarch64` and `darwin-x86_64` entries.
4. Serve it over local HTTPS or a controlled GitHub draft asset.
5. Use a test-only Tauri config overlay for the endpoint.
6. Verify **Download** and **Not Now**.
7. Verify **Install and Restart** and **Later**.
8. Corrupt one signature and verify rejection.
9. Stop the server. Manual Check for Updates must show a failure. Mail must stay usable.
10. Verify a launch-time failure does not show a blocking dialog.

Record:

- old and new version
- updater archive SHA-256
- manifest SHA-256
- bad-signature result
- offline result
- installed version after a successful restart
