# Dispatch service architecture

Mail owns a durable SQLite command queue for label changes. Its index transaction records the command and applies local flags together. The worker replays idempotent commands in account order; accepted-action and read-state overlays survive restart and partial synchronization. Web holds only the brief optimistic presentation state while mail commits. Send remains a separate, non-replayed operation with uncertain outcomes preserved.

Status: accepted foundation direction

## Decision

Dispatch uses small, independently runnable services. The repository is a delivery container, not a runtime monolith.

```text
Browser or Tauri WebKit
        |
        +---- dispatch-mail :8411
        |         owns message and draft projections
        |
        +---- dispatch-agent :8412
                  owns codex app-server lifecycle
                            |
                            +---- codex app-server over JSONL stdio
                                      |
                                      +---- installed apps/connectors
```

## Boundaries

### Web

`dispatch-web` owns presentation state only. It does not infer mail priority, synthesize agent results, hold credentials, spawn processes, or read provider storage.

### Mail

`dispatch-mail` owns browser-facing conversation, message, and draft view models plus the durable Gmail SQLite index. It calls the agent service's typed Gmail adapter, paginates the Inbox, Unread, Sent, Drafts, Spam, Trash, and archive-query streams for every connector account, atomically replaces each completed account snapshot, removes disconnected accounts, groups messages by account plus Gmail thread ID, and converts Gmail headers and MIME parts into safe view models. It owns All, Unread, and Read filter semantics. An accepted read-state write stays on the index until a later Gmail snapshot reports the same unread value. Demo mail is available only through the explicit development setting. Gmail writes remain guarded by Codex approvals. The six folder lists are indexed. Mail does not serve Sent, Drafts, Archive, Spam, or Trash from a one-page live fetch.

The index bootstraps in the background. Full paginated synchronization runs every six hours, with bounded head refreshes between full scans. Index reads never wait for provider synchronization. The API exposes sync state, timestamps, indexed-message count, draft revisions, and failures. A repeated page token or pagination beyond the safety limit fails the sync instead of truncating it silently.

On macOS, the Gmail index is stored under `Library/Application Support/Dispatch`, outside the source repository and its Dropbox synchronization. `DISPATCH_MAIL_DB` can set an explicit deployment path. Opened attachments are written under `Library/Caches/Dispatch/attachments`. Mail then calls the OS default app for that file (`open` on macOS). Browser responses are paginated so the client does not render the full indexed mailbox at once.

### Agent

`dispatch-agent` is the only service that starts and communicates with Codex App Server. It exposes a small HTTP and server-sent-event adapter for account state, installed apps, threads, turns, and streamed items. It does not implement a model loop.

The agent renews a rejected first-party connector login through Codex's supported `account/read` token refresh. Concurrent failures share one refresh, with a 30-second backoff. Only rejected Gmail reads get one retry; sends and draft mutations are never replayed. Agent-driven tool failures also renew the login for subsequent operations without replaying the conversation. Google grant failures and other provider errors remain visible. Dispatch's internal create/update, attachment and conflict-choice tools use explicit per-tool approval for user-authorized unsent editing, including older chats with a `never` approval policy; send and global Codex policies are unchanged.

Installed builds enable agent-owned Codex runtime updates. The native shell locates the current desktop binary for immediate startup. Agent checks the official `@openai/codex` npm stable release at startup and every six hours, verifies the platform package's SHA-512 integrity, and stages the complete runtime under `Library/Application Support/Dispatch/codex-runtime/<version>`. Downloads have bounded lifetimes and cannot change the active executable. Only an idle agent (no active chat, approval, service request, or pending RPC) replaces App Server. New requests wait for initialization; failed startup restores the previous executable and records the rejected version. The active pointer changes atomically after successful initialization. Existing thread bindings survive, connector caches are invalidated, and the UI reconnects and refreshes its model list. Update failures appear in agent health and logs and retry after fifteen minutes. `DISPATCH_CODEX_AUTO_UPDATE=0` disables downloads; explicit native `DISPATCH_CODEX_COMMAND` overrides and development builds stay pinned by default. Auth, user configuration, and Codex history remain owned by Codex.

The agent adapter also exposes the installed Gmail draft, label, and attachment tools. `dispatch-mail` owns their application commands and projections; the browser remains presentation-only. Chat threads inherit the user's Codex model and installed Gmail MCP settings, with execution permissions selected in Dispatch. `GET /v1/models` reads that same effective config through App Server `config/read` from the Dispatch Codex workspace and uses it as the picker default. The browser does not parse `config.toml` and does not write it. Their working directory is `Library/Application Support/Dispatch/codex-workspace`, not the Dispatch repository, so repository-level agent instructions do not bind the email assistant. Codex thread history, steering, and interruption map directly to App Server `thread/read`, `turn/steer`, and `turn/interrupt`.

