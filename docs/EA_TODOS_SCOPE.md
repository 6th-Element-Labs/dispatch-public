# EA daily briefing and automatic To-dos

Status: approved for execution on 2026-10-05. The as-built behavior and qualification limits are recorded in EA_TODOS.md.
Date: 2026-10-05.
Baseline: Dispatch main `5729d7caa25a36ddb8dfb8a483f6b1a381af649e`.

## The result we want

Open Dispatch in the morning and understand what needs attention without reading
every thread. Open a person or topic and see the commitments that remain open,
even when the conversation moved to a different email chain or weekly meeting.

EA is the daily newspaper. To-dos is the continuing work register. They share
evidence and context, but they are different pages with different jobs.

Normal email stays fast. Reading, replying, sending, deleting and archiving never
wait for extraction or briefing generation.

## Confirmed requirements and decisions still open

The user has requested:

- A daily EA snapshot of emails, topics and what needs attention.
- Automatic task extraction from emails and conference calls.
- Continuing context across email threads, people and recurring meetings.
- People identified by formal email address rather than display name.
- The actual Codex runtime, closely integrated with the existing mail UI.
- Dependable mail behavior and useful actions without repeated approval prompts.

The following defaults were accepted with the instruction to execute this scope:

| Choice | Approved default | Reason |
| --- | --- | --- |
| Briefing time | 8:00 AM in the device's local timezone | One predictable morning edition; configurable |
| Laptop asleep at briefing time | Prepare after wake or next launch | A sleeping or closed app cannot guarantee an on-time edition |
| Email accounts | All connected accounts, individually selectable | Match the existing unified Inbox while retaining account identity |
| Initial email review | Last 90 days, followed by an explicit older-mail review option | Bounded first review with honest historical coverage |
| Task discovery | Automatic for selected sources once enabled | No per-email confirmation or manual scan required |
| Calls | Import existing transcripts first | Provider choice and access are still open |
| Suggestions | Separate from explicit commitments | An inferred idea should not look like an agreed obligation |

The first intake path is TXT/VTT/SRT transcript files. Google Meet and Otter provider connections require a separate authentication and availability check. Live recording and meeting bots remain outside this delivery.

## EA: the morning newspaper

The page opens on a dated edition with its preparation time and source coverage.
It answers “What changed, what needs me, and why?” A quiet day says so plainly.

The edition contains:

1. **At a glance:** a short account of the most important developments.
2. **Needs your attention:** unanswered questions, decisions requested, overdue
   commitments, imminent deadlines and threads that have slipped through the cracks.
3. **Topic updates:** important developments grouped across email threads and calls,
   including informative updates that do not create a task.
4. **Waiting on others:** outstanding commitments, who owns them and when a
   follow-up may be useful. An elapsed interval is not an invented agreed deadline.
5. **Today and next:** explicit due dates and approaching commitments.

Each entry has a short explanation, the relevant person/topic, and links to the
messages or transcript passages that support it. “No reply” considers later Sent
messages and other relevant threads; it is not inferred from unread status alone.
Where Dispatch cannot establish whether the issue was answered, it shows uncertainty.

Useful actions open the source email, open the continuing work, or draft a
follow-up in the real editor. Asking Codex about an entry supplies the cited evidence
and relevant saved context. Briefing generation itself does not send mail or change
mailbox state.

The morning edition stays fixed. New evidence appears in **Since your briefing**
with its own update time, so the newspaper does not silently rewrite itself. The
user can refresh those updates or explicitly create a revised edition. Previous
editions remain available by date; revisions preserve the original edition.

The last completed edition remains readable offline. Its date and coverage remain
visible. An unfinished or failed review must not be presented as a fresh complete
edition. Status belongs on the EA page, with a useful retry action, not in repeated
mail pop-ups.

Attention ranking starts with explicit urgency, overdue/due work, direct requests,
unanswered commitments and meaningful topic changes. The user can mark important
contacts/topics and dismiss irrelevant entries. Ranking must explain why an item
appears. Repeated newsletters and routine updates should not crowd out actual work.

## To-dos: work that survives the next thread or meeting

