# EA daily briefing and automatic To-dos

Dispatch has two distinct work pages. EA is a saved morning newspaper. To-dos is
continuing work across emails, people, topics and imported calls. The approved
requirements are in [EA_TODOS_SCOPE.md](EA_TODOS_SCOPE.md).

## Ownership and defaults

Work is an independent localhost service on 8413. Its SQLite store owns tasks,
decisions, informative topic updates, review jobs/checkpoints, transcripts, change
history, settings and briefing editions. Mail owns canonical message evidence and
its transactional change feed. Agent owns completed-chat delivery and calls the
actual Codex App Server. Web renders those HTTP projections. No service reads
another service's database or private Codex session files.

Automatic review defaults to all connected accounts and the last 90 days of
**indexed** email. Inbox, Sent and Archive are eligible; drafts, Spam and Trash are
excluded. Coverage is explicitly indexed mail, not a claim that every Gmail body
has already downloaded. The review window, selected accounts, important contacts
and topics, automatic review and local briefing time are configurable.

The default morning edition is prepared at or after 8 AM local time while Dispatch
runs. A closed or sleeping app prepares after launch/wake; there is no cloud job
or promise of an edition while the device is off. Existing saved work and editions
remain readable when Gmail or Codex is offline.

## Durable automatic review

Mail notices are committed in the same transaction as indexed message changes.
Agent journals completed bound email/contact/topic turns and seeds bindings after
restart to recover missed completion delivery. Work commits queued jobs and its
source cursor together. Review runs on launch and checks changes every 30 seconds,
including while a longer inference runs. New mail, completed chats and transcript
imports take priority over initial history review.

Jobs survive restart and retry with a bounded delay. Failures and pending counts
stay visible on the work pages. Pause cancels active work without advancing a source
fingerprint. Unchanged evidence skips inference. Large sources are segmented with
stable positions and overlap, then reviewed in small bounded batches. All proposals
for a source job are validated and committed together; a failed later batch does
not partially accept earlier proposals.

Each inference uses an ephemeral thread and structured output in the existing
Codex App Server, using the configured model with its lowest supported normal
reasoning effort. Extraction has no shell, apps, web or MCP action tools. It yields
to interactive Codex. The user's chat model, effort and access settings stay intact.
Normal email service requests never wait for a work inference.

## To-dos and continuity

Contacts are formal normalized email addresses within an account. Display names do
not merge identities. Topics and obligations have stable account-scoped IDs. The
model receives related existing work so a new subject or weekly meeting can continue
an obligation. Similar titles alone do not merge separate deliverables.

Work rejects mismatched accounts, unsupported contacts/owners, invalid calendar
dates, unknown existing IDs and quotes absent from their sources before committing.
Explicit commitments remain separate from suggestions. Unknown owners and dates
stay unknown. Only fulfillment evidence or a user action marks a task done; a
promise or absence from this week's discussion is not completion.

Accepted records and source fingerprints carry extraction version 2. A version change queues prior jobs for review without losing human corrections.

User changes protect their edited fields. Done, Snooze and Dismiss survive future
review. Renaming alone still allows supported completion. Revision checks prevent
stale writes; Undo restores the prior action. A source trail records changes and
exact evidence. Removed message evidence is retained and marked unavailable without
erasing work or implying completion.

To-dos supports All, Mine, Waiting, Done, Snoozed and Dismissed, plus contact/topic
views. Selecting a work item opens its actual current record, not an editable stale
briefing snapshot. Source links open email, completed Codex history or a transcript
passage. Draft follow-up opens the real unsent editor and asks Codex to populate it.
It does not send automatically. Email, Contact and Topic keep separate Codex chats;
new email chats can receive relevant saved work for the same people.

## Calls

Import TXT, VTT or SRT through either work page. Choose the mail account, title,
meeting time and participant addresses. Optional confirmed speaker mappings connect
names to email addresses. Unmapped speakers remain unknown owners; a participant
list alone does not prove who said “I will.” Subtitle evidence links to its cue and
available timestamp. Plain text retains its supplied text without invented timing.

The same filename and meeting time identify a corrected import. Stable cue/source
IDs and content revisions avoid duplicate imports and reconcile continuing work.
Import failures keep the entered fields and chosen file so the user can retry.

This version does not fetch Google Meet/Otter transcripts, record audio or join
calls. Those provider capabilities require separate credentials and scope.

## The daily newspaper