`dispatch-agent` owns a durable map from an unbound key or `accountId` plus Gmail `threadId` to a Codex App Server thread id. The map is stored under `Library/Application Support/Dispatch/codex-bindings.json`. `DISPATCH_CODEX_BINDINGS` can set an explicit path. The browser caches that map and persists the current pane thread id. After an agent-service restart, the browser asks agent for the current key, then resumes that App Server thread before reopening the event stream. If App Server is temporarily unavailable, the browser shows `Reconnecting` and retries. It does not report a disconnected stream as connected.

## SimpleMark reuse

The foundation reuses SimpleMark's established choices rather than its product domain:

- Vite and strict TypeScript.
- WebKit-compatible HTML and CSS.
- restrained native-window visual language;
- rendered-document typography;
- explicit light and dark themes;
- sanitization before rendering provider HTML;
- thin platform composition;
- browser acceptance tests;
- private canonical repository plus public verification sandbox.

The source reference inspected for this bootstrap was SimpleMark `8a38e012089dd5b81a71a176056134d0a6d68dda`.

## Local transport

Release macOS builds now use two per-user launchd jobs (`com.taikun.dispatch.mail` and `com.taikun.dispatch.agent`). Runtime code and the bundled Node executable are copied atomically into `Library/Application Support/Dispatch/runtimes/<content-hash>`. The interface attaches to owned healthy jobs and does not terminate them on Quit. Each service reports its runtime ID and active operations through `/v1/runtime`; an idle drain stops new mutations before a version change. Active tasks defer upgrades until they finish. Development sidecars retain their parent watchdog and stop with the development shell.

The mail-owned companion SQLite store also persists confirmed draft projections. Indexed Drafts reads do no Gmail I/O; coalesced metadata reconciliation advances a draft revision watched by the UI. Cached editor opens return immediately with their confirmation time, followed by a guarded live refresh. The browser still owns only unsaved editor checkpoints and never reads the mail database.

Browser development uses localhost HTTP and SSE. The Tauri shell serves the built web client as `tauri://localhost`. Staging packages compiled services, locked production dependencies, and the pinned Node runtime. Release builds register or attach to the versioned background jobs described above; development runs use parent-owned sidecars. The shell validates service identity and never kills an unknown port owner. It locates the installed Codex executable, writes logs to `~/Library/Logs/Dispatch`, and draws native menus from web-owned command definitions. It owns no mail or agent business logic.

Mail and agent read `DISPATCH_ALLOWED_ORIGIN` for their CORS origin. The default is the browser dev origin `http://127.0.0.1:8410`; the shell passes `tauri://localhost`. Codex App Server remains on its supported local `stdio` transport.

## Failure behavior

Mail can optionally own a Google read-only history transport alongside the existing
Codex Gmail connector. It requires a Dispatch Desktop OAuth client plus explicit
per-account Google consent; without those, existing installations continue connector
sync. Baselines, changed metadata, permanent deletions and string history checkpoints
commit atomically in the mail index. Expired history restarts a safe baseline. PKCE
and verified account identity precede Keychain storage. Account backoff and pending
local action overlays remain authoritative. Mail activity offers an explicit return
to connector sync, persisted per account. Codex, sending and draft commands retain
their current paths. See [Gmail sync setup and release gates](GMAIL_SYNC.md).

`POST /v1/sync` accepts a refresh request with HTTP 202. Optional reasons `wake` and `foreground` let mail replace obsolete read-only scans. Mail uses a suspension-gap clock, an abortable sync context, bounded scan lifetimes, and a monotonic mailbox revision. Async-local cancellation applies only to that scan's provider reads; user draft/send operations retain their own lifetime. The browser watches mailbox revisions independently of overall sync success, so one account's failure cannot hide another account's new mail.

- Mail failure leaves the mail panel in a visible failed state.
- Cached mail is labeled with its age while a refresh is active. A failed refresh keeps the provider error visible and never presents stale data as current.
- Missing or invalid provider fields fail normalization instead of silently becoming read, empty, or current values.
- Agent failure leaves email readable and shows Codex as unavailable.
- App Server restart does not fabricate successful turns.
- Demo mail is visibly labeled and never presented as Gmail evidence.


### Internal mail controls