New email, available call transcripts and completed relevant Codex discussions
are reviewed automatically. The output is structured work, not just a prose summary.

A task records:

- A stable obligation ID, title and short description.
- Account, related people by email address, and stable topic ID.
- Owner, with “unknown” allowed when evidence does not establish one.
- Due date and timezone where known; no guessed date presented as agreed.
- Status: open, waiting, done, snoozed or dismissed.
- Explicit commitment versus suggested action.
- Exact source evidence, source timestamp and links to the relevant email or
  transcript segment.
- Change history, extraction version and protected user edits.

The same obligation continues across replies, changed subjects and weekly meetings.
New evidence attaches to the existing task and can update its status, owner or due
date when supported. A separate later commitment creates a new task. Similar titles
alone are insufficient to merge tasks.

Completion requires evidence that the obligation was fulfilled, or a user action.
“Thanks” and “will do” do not count as completion. Older evidence cannot undo newer
state. Done, snoozed and dismissed choices survive review and restart; a user-completed
task is not reopened automatically. A genuinely new obligation may be offered
separately with its new source.

The page supports All, Mine, Waiting, Done and Snoozed, plus person and topic views.
Selecting a contact or email thread exposes related work across threads, with its
account scope clear. Done, Snooze, Edit, Dismiss and Undo persist locally immediately.
The user can correct extraction without losing the original evidence.

Email, Contact and Topic Codex chats retain their separate conversation histories.
Relevant saved work is supplied as context; it does not mix every chat into one
transcript. A new weekly email can therefore start a new chat that still knows the
person's outstanding work.

## Calls and identity

A transcript source needs a stable meeting/import ID, time, title, participants,
text, available speaker labels and available segment timestamps. Reimporting the
same transcript does not duplicate work. A corrected transcript is a new source
revision and reconciles existing work.

A speaker name is not automatically a verified email address. Use provider-supplied
participant addresses or a user-confirmed mapping; otherwise retain an unknown
owner and the original speaker label. Missing timestamps remain missing rather
than receiving invented precision.

First delivery supports an agreed transcript intake path. Automatic provider
fetching follows only when its authentication and transcript availability are
proved. Live call recording, speech recognition and meeting bots are separate
scope decisions. Calendar events alone do not contain call commitments.

## The shared engine

Reuse Dispatch's existing service ownership:

| Owner | Responsibility |
| --- | --- |
| Mail | Canonical email evidence and durable notices of changed mail |
| Agent | Actual Codex App Server inference and completed chat evidence |
| Work | Ingestion checkpoints/jobs, tasks, decisions, contact/topic context, evidence, ranking and saved briefing editions |
| Web | Render those records and submit typed commands |

A new transcript-provider backend, if required, needs its own bounded service,
credentials, readiness and failure boundary. It exports typed evidence; it does
not write the work database. A file importer can live within the work intake
boundary. No service reads another service's database or private session files.

The processing sequence is:

1. Receive new or changed source evidence through a durable job/checkpoint contract.
2. Retrieve complete evidence and relevant existing work.
3. Ask the existing Codex harness for structured proposed changes.
4. Validate accounts, identities, quotes, dates and existing-task links.
5. Commit valid changes and the reviewed source revision atomically.
6. Build the dated briefing from validated work plus cited topic developments.

Email and transcripts are evidence, not instructions to execute actions. Internal
extraction has no action tools; normal interactive Codex keeps the user's selected
access settings. There is no second agent runtime or continuous free-running loop.

Jobs survive restart. Failed/incomplete sources remain eligible for retry and are
counted in coverage. Unchanged revisions skip model calls. Corrections reprocess the
affected source. Long conversations and transcripts require bounded segments with
stable provenance and complete coverage accounting; silently skipping oversized
threads is not acceptable.

Backfill is resumable and lower priority than new evidence. Work outside the initial
90-day window remains explicitly unreviewed until backfill includes it. Previously
discovered open work persists regardless of the window. Removed or unavailable
evidence must not falsely imply completion or erase a task; retain provenance and
show that its source is unavailable according to the retention policy.

