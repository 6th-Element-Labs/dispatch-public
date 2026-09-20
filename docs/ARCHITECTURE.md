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

The agent adapter also exposes the installed Gmail draft, label, and attachment tools. `dispatch-mail` owns their application commands and projections; the browser remains presentation-only. Chat threads inherit the user's Codex config (model, approval, sandbox, and installed Gmail MCP). `GET /v1/models` reads that same effective config through App Server `config/read` from the Dispatch Codex workspace and uses it as the picker default. The browser does not parse `config.toml` and does not write it. Their working directory is `Library/Application Support/Dispatch/codex-workspace`, not the Dispatch repository, so repository-level agent instructions do not bind the email assistant. Codex thread history, steering, and interruption map directly to App Server `thread/read`, `turn/steer`, and `turn/interrupt`.

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

`POST /v1/sync` accepts a refresh request with HTTP 202. Optional reasons `wake` and `foreground` let mail replace obsolete read-only scans. Mail uses a suspension-gap clock, an abortable sync context, bounded scan lifetimes, and a monotonic mailbox revision. Async-local cancellation applies only to that scan's provider reads; user draft/send operations retain their own lifetime. The browser watches mailbox revisions independently of overall sync success, so one account's failure cannot hide another account's new mail.

- Mail failure leaves the mail panel in a visible failed state.
- Cached mail is labeled with its age while a refresh is active. A failed refresh keeps the provider error visible and never presents stale data as current.
- Missing or invalid provider fields fail normalization instead of silently becoming read, empty, or current values.
- Agent failure leaves email readable and shows Codex as unavailable.
- App Server restart does not fabricate successful turns.
- Demo mail is visibly labeled and never presented as Gmail evidence.


### Internal mail controls

The agent service exposes a stateless local MCP endpoint at `/mcp/dispatch-mail` using the MCP TypeScript SDK. It is a transport adapter over the mail service’s existing HTTP commands; it owns no mail records and does not call a second model loop. Codex receives the endpoint as a per-thread configuration override on start and resume, alongside the user’s existing MCP servers. Header-only draft corrections use a partial mail command so omitted recipients, the MIME body, and attachments are preserved. Tool errors are returned as failures; a send reports success only with Gmail’s message ID.


### Recovery, send receipts, and downloaded bodies

Mail owns a companion SQLite store at `${DISPATCH_MAIL_DB}.local` (or beside the default index). WAL and FULL synchronization preserve send intent and acknowledgements. In-flight sends become unknown after restart; pre-send preparation becomes failed. Verification reads the Gmail Sent message and cannot downgrade a verified receipt. The optional internal MCP receipt reader and the HTTP receipt API use this same owner. Agent forwards completed Gmail send identities over HTTP even when no browser stream is attached.

The same mail-owned store caches full conversation projections and download progress. The metadata index remains the mailbox list authority. Explicit downloaded reads bypass Gmail; transient read failures can return an explicitly dated downloaded copy. Missing, revoked, or unauthorized remote identities are not hidden behind cached success. Download jobs are interrupted on restart and can be started again without fetching unchanged complete copies.

Web owns the unsaved editor outbox as presentation state: a synchronous localStorage record for text and recipient changes, plus IndexedDB bytes for added files. This is not a second writer of Gmail draft records. Each recovery entry remains until its matching editor revision is saved or discarded. Save completion adopts Gmail identity while preserving newer editor content and file changes.

### Web navigation composition

The shell creates the mail window with navigation and new-window guards. It keeps the configured local mail entry point loaded and routes HTTP(S) pages to a separate native window. That window contains a local `browser.html` toolbar, owned by web, and a separate remote child webview. Tauri's multiwebview API is enabled for this composition. Window resize events keep the remote view below the toolbar.

Only `main` may request a new web link. Only the local `link-toolbar` webview may invoke browser state/action commands; `link-content` has no capabilities. Command handlers additionally validate caller label and local URL. The remote view rejects navigation into local application documents. macOS Back and Forward use WKWebView history through native calls. The shell's Navigate menu provides controls independently of either page. Closing the viewer focuses the existing mail window and does not recreate it or restart services.

### Native service lifetime

The shell supplies its PID to its own mail and agent children. Each service watches that PID and the parent's stdin pipe, shutting down if its owner disappears. The pipe also handles PID reuse. Direct standalone service runs without this marker are unchanged. Agent removes the ownership marker from the Codex child environment and terminates that child on service shutdown, escalating after a bounded grace period.

On startup the shell waits up to five seconds for exiting services to release their ports. It never kills an unknown listener. This prevents an abruptly closed app from leaving orphan services that block its next launch. Normal service shutdown closes HTTP connections and has a bounded exit deadline.