Agent owns the per-installation `Library/Application Support/Dispatch/codex-execution.json`
preference (`{"version":1,"mode":"full-access"}` or `"workspace"`). Missing preferences use full
access, the product default. Full access supplies `approvalPolicy: never` and the full-access sandbox
on every user-facing thread start, resume and turn. Workspace supplies `on-request` and a workspace
sandbox, including the turn-level policy so switching an already loaded chat actually changes its
permissions. It never changes global Codex configuration or blindly accepts pending approval requests.
Reapplying the preference prevents runtime upgrades and restored threads from silently returning to
read-only defaults. Malformed preferences fail visibly before work starts; managed runtime restrictions
remain authoritative. `GET /v1/execution-preferences` reports the saved choice;
`PUT /v1/execution-preferences` validates and atomically saves it with owner-only permissions.
Writes are serialized; the web control displays only the confirmed result. Internal connector operation
threads keep their independent read-only policy. Changes take effect at the next user turn.

The agent service exposes a stateless local MCP endpoint at `/mcp/dispatch-mail` using the MCP TypeScript SDK. It is a transport adapter over the mail service’s existing HTTP commands; it owns no mail records and does not call a second model loop. Codex receives the endpoint as a per-thread configuration override on start and resume, alongside the user’s existing MCP servers. Header-only draft corrections use a partial mail command so omitted recipients, the MIME body, and attachments are preserved. Tool errors are returned as failures; a send reports success only with Gmail’s message ID.


### Recovery, send receipts, and downloaded bodies

Mail owns a companion SQLite store at `${DISPATCH_MAIL_DB}.local` (or beside the default index). WAL and FULL synchronization preserve send intent and acknowledgements. In-flight sends become unknown after restart; pre-send preparation becomes failed. Verification reads the Gmail Sent message and cannot downgrade a verified receipt. The optional internal MCP receipt reader and the HTTP receipt API use this same owner. Agent forwards completed Gmail send identities over HTTP even when no browser stream is attached.

The same mail-owned store caches full conversation projections and download progress. The metadata index remains the mailbox list authority. Explicit downloaded reads bypass Gmail; transient read failures can return an explicitly dated downloaded copy. Missing, revoked, or unauthorized remote identities are not hidden behind cached success. Download jobs are interrupted on restart and can be started again without fetching unchanged complete copies.

Web owns the unsaved editor outbox as presentation state: independent synchronous localStorage records per draft and revision, plus IndexedDB bytes committed before adding files. Revision acknowledgments are independent durable tombstones; cleanup cannot erase a later checkpoint from another window. The older shared recovery array migrates only after all valid entries have been copied. This is not a second writer of Gmail draft records. Save completion adopts Gmail identity while preserving newer editor content and file changes. Gmail edit locks include the account identity.

Mail indexes downloaded message bodies with SQLite FTS5 in the same transaction as their cached conversation. Offline search applies account and folder filters before returning full-body matches. Thread reads supplement the connector's capped response with missing indexed message IDs using at most four concurrent reads. Without an authoritative remote total, a response that reaches the 100-message cap remains explicitly partial. Partial reads cannot replace a previously complete cache or count as a completed mailbox download.

The collapsed thread attachment workspace checks local file coverage without fetching Gmail bytes. Download attachments is an explicit command with bounded concurrency and per-file retry. File caches use account/message/attachment identities, hashed path segments, and manifests with size and SHA-256. Bytes and manifest are staged and synced before atomic publication. Invalid, interrupted, or ambiguous pre-v2 cache entries are fetched again; zero-byte files are valid.

### Web navigation composition

The shell creates the mail window with navigation and new-window guards. It keeps the configured local mail entry point loaded and routes HTTP(S) pages to a separate native window. That window contains a local `browser.html` toolbar, owned by web, and a separate remote child webview. Tauri's multiwebview API is enabled for this composition. Window resize events keep the remote view below the toolbar.

Only mail views (`main` and message windows) may request a new web link. Only the local `link-toolbar` webview may invoke browser state/action commands; `link-content` has no capabilities. Command handlers additionally validate caller label and local URL. The remote view rejects navigation into local application documents. macOS Back and Forward use WKWebView history through native calls. The shell's Navigate menu provides controls independently of either page. Closing the viewer focuses the existing mail window and does not recreate it or restart services.

### Message windows

Double-clicking a conversation, or choosing Open in New Window, opens it in its own native window, as in Mail. Only `main` may call `open_message_window`. The shell validates and URL-encodes the conversation, thread, account and mailbox into the local page's query. It gives the window the mail window's chrome and navigation guards, and focuses an existing window for the same conversation instead of opening another. Message windows (`message-*`) have their own capability: drag, zoom and close themselves, open web links, context menus and appearance; no Dock badge and no further message windows. Closing the mail window closes its message windows.