Extraction yields to interactive Codex work and never blocks normal mail requests.
Wake/launch resumes missed work, then prepares the day's edition. Repeated timers,
refreshes and wake events must not create duplicate jobs, tasks or editions.

## Baseline before this scope

The baseline [EA/To-dos implementation](EA_TODOS.md) already has durable work records,
structured Codex extraction, evidence validation, human overrides and contact/topic
chat bindings. Review is opt-in and initially considers 30 recent indexed threads
per account, expanded manually. Once enabled, it polls every five minutes.

The current EA page displays the same work records as To-dos. There is no saved
daily newspaper, meeting-transcript source or durable whole-window ingestion
contract. These are product gaps, not completed capabilities.

## Deliver in four reviewable steps

| Step | Deliverable | Exit proof |
| --- | --- | --- |
| 1. Automatic email work | Durable change ingestion, resumable backfill, clear coverage and reconciliation across threads | A new email creates work without Find open work; a later reply updates that same task; restart loses nothing |
| 2. Meeting continuity | One working transcript intake path and shared task reconciliation | Email and two weekly meeting transcripts retain one continuing obligation with correct evidence |
| 3. Daily EA | Separate newspaper UI, saved editions, topic developments and Since your briefing | A morning edition remains stable while later evidence appears separately; offline and wake behavior are verified |
| 4. Release qualification | Accuracy review, failure testing, native workflow UAT and remote-main release proof | All acceptance cases below pass on the installed build; unresolved failures block a readiness claim |

Each step is a working vertical slice. Do not ship a new screen that implies an
unbuilt pipeline is operating. Estimates come after the intake choice, contracts,
migrations and acceptance data are agreed and inspected.

## Acceptance: prove the behavior we actually need

Use a user-reviewed acceptance set of email conversations and meeting transcripts,
with expected tasks, decisions, topic updates and completion evidence written down
before tuning prompts. Private content stays out of public CI logs and fixtures.
Use representative anonymized fixtures for public checks and private native UAT
for provider proof.

The minimum acceptance sequences are:

1. An email commitment appears automatically with the correct owner, due date,
   quote and clickable source.
2. A new weekly thread and two call transcripts continue that obligation without
   duplication; a separate new commitment remains separate.
3. A reply elsewhere answers the question; EA stops calling it unanswered.
4. A promised action remains open; explicit completion closes it. Human completion,
   edits and snooze survive re-extraction, older evidence and app restart.
5. Unknown speakers, ambiguous dates and suggested ideas remain visibly uncertain.
6. An informational topic change appears in EA even when it creates no to-do.
7. The morning edition retains its date/cutoff; later updates do not alter it.
8. Sleep through the scheduled time, wake, lose connectivity, restart mid-extraction
   and retry a failed model request: no missing or duplicate accepted work, and no
   incomplete edition labeled current and complete.
9. Switch accounts, contacts, topics and email chats: correct source/context every
   time, with no unintended account mixing.
10. Send, reply, archive, delete Spam, navigate and refresh during backfill and
    briefing generation: mail remains usable and provider state reconciles correctly.

Accuracy gates for the controlled acceptance set: at least
95% precision and 90% recall for explicit commitments, with zero fabricated evidence,
unsupported owner/date assignments or duplicate known obligations in that set.
Record denominators and failures. These are qualification thresholds, not claims
about current accuracy or guarantees outside the measured sample.

Measure mail and Codex latency before and during background review. Set performance
budgets from that baseline and fail qualification if background work causes material
regression. Opening cached EA/To-dos must never wait for a model response.

Release proof includes passing exact-commit public CI, merged required PRs, a clean
build from canonical remote main, installed runtime identity and native checks with
real provider readback. Fixture success alone does not establish those results.

## Scope boundary for this iteration

Included: automatic discovery, continuing task/decision context, transcript intake,
dated EA editions, source navigation, corrections, offline saved work and dependable
background processing.

Separate decisions: live call recording/transcription, meeting bots, project-management
integrations, automatic task execution, external notifications and organization-wide
shared work. Briefing preparation and task extraction do not themselves authorize
messages, mailbox changes or external actions.
