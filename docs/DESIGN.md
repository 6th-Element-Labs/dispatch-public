# Dispatch design guide

Status: approved for release with the compact folder rail as default. This is the current presentation guide. Older feature specifications remain implementation history; this guide takes precedence for presentation decisions.

## Purpose

Keep email visually primary while the user works with the real Codex harness beside it. Use Apple interaction guidance and existing Tabler controls. Do not introduce a second agent experience or simulate provider outcomes in the working client.

## Navigation

The leading sidebar contains mailboxes only. It defaults to the compact icon-and-label rail. The adjacent toolbar menu selects Compact or Expanded; the sidebar button toggles visibility. Hidden state and the last visible style persist. Expanded mode renders compactly below 1000 pixels and returns to expanded when space is available. A toolbar button shows or hides it; the folder menu remains available when space is limited. Messages, reader and Codex remain independently adjustable, with at least one visible. Mailboxes do not compete with recovery, send history or download utilities for navigation space.

Compact message rows are the default. They retain sender, subject, time, account, unread state and attachment indicators. The density button restores avatars and previews. Grounded AI search excerpts remain visible in either density. Density and sidebar choices persist in this browser.

## Appearance

Dispatch follows the macOS appearance by default. In Dispatch.app, View → Appearance offers System, Light, and Dark; the choice persists in the web client and the shell mirrors it in the menu and the native window theme. The browser build follows the OS. Dark uses neutral near-black greys with hairline borders and the macOS blue accent (`services/web/src/dark.css` retunes the Tabler tokens); do not reintroduce tinted greys. Mail follows the theme. In dark mode the renderer rewrites inline colours the way Apple Mail does (`services/web/src/mail-colors.ts`): near-black and grey text inherits the theme colour, dark saturated colours are lightened until they read, light backgrounds are dropped. Only real layouts (coloured backgrounds, background images, three or more images) keep a light surface, and every message header has a Show in light / Show in dark switch for the cases the rule gets wrong.

## Reading and writing

Use a clear 18px subject, 14px message content, 13px controls and 12px supporting information. Keep the title above actions. Reserve stronger colour for selection and intentional actions. The thread and composer are the only main content surfaces that need cards.

Attachments stay grouped in their conversation. Existing file identities, native open behavior and all-thread attachment disclosure are preserved. Sent messages offer an inline Sent details disclosure that reads the actual mail-owned receipt or verifies the provider's sent record. Receipt details must never be inferred from a draft or fabricated by the UI.

Recovery is a conditional notice near the message list. Restore remains a focused task. Send history and downloaded-mail settings open nonmodal panels from Mail activity so the reader remains usable. Close and Escape dismiss these panels and return focus to their entry point.

## Codex

Use subdued neutral user bubbles and flat assistant responses. Healthy connection state can stay quiet. Work, connection problems and requests for attention have visible text, without requiring the user to interpret a coloured dot. Retain the configured model, reasoning controls and existing full Codex tool surface.

## Current scope

The wireframe's proposed-revision diff and Quick Look were exploration examples. This release retains the current editor revision workflow and native file-opening behavior; it does not ship new editing or file APIs. Test and approve those interaction changes separately if desired.

## References

- [Apple: designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)
- [Apple: sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple: toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Apple: modality](https://developer.apple.com/design/human-interface-guidelines/modality)

## Local preview

Keep the installed Dispatch app running. In this worktree, run:

```sh
DISPATCH_LOCAL_PREVIEW=1 npm --prefix services/web run dev -- --port 8414 --strictPort
```

Open `http://127.0.0.1:8414`. The development-only Vite proxy uses the installed mail and agent services at ports 8411 and 8412. It starts no service, reads no private database and adds no credentials. Mail actions in this preview are real; use synthetic fixtures for automated sends and destructive-operation tests. This origin has its own presentation preferences and local editor recovery storage.

Normal builds and automated tests keep the existing direct service addresses. Opening the local preview does not change the installed app.

## Web pages

Mail links must never replace the workbench. A separate web window has permanent Dispatch-owned navigation, a readable current host and an explicit Return to Mail action. The website cannot draw over or remove these controls. Standard window close and keyboard commands work. Returning preserves the selected email and any unsaved draft; it does not reload mail. Use a real child webview for websites, because many sites reject iframe embedding.
