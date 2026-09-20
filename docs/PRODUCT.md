# Dispatch product contract

Status: working read-only foundation

## Job

Keep the email visible while the user works with it through the Codex experience they already know.

## Primary surface

Dispatch has three persistent panels:

1. Messages.
2. Selected email or draft.
3. Codex chat.

The middle reading surface is visually primary. Selection of a Gmail conversation switches the one Codex pane to that conversation’s Codex thread. Each new Compose has a separate durable draft task key. Once Gmail assigns a thread ID, Dispatch associates the existing task with that email. General search and no selection use the unbound task.

All connected Gmail accounts enter one date-ordered queue by default. The user can filter that queue to one account. Message rows show a compact date and time. The rendered message header shows the full date and time.

The queue contains conversations, not duplicate individual messages. A conversation is scoped by Gmail account and Gmail thread ID. Inbox contains only Gmail INBOX members, excluding drafts, spam and trash. All, Unread, and Read filter conversations within the selected mailbox. Unread archived mail remains in Archive and never enters Inbox merely because it is unread.

Selecting a conversation loads the complete Gmail thread with the newest message first. The reader shows the subject on its own row, then the action buttons. A long subject stays on one line and uses an ellipsis. Each message shows sender, address, full date, and time. Repeated quoted history is collapsed by default but remains available through a disclosure.

Selecting an unread Gmail conversation starts a 5-second dwell. If that conversation stays selected, Dispatch marks it read through mail. The row stays unread until mail accepts the command. After mail accepts, the row stays read without Refresh, even if a later thread fetch or Gmail sync still reports unread. Demo conversations do not auto-mark. On the Unread filter, the row leaves the list and the reader stays on that conversation.

An explicit Mark as Unread stays unread when the user reopens that conversation, including after navigating away or restarting Dispatch. Only an explicit Mark Read clears that choice. Live Gmail messages do not display an Offline badge; a saved copy used because Gmail is unavailable is labeled Downloaded copy.

A right-click on a thread row selects that conversation and does not start the dwell. In Dispatch.app the shell shows a native macOS menu of the same reader actions. The browser shows an HTML menu with the same command ids. Mail still owns every Gmail write. A failed native popup is a visible mail error and does not open the page menu.

Unread rows show a blue avatar mark, bold sender and subject, and a light blue background. Read rows use normal weight and dimmer text.

The user can keep one, two, or three panels open. Each panel has an explicit visibility control. At least one panel remains visible. The messages and Codex panel widths are adjustable and persist locally.

## Version-one acceptance

The first useful version lets a user:

1. See real Gmail messages.
   Messages from all connected accounts share one queue.
   The queue groups messages into Gmail conversations and supports All, Unread, and Read filters.
2. Select and safely render one conversation.
3. Ask the installed Codex harness about it.
4. See Gmail connector activity.
5. Open a cited Gmail resource.
6. Create a draft through Codex.
7. Review and edit the draft in the middle panel.
8. Confirm recipients and subject, then send from the Send button, or ask Codex to send that draft through the installed Gmail connector.

The middle panel owns the visible Gmail draft. Recipient, subject, and Markdown body remain editable. Codex creates and revises that same Gmail draft through the installed connector, including attachments. A draft that Codex creates through MCP opens in the middle panel. The user can send from the Send button, or ask Codex to call `gmail.send_draft` or `gmail.send_email`. Autonomous send without a user request remains out of scope.

The Codex picker shows the user's Codex config model and effort until the user picks a different pair in Dispatch. A Dispatch pick stays in this browser only and does not write `config.toml`. Codex restores stored thread turns after reload, shows plans and tool activity, accepts same-turn steering, and exposes interruption. Gmail attachments use their exact parent message and attachment identities. A click on the desktop client asks mail to write the file and open it with the default native app for that extension. The same identities stay in Codex citation context. Inline CID images still load through the existing attachment GET.

Thread rows show a Tabler paperclip when any indexed member has attachments. Once a full thread is loaded, the row and reading header show the exact attachment count. The reading header toggles a collapsed-by-default attachment section. Expanded, it lists every file occurrence newest email first, with filename, size, sender, full date/time, and Go to email. Repeated filenames keep their exact parent message identity. The disclosure state is kept per conversation for the current session.

## Current foundation