EA opens a dated edition with At a glance, Needs your attention, Topic updates,
Waiting on others, Today and next, and Since your briefing. Entries cite validated
work and its original evidence. Informative updates can appear without creating a
to-do. Attention ranking prioritizes explicit commitments, due work and marked
important people/topics; the model explains relevant developments.

A saved edition is immutable. Later reviewed changes, including completion, appear
under Since your briefing. Create revised edition preserves the original. Recent
editions and revisions are selectable; the date picker accesses older saved days.
The first edition may use the work reviewed so far during backfill. Its pending,
failed and synchronization coverage remains explicit; it never says a partial
review is complete. A failed generation leaves the last completed edition intact
and exposes Retry. Long or busy work queues do not erase existing editions.

The model receives a bounded selection (up to 120 work records and 150k characters)
and can create up to 80 entries. Selection counts show when more work exists than
was considered. Saved records retain full accepted evidence, even when model input
uses short excerpts. Dates and scope remain visible offline.

## HTTP contracts

JSON contracts are in `contracts/work.v1.json` and `contracts/work-inputs.v1.json`.
All endpoints are localhost only; bounded failures carry `error` and `detail`.

| Owner | Endpoint | Behavior |
| --- | --- | --- |
| Mail | GET /v1/work/changes?cursor=&since=&limit= | Durable paged changes, availability, account catalog and mail-sync coverage |
| Mail | GET /v1/work/sources?account=&thread= | Complete eligible canonical message evidence |
| Agent | GET /v1/work/changes?cursor= | Durable bound-discussion changes |
| Agent | GET /v1/work/discussions?account=&chat= | Completed evidence from a verified account binding |
| Agent | GET /v1/work/sources | Related completed email/contact/topic chat evidence |
| Agent | POST /v1/work/extract | Structured proposed work; 429 when foreground Codex needs priority |
| Agent | POST /v1/work/briefing | Structured cited newspaper text |
| Work | GET /v1/work | Ranked tasks, decisions, updates, people/topics, coverage and settings |
| Work | GET /v1/work/context | Bounded saved context with total/returned/limited counts |
| Work | GET /v1/work/items/:id | Current record and change history |
| Work | POST /v1/work/items/:id | Revision-checked user changes |
| Work | POST /v1/work/items/:id/undo | Revision-checked undo |
| Work | GET or POST /v1/work/settings | Read/change review settings |
| Work | POST /v1/work/transcripts | Validate/store/enqueue a transcript without awaiting its extraction |
| Work | GET /v1/work/transcript?account=&import= | Original import and canonical timestamped segments |
| Work | GET /v1/work/briefing?edition=&date= | Saved edition, history, later changes and current coverage |
| Work | POST /v1/work/briefing | Start a revised edition, return 202 immediately |
| Work | POST /v1/work/scan | Refresh/retry; more:true expands history by 90 days |
| Work | POST /v1/work/pause | Stop automatic review and cancel active inference |
| Work | POST /v1/work/analyze | Queue a priority review of one account/thread; return 202 immediately |

The internal Dispatch MCP `list_work` and `update_todo` use these same work APIs.

## Qualification and limits

Automated tests cover restart/cursor recovery, source revision races, continuation
across email and two meetings, distinct same-title obligations, human overrides,
unknown speakers, malformed subtitles, long-source batching, rollback after a failed
later batch, account isolation, source removal, immutable editions/date history,
newspaper navigation and preserved import inputs.

A controlled **synthetic** benchmark used the actual Codex runtime 0.160.0: 20 email
sources plus five transcript sources, with 50 labelled explicit commitments. It
returned 50 correct commitments (50/50 precision and recall), the expected owners
and dates, three supported later completions, zero duplicate obligations and 47
cited briefing entries. The first oversized one-shot attempt timed out; smaller
batches with lower background effort passed. This is runtime proof for that sample,
not a general accuracy claim about real customer mail. User-labelled representative
email/call review remains necessary before claiming those rates in the field.

An isolated end-to-end test also used the real runtime: automatic email ingestion, two VTT imports through the HTTP intake, one continuing task, explicit completion, three evidence links, two preserved briefing revisions, and foreground interruption returning 429 all passed. This still used synthetic provider evidence.

Native/provider acceptance, exact-commit public CI and the installed remote-main
identity are reported separately in release evidence. Browser fixtures alone do
not prove Gmail delivery or native behavior.