The web client reads the query and runs in message-window mode. It shows the reader only (Codex opens on demand), never saves the main window's layout, and does not start Gmail refreshes, folder counts, the Dock badge or first-run setup. It follows its conversation through the mail service's local index and rereads it only when a message arrives or leaves. Drafts also open in message windows. The main editor checkpoints its fields and attachment bytes, then releases its edit locks and passes only the recovery key in the local window URL. The draft window restores that checkpoint and claims the existing edit locks. Background saves skip a draft during transfer and while another window edits it; blocked pop-ups restore the source editor. The rich editor renders sanitized Markdown and serializes user formatting back to the existing mail contract, retaining the exact source until an edit occurs. Moving the conversation out of its mailbox closes the window; the main window drops the row and offers Undo, told over a `BroadcastChannel`.

Every window shares local draft recovery. The window editing a draft holds a Web Lock for the draft's local recovery key and Gmail draft id. Other windows do not open that draft, and background sync skips its local copy until the lock is released, so an older checkpoint cannot overwrite newer edits in Gmail. Only the main window saves drafts that no window is editing.

### Native service lifetime

The shell supplies its PID to its own mail and agent children. Each service watches that PID and the parent's stdin pipe, shutting down if its owner disappears. The pipe also handles PID reuse. Direct standalone service runs without this marker are unchanged. Agent removes the ownership marker from the Codex child environment and terminates that child on service shutdown, escalating after a bounded grace period.

On startup the shell waits up to five seconds for exiting services to release their ports. It never kills an unknown listener. This prevents an abruptly closed app from leaving orphan services that block its next launch. Normal service shutdown closes HTTP connections and has a bounded exit deadline.


### Durable Codex draft saves

`POST /v1/draft-saves` accepts an unsent create or partial update. Codex supplies a stable creation UUID, reused across tool retries even after the first save has finished. Mail commits the command and editor projection to its SQLite outbox before returning HTTP 202. `syncState: pending` means local durability only; `failed` retains a rejected command for correction or discard. Pending drafts use `queued-` identities in the normal Drafts folder. After an authoritative Gmail read confirms headers, body, and requested attachment bytes/removal, the queued identity resolves to the real Gmail draft with `resolvedFromDraftId` and no `syncState`. The editor adopts that identity without replacing newer typing; its Codex binding follows the draft.

The mail worker persists provider acknowledgments before verification, uses the existing MIME Content-ID marker for uncertain creates, and keeps unconfirmed intents across restarts. An HTTP 5xx can follow a successful write and never authorizes a second create. Known token revocation or rate-limit rejection can retry after recovery; other uncertain creates must first find their original marker. Updates merge only supplied fields with an authoritative remote draft; header-only updates preserve MIME. Cancellation hides the local draft immediately and persists exact-ID cleanup, including when create was in flight. Pending draft saves count as active runtime work, and an idle runtime drain pauses the queue until service resume. Sends never enter this queue.

Draft saves and label actions use separate bounded pools of account workers (four accounts per pool), ordered within each account. Workers select live records and recheck revisions and cancellation after provider reads; an old claim cannot restore a newer or discarded job. Runtime drain stops new claims and counts active action and draft work.

`dispatch_mail.attach_files` supplies an operation UUID that the caller reuses for uncertain retries. Mail persists the append intent and file bytes before any Gmail request, including on queued creation IDs. The same draft worker merges appends with editor fields, preserves unchanged MIME and CID references, and verifies bytes before reporting confirmed files. Pending means durable local acceptance. Successful operation IDs remain with the draft job for retry deduplication.

Editor saves can supply their original remote baseline. Mail compares changed fields against the latest Gmail draft, merges disjoint edits, and stops on a same-field conflict while retaining both versions. The affected editor offers Use Gmail version and Keep my edits with an expected queue revision. Codex can submit the same choice through `resolve_draft_conflict`. Mail archives both snapshots before applying the choice. This is read-before-write conflict detection: the installed connector exposes no conditional Gmail update, so a remote edit between the check and write cannot be excluded.

The supported connector inventory exposes search pagination, not Gmail history checkpoints. Sync retains bounded head checks and complete-stream reconciliation; repeated token cycles and incomplete scans fail without reconciling missing mail as deleted. A history adapter or direct OAuth transport requires a supported provider capability or Dispatch-owned OAuth registration and is not implied by these repairs. Codex App Server remains the agent harness and connector transport.

If managed Codex login renewal fails, the mail-owned projection exposes `reconnectRequired`. The Reconnect control starts App Server's `account/login/start` and opens its official OAuth URL in the system browser; App Server owns the localhost callback. Normal worker retries resume saving after sign-in. Manual refresh or wake can retry pending saves immediately. Browser recovery remains responsible for typing that has not yet been accepted by mail.