The current slice proves the service boundaries, real Codex App Server handshake, installed Gmail connector discovery, paginated Gmail synchronization of Inbox, Unread, Sent, Drafts, Spam, Trash, and the archive query into a durable SQLite index, full MIME retrieval, safe browser rendering, and the browser experience. Sync state, timestamps, progress, and failures remain visible. Demo projections require the explicit `DISPATCH_DEMO_MAIL=1` development setting. A missing Gmail connection is a visible readiness failure and never silently substitutes demo mail. Gmail draft create and update may run from the editor or from Codex tools. Codex may send when the user asks it to use the Gmail connector. The Send button still shows a confirm, then dispatch-mail sends the draft. Inbox, Sent, Drafts, Archive, Spam, and Trash lists read that index. All, Unread, and Read on the default queue still exclude spam and trash.

## Non-goals for the foundation

- IMAP or Outlook.
- Autonomous triage or sending.
- A second agent runtime.
- A second Gmail MCP server.
- A pure SwiftUI rewrite.


## AI result and editor consistency

Attachment context includes its Gmail account, conversation, parent message, and attachment ID. Changing conversations or starting a new message clears it. Prompts wait until Codex is bound to the selected conversation.

A confirmed Gmail draft tool result opens the exact draft and account in the editor. Late responses cannot replace a different selection or newer edits, including edits already saved while the response was pending. A user-edited draft stays in place and the client reports where to find the saved AI version. Connector error results never count as saved or sent. Sending a different draft does not close the active editor.

Transient task-resume failures keep the existing history binding and retry. A new binding is created only for a confirmed missing task. Gmail draft commands retain the strict multipart payload adapter; Codex follows the installed tool schema and the user’s approval policy.


Gmail draft recipient fields accept the connector's string arrays as well as legacy strings. To, Cc, and Bcc survive opening and refreshing a draft. The Send button requires at least one To, Cc, or Bcc recipient and does not save an unchanged Gmail draft first; this preserves the provider's original recipients, formatting, and attachments. A changed draft or account invalidates its pending send confirmation.


Dispatch embeds the full installed Codex experience, not an email-only agent. It adds no model, sandbox, capability allowlist, or send-button-only policy. The user’s normal Codex configuration and permissions remain authoritative. The internal `dispatch_mail` tools provide an optional path to list accounts, read/create/update drafts, and send the saved draft through Dispatch’s mail service. Header-only updates preserve original MIME content and attachments. These tools are configured for new and resumed conversations, and their confirmed results update the visible editor. The visible draft ID, account, recipients, and unsaved state are supplied as context.


## Search with Codex

Typing in Search keeps the instant indexed filter. Enter or the adjacent Tabler sparkles button submits a natural-language search to the existing unbound Codex task. The selected account is the search scope; All inboxes searches connected accounts across mail folders. Unsaved drafts must be saved successfully before navigating into search.

Codex uses its installed Gmail tools to search and read candidate messages, then publishes a result list through `dispatch_mail.show_search_results`. The mail service verifies every account/message identity and quoted body passage before returning a projection. Codex supplies relevance judgments; unread status is not treated as evidence that a question is unanswered.

Results stay in the message list during background sync. Each row shows a highlighted source excerpt and the reason Codex selected it. Clicking a result loads the full conversation, expands the matched messages, and highlights the passage in the reader. Clear returns to the ordinary mailbox. Superseded results cannot replace a newer search. Empty results, failed searches, and missing source evidence remain distinct.


## Everyday reliability

After a suspension gap, the background mail service cancels obsolete read-only scans and requests fresh mailbox heads. Network return and foreground activation also request refresh. This works without an open Dispatch window when macOS resumes the background service; it does not change the Mac's sleep settings. Manual Refresh is accepted immediately and reports progress through sync status. Healthy account results appear as each stream arrives, even if another account is unavailable. Gmail Retry-After remains authoritative. Sends and draft writes are never cancelled or replayed by wake recovery.

Drafts lists are served immediately from the mail index and reconciled with Gmail in the background. Previously saved or opened drafts have a durable mail-owned body cache, so reopening them does not wait for Gmail. Cached editors check for changes asynchronously; that refresh cannot overwrite edits made after opening. A confirmed remote deletion removes an untouched cached editor. Navigation checkpoints unsaved edits locally and leaves remote saves running independently.

Archive, Trash, Spam, Move to Inbox, and read-state commands are committed to the mail owner's SQLite queue with their local state changes before the API accepts them. The UI selects the next row and leaves actions available. Commands replay in order per account after connection failures or restart. Partial provider snapshots cannot undo pending changes. Pending synchronization is shown quietly in Mail activity; local acceptance is not a provider acknowledgement. Sends are never automatically replayed.

Provider Retry-After is shared across the mail service's bounded request lanes and persisted across restart. Mailbox scans cannot block interactive draft saves, and list reads do not start repeated failed scans. Every folder refreshes after synchronization recovers. Draft errors use plain language; local drafts say they are waiting to sync until Gmail confirms the save. Forward opens the same local editor immediately, like Reply.

User edits are saved locally, including To, Cc, Bcc, account, subject, body, and attachment identities. New file bytes are stored before the attachment appears in the editor. New drafts autosave once recipient input is valid; untouched reply templates do not create recovery entries. Pending edits sync automatically in the background after temporary failures, navigation, or restart, using a stable draft identity to avoid duplicate creates. Drafts is one normal list: pending edits replace the matching Gmail row, with no separate local-copy label, recovery banner, or recovery dialog. A confirmed save clears only its own revision. Newer edits remain protected. Permanent save failures remain visible in the editor or affected Drafts row. Draft synchronization never sends mail.

Sent Items is the normal send confirmation. Dispatch keeps durable internal send intent and acknowledgement for recovery, but has no receipt interface. A timeout after sending has an uncertain outcome; show that failure clearly and never automatically resend.

Opening a conversation caches its full message bodies. Offline controls offer Download mailbox for the selected folder and account scope, with progress, cancellation, and partial failures. Use downloaded mail reads only saved bodies and labels their cache time. Undownloaded threads show a clear error. Remote images are blocked in this mode; files are available only if already cached. Bulk download covers message bodies, not all attachment bytes. Users can compose locally while offline, then review and save or send when online. There is no automatic offline send queue.

## Current workbench design

`docs/DESIGN.md` defines the current presentation. Mailboxes use a compact icon-and-label rail by default, with expanded and hidden states remembered locally. Compact message rows are the default. Local unsaved copies belong in Drafts; download controls belong in Mail activity. Sent Items confirms successful sending. Utilities use nonmodal panels.

## Web links

Opening an HTTP or HTTPS link keeps the mail view, selected conversation, draft and Codex session loaded. Desktop links open in a separate web window. Dispatch owns a persistent toolbar with Back, Forward, Reload, Open in Browser and Return to Mail. The toolbar shows the current host. Closing the web window, pressing Command-W, or choosing Navigate → Return to Mail brings the existing mail window forward. Command-[ and Command-] use the page's actual history. Browser development opens links in a separate browser tab.

The main native webview also rejects external navigation and new-window requests, so target=_blank and navigation outside the normal click handler cannot replace mail. Remote pages have no Dispatch capability. The toolbar is a separate local webview; it is never injected into website content. Mailto links open through the system handler.

## Reply responsiveness

On macOS, Quit closes the interface while per-user background services continue Codex work and accepted mail operations. Reopening attaches to those same services. Versioned runtime files keep work valid when Dispatch.app is replaced. Updates drain new operations and wait for existing tasks before restarting; manual Restart Services also refuses to interrupt active work. These services run in the logged-in user session, not in the cloud.

Reply and Reply All open an editable local draft from the already-loaded conversation immediately. Gmail persistence runs in the background, with local recovery kept until the matching save is confirmed. Typing during creation stays in the editor and is saved afterward. Switching conversations does not let a late create response replace the selected thread; recovery learns the saved Gmail draft identity. Repeated clicks while the first create is pending do not create duplicate drafts.

A confirmed draft create, update or discard returns without waiting for mailbox synchronization. The index refresh continues separately.

When the installed connector does not provide draft deletion, Discard resolves the exact Gmail draft message, moves only that message to Trash, and checks that the draft no longer appears in Gmail's draft list. It does not trash the conversation or report success for a rejected per-message result.

Quoted-history folding wraps the actual blockquote/Gmail quote, not its ancestors. New text before or after a quote remains visible, even inside Outlook/Word layout wrappers. Outlook reply-header markers fold only their following siblings in the same container. Reply and forward text is extracted from sanitized source content without adding the UI's disclosure labels.

The thread reader applies the selected mailbox context to raw Gmail thread results. Inbox, Sent and Archive reading exclude unsent drafts, Trash and Spam messages. Explicit Drafts, Trash and Spam views show the matching messages. Subject, latest message, reply source and attachment count are recomputed from that visible set. Downloaded bodies and in-memory views retain the same folder boundary.


## Sending feedback

Sent Items is the normal confirmation that an email was sent. Do not show a receipt window, receipt controls, or automatic success messages in Codex chat. Keep send failures and uncertain outcomes visible. Internal durable send records support recovery and duplicate prevention; they are not a separate user workflow.
