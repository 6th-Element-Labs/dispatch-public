import { installWebLinks } from './web-links.js'
import { DraftRecovery, type RecoveryDraft } from './draft-recovery.js'
import { resultExcerpt, highlightPassage } from './search-highlights.js'
import { renderThreadAttachments } from './thread-attachments'
import '@tabler/core/dist/css/tabler.min.css'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import './styles.css'
import './apple-ui.css'
import './dark.css'
import { THEME_PREFERENCES, createThemeController, type ThemePreference } from './theme.js'
import { api } from './api.js'
import { renderChatMarkdown } from './chat-renderer.js'
import { renderEmailContent, emailPlainText, applyMailAppearance } from './email-renderer.js'
import { commitRecipientToken, parseRecipientList, serializeRecipientList } from './recipient-field.js'

const mailSurfaceOverrides = new Map<string, 'light' | 'dark'>()
const theme = createThemeController({
  root: document.documentElement,
  storage: localStorage,
  media: typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null,
  onChange: ({ resolved }) => {
    for (const article of document.querySelectorAll<HTMLElement>('.dispatch-thread-message')) {
      const body = article.querySelector<HTMLElement>('.dispatch-thread-body')
      if (body) applyMailAppearance(body, resolved === 'dark', mailSurfaceOverrides.get(article.dataset.messageId ?? ''))
    }
  },
})
import type { MailboxCounts, OfflineStatus, SearchResults, SearchResult, AppSummary, ConversationProjection, DispatchModel, DispatchModelCatalog, ConversationSummary, DraftProjection, GmailAccount, GmailConversationAction, GmailMailbox, MailAddress, MailStateFilter, MessageProjection } from './contracts.js'
import { createContextMenuPopup } from './context-menu-popup.js'
import { createMarkReadDwell } from './mark-read-dwell.js'
import { gmailAppId, isNativeShell } from './model.js'
import { markSetupSeen, SETUP_GMAIL_URL, SETUP_INSTALL_URL, setupSeen } from './setup-guide.js'
import { codexMailEffect, visibleUserPrompt, type CodexMailEffect } from './codex-mail-effect.js'
import { arrivedUnreadIds, liveListBaseline, playNewMailTone, type LiveListBaseline } from './new-mail-tone.js'
import { CONVERSATION_DRAG_TYPE, EMPTY_SELECTION, decodeDragPayload, dropActionForMailbox, encodeDragPayload, moveLabel, pruneSelection, selectionAfterArrow, selectionAfterClick, undoActionsFor, type SelectionState } from './selection.js'
import { SHORTCUT_GROUPS, TOOLBAR_KEYS, resolveShortcut } from './shortcuts.js'
import { describeRequestError, requestErrorCode } from './request-errors.js'
import { threadContextMenuItems } from './thread-context-menu.js'

const appElement = document.querySelector<HTMLDivElement>('#app')
if (!appElement) throw new Error('Dispatch app root is missing')
const app: HTMLDivElement = appElement
if (isNativeShell(window as { isTauri?: unknown })) document.documentElement.classList.add('dispatch-native')
const popupContextMenu = createContextMenuPopup(window as Window & { isTauri?: unknown; __TAURI__?: { core?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } } })

app.innerHTML = `
  <div class="page dispatch-window">
    <header class="dispatch-toolbar" data-tauri-drag-region>
      <div class="dispatch-toolbar-cluster dispatch-toolbar-messages" data-toolbar-messages data-tauri-drag-region>
        <button class="btn btn-icon btn-ghost-secondary btn-sm" type="button" data-mailboxes-toggle aria-label="Show mailboxes" aria-expanded="false" title="Show mailboxes"><i class="ti ti-layout-sidebar" aria-hidden="true"></i></button><button class="btn btn-sm btn-ghost-secondary dispatch-sidebar-options" data-sidebar-options aria-label="Folder rail style" aria-haspopup="menu" aria-expanded="false"><i class="ti ti-chevron-down" aria-hidden="true"></i></button>
        <button class="btn btn-icon btn-ghost-primary btn-sm" type="button" data-compose aria-label="Compose" title="Compose"><i class="ti ti-pencil" aria-hidden="true"></i></button>
        <div class="dispatch-folder">
          <button class="btn btn-ghost-secondary btn-sm dispatch-folder-button" type="button" data-folder-toggle aria-haspopup="menu" aria-expanded="false"><h1 class="dispatch-folder-title" data-mailbox-title>Inbox</h1><i class="ti ti-chevron-down" aria-hidden="true"></i></button>
          <div class="dropdown-menu dispatch-folder-menu" data-folder-menu role="menu" hidden>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="inbox"><i class="ti ti-inbox dropdown-item-icon" aria-hidden="true"></i>Inbox<span class="dispatch-mailbox-count dispatch-mailbox-count-menu" data-mailbox-count="inbox" hidden></span></button>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="sent"><i class="ti ti-send dropdown-item-icon" aria-hidden="true"></i>Sent</button>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="drafts"><i class="ti ti-file-pencil dropdown-item-icon" aria-hidden="true"></i>Drafts<span class="dispatch-mailbox-count dispatch-mailbox-count-menu" data-mailbox-count="drafts" hidden></span></button>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="archive"><i class="ti ti-archive dropdown-item-icon" aria-hidden="true"></i>Archive</button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" type="button" role="menuitem" data-collapse-messages aria-label="Collapse thread list">Hide message list <span class="ms-auto">⌃&#96;</span></button>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="spam"><i class="ti ti-alert-octagon dropdown-item-icon" aria-hidden="true"></i>Spam<span class="dispatch-mailbox-count dispatch-mailbox-count-menu" data-mailbox-count="spam" hidden></span></button>
            <button class="dropdown-item" type="button" role="menuitem" data-mailbox="trash"><i class="ti ti-trash dropdown-item-icon" aria-hidden="true"></i>Trash</button>
          </div>
        </div>
        <select class="form-select form-select-sm dispatch-scope" data-account aria-label="Gmail account"><option value="">All inboxes</option></select>
        <span class="dispatch-toolbar-spacer" data-tauri-drag-region></span>
      </div>
      <div class="dispatch-toolbar-cluster dispatch-toolbar-reader" data-tauri-drag-region>

        <span class="dispatch-toolbar-spacer" data-tauri-drag-region></span>
        <label class="input-icon dispatch-search"><span class="input-icon-addon"><i class="ti ti-search" aria-hidden="true"></i></span><input class="form-control form-control-sm" data-search placeholder="Search" aria-label="Search mail" title="Type to filter; press Enter to search with Codex"><kbd class="dispatch-search-kbd" aria-hidden="true">⌘K</kbd></label><button class="btn btn-sm btn-icon btn-ghost-primary" type="button" data-ai-search aria-label="Search with Codex" title="Search with Codex (Enter)"><i class="ti ti-sparkles" aria-hidden="true"></i></button>
      </div>
      <div class="dispatch-toolbar-cluster dispatch-toolbar-agent" data-toolbar-agent data-tauri-drag-region>
        <span class="dispatch-toolbar-spacer" data-tauri-drag-region></span>
        <div class="btn-group dispatch-panel-controls" role="group" aria-label="Visible panels">
          <button class="btn btn-sm btn-icon active" type="button" data-panel="messages" aria-pressed="true" aria-label="Messages" title="Messages (Control + &#96;)"><i class="ti ti-layout-sidebar" aria-hidden="true"></i></button>
          <button class="btn btn-sm btn-icon active" type="button" data-panel="reader" aria-pressed="true" aria-label="Email" title="Email"><i class="ti ti-mail" aria-hidden="true"></i></button>
          <button class="btn btn-sm btn-icon active" type="button" data-panel="agent" aria-pressed="true" aria-label="Codex" title="Codex"><i class="ti ti-sparkles" aria-hidden="true"></i></button>
        </div>
      </div>
    </header>
    <div class="dispatch-workspace">
      <nav class="dispatch-rail nav nav-pills flex-column" aria-label="Mail folders" hidden><button type="button" class="nav-link active" data-mailbox="inbox"><i class="ti ti-inbox" aria-hidden="true"></i><span>Inbox</span><span class="dispatch-mailbox-count" data-mailbox-count="inbox" hidden></span></button><button type="button" class="nav-link" data-mailbox="sent"><i class="ti ti-send" aria-hidden="true"></i><span>Sent</span></button><button type="button" class="nav-link" data-mailbox="drafts"><i class="ti ti-file-pencil" aria-hidden="true"></i><span>Drafts</span><span class="dispatch-mailbox-count" data-mailbox-count="drafts" hidden></span></button><button type="button" class="nav-link" data-mailbox="archive"><i class="ti ti-archive" aria-hidden="true"></i><span>Archive</span></button><span class="dispatch-rail-spacer"></span><button type="button" class="nav-link" data-mailbox="spam"><i class="ti ti-alert-octagon" aria-hidden="true"></i><span>Spam</span><span class="dispatch-mailbox-count" data-mailbox-count="spam" hidden></span></button><button type="button" class="nav-link" data-mailbox="trash"><i class="ti ti-trash" aria-hidden="true"></i><span>Trash</span></button></nav>
      <aside class="card rounded-0 border-0 dispatch-messages" aria-label="Messages">
        <nav class="dispatch-mail-tabs" aria-label="Message state"><button class="dispatch-mail-tab active" type="button" data-mail-state="all" aria-pressed="true">All</button><button class="dispatch-mail-tab" type="button" data-mail-state="unread" aria-pressed="false">Unread</button><button class="dispatch-mail-tab" type="button" data-mail-state="read" aria-pressed="false">Read</button><button class="btn btn-sm btn-icon ms-auto" data-density aria-label="Use comfortable message list" aria-pressed="true" title="Message density"><i class="ti ti-list-details" aria-hidden="true"></i></button></nav>
        <div class="dispatch-search-status" data-search-status hidden><span data-search-summary role="status"></span><button class="btn btn-sm btn-ghost-secondary" type="button" data-clear-search aria-label="Return to mailbox">Clear</button></div>
        <div class="list-group list-group-flush dispatch-message-list" data-message-list></div>
        <div class="alert alert-danger m-3 dispatch-pane-error" role="alert" data-mail-error hidden></div>
        <footer class="dispatch-mail-activity"><div class="dispatch-activity-status">        <span class="dispatch-sync" data-sync-state="idle"><span class="dispatch-sync-dot" aria-hidden="true"></span><span class="text-secondary" data-mail-source>Loading</span></span>
        <button class="btn btn-icon btn-ghost-secondary btn-sm" type="button" data-refresh aria-label="Refresh" title="Refresh Gmail"><i class="ti ti-refresh" aria-hidden="true"></i></button></div><button class="btn btn-sm" data-activity-toggle aria-expanded="false" aria-controls="dispatch-activity"><i class="ti ti-activity" aria-hidden="true"></i><span>Mail activity</span></button><div class="dispatch-activity-popover" id="dispatch-activity" hidden><strong>Mail activity</strong><div class="dispatch-activity-options"><button type="button" class="nav-link" data-offline-open><i class="ti ti-cloud-down" aria-hidden="true"></i><span>Offline</span></button></div><p class="small text-secondary mb-0">Downloaded mail</p></div></footer>
      </aside>
      <div class="dispatch-divider" data-divider="messages" role="separator" tabindex="0" aria-label="Resize messages panel" aria-orientation="vertical" aria-valuemin="220" aria-valuemax="640"><i class="ti ti-grip-vertical" aria-hidden="true"></i></div>
      <main class="card rounded-0 border-0 dispatch-reader" aria-label="Selected email">
        <div class="empty dispatch-reader-empty" data-reader-empty><div class="empty-icon"><i class="ti ti-mail-opened"></i></div><p class="empty-title">Select a message</p></div>
        <div data-reader hidden>
          <header class="dispatch-reader-header">
            <h2 class="dispatch-reader-subject" data-subject></h2>
            <div class="dispatch-reader-toolbar" role="toolbar" aria-label="Message actions">
              <button class="btn btn-icon btn-ghost-secondary btn-sm dispatch-mobile-back" type="button" data-mobile-back aria-label="Back to Inbox"><i class="ti ti-arrow-left" aria-hidden="true"></i></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-reply aria-label="Reply"><i class="ti ti-arrow-back-up" aria-hidden="true"></i><span>Reply</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-reply-all aria-label="Reply all"><i class="ti ti-arrow-back-up-double" aria-hidden="true"></i><span>Reply all</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-forward aria-label="Forward"><i class="ti ti-arrow-forward-up" aria-hidden="true"></i><span>Forward</span></button>
              <span class="dispatch-reader-divider" aria-hidden="true"></span>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-move-inbox aria-label="Move to Inbox" hidden><i class="ti ti-inbox" aria-hidden="true"></i><span>Inbox</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-archive aria-label="Archive"><i class="ti ti-archive" aria-hidden="true"></i><span>Archive</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-spam aria-label="Mark as spam"><i class="ti ti-alert-octagon" aria-hidden="true"></i><span>Spam</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-trash aria-label="Move to Trash"><i class="ti ti-trash" aria-hidden="true"></i><span>Trash</span></button>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-read-state aria-label="Mark unread"><i class="ti ti-mail" aria-hidden="true"></i><span>Unread</span></button>
              <span class="dispatch-reader-spacer"></span>
              <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-ask aria-label="Ask Codex"><i class="ti ti-sparkles" aria-hidden="true"></i><span>Codex</span></button>
              <div class="dispatch-reader-more">
                <button class="btn btn-ghost-secondary dispatch-reader-action" type="button" data-reader-more aria-label="More actions" aria-haspopup="menu" aria-expanded="false"><i class="ti ti-dots" aria-hidden="true"></i><span>More</span></button>
                <div class="dropdown-menu dropdown-menu-end dispatch-reader-menu" data-reader-menu role="menu" hidden>
                  <button class="dropdown-item dispatch-pane-collapse" type="button" role="menuitem" data-collapse-reader>Hide email panel</button>
                </div>
              </div>
            </div>
            <div class="dispatch-thread-meta" data-thread-meta><span class="dispatch-account-dot" data-account-dot hidden aria-hidden="true"></span><span data-address hidden></span><span class="dispatch-meta-sep" data-account-sep hidden>·</span><span data-thread-mailbox></span><span class="dispatch-meta-sep" data-count-sep hidden>·</span><span data-message-count hidden></span><span class="dispatch-copy-chip" data-copy-status data-mode="live" hidden role="status"><i class="ti ti-cloud-down" aria-hidden="true"></i><span data-copy-label></span></span><button type="button" class="btn btn-sm btn-ghost-primary dispatch-thread-files-toggle" data-thread-files-toggle aria-expanded="false" aria-controls="dispatch-thread-files" hidden></button></div>
          </header>
          <article class="dispatch-email-body" data-body></article>
          <section class="dispatch-attachments" data-attachments></section>
          <section class="card-body dispatch-draft" data-draft hidden>
            <div class="card"><div class="card-header"><div><strong>Unsent draft</strong><span class="text-secondary small ms-2">Not sent</span></div><button type="button" class="btn btn-sm btn-ghost-secondary" data-collapse-draft aria-expanded="true" aria-controls="dispatch-draft-content"><i class="ti ti-chevron-down me-1" aria-hidden="true"></i>Collapse draft</button></div><div id="dispatch-draft-content" data-draft-content><div class="card-body">
            <label class="form-label">From<select class="form-select mt-1" data-draft-account aria-label="Draft account"></select></label>
            <label class="form-label">To<div class="dispatch-recipient-field mt-1" data-recipient-field><div class="dispatch-recipient-chips"></div><input class="form-control" data-draft-to aria-label="Draft recipient" autocomplete="off"><ul class="dispatch-recipient-suggestions" hidden role="listbox" aria-label="Recipient suggestions"></ul></div></label>
            <div class="row g-3 mt-0"><label class="col form-label">Cc<div class="dispatch-recipient-field mt-1" data-recipient-field><div class="dispatch-recipient-chips"></div><input class="form-control" data-draft-cc aria-label="Draft Cc" autocomplete="off"><ul class="dispatch-recipient-suggestions" hidden role="listbox" aria-label="Cc suggestions"></ul></div></label><label class="col form-label">Bcc<div class="dispatch-recipient-field mt-1" data-recipient-field><div class="dispatch-recipient-chips"></div><input class="form-control" data-draft-bcc aria-label="Draft Bcc" autocomplete="off"><ul class="dispatch-recipient-suggestions" hidden role="listbox" aria-label="Bcc suggestions"></ul></div></label></div>
            <label class="form-label">Subject<input class="form-control mt-1" data-draft-subject aria-label="Draft subject"></label>
            <label class="form-label">Message<textarea class="form-control mt-1" data-draft-body aria-label="Draft body"></textarea></label>
            <p class="text-secondary small" data-recovery-status role="status"></p>
            <ul class="dispatch-draft-attachments" data-draft-attachments aria-label="Draft attachments" hidden></ul>
            <div class="dispatch-draft-preview markdown" data-draft-preview aria-label="Draft preview"></div>
            <p class="text-secondary small" data-draft-error hidden></p>
            <div class="alert alert-warning" data-send-confirm hidden>
              <p data-send-confirm-text></p>
              <button class="btn btn-outline-secondary" type="button" data-send-cancel>Cancel</button>
              <button class="btn btn-primary" type="button" data-send-confirm-go>Send now</button>
            </div>
            </div><footer class="card-footer d-flex flex-wrap gap-2"><button class="btn btn-outline-danger" type="button" data-discard-draft>Discard</button><button class="btn btn-outline-secondary" type="button" data-attach-draft>Attach</button><input type="file" data-draft-files multiple hidden><button class="btn btn-outline-secondary" type="button" data-save-draft>Save draft</button><button class="btn btn-outline-secondary" type="button" data-revise-draft><i class="ti ti-sparkles me-1" aria-hidden="true"></i>Ask Codex to revise</button><button class="btn btn-primary ms-auto" type="button" data-send-draft><i class="ti ti-send me-1" aria-hidden="true"></i>Send draft</button></footer></div>
            </div>
          </section>
        </div>
      </main>
      <div class="dispatch-divider" data-divider="agent" role="separator" tabindex="0" aria-label="Resize Codex panel" aria-orientation="vertical" aria-valuemin="280" aria-valuemax="900"><i class="ti ti-grip-vertical" aria-hidden="true"></i></div>
      <aside class="card rounded-0 border-0 dispatch-agent" aria-label="Codex">
        <div class="dispatch-agent-stream" data-agent-stream><p class="dispatch-agent-intro">Use the installed Codex harness with your selected email in view.</p></div>
        <footer class="card-footer">
          <p class="dispatch-agent-state-text" data-agent-state-text role="status" hidden></p><div class="dispatch-suggestions"><button class="btn btn-sm btn-ghost-secondary" type="button" data-suggestion="Catch me up on this email.">Catch me up</button><button class="btn btn-sm btn-ghost-secondary" type="button" data-suggestion="Draft a reply to this email.">Draft a reply</button><button class="btn btn-sm btn-ghost-secondary" type="button" data-suggestion="Find related messages in Gmail.">Find related</button></div>
          <div class="card card-sm dispatch-prompt"><div class="card-body p-2"><textarea class="form-control border-0 shadow-none" data-prompt aria-label="Ask Codex" placeholder="Ask Codex about this email…"></textarea><div class="progress progress-sm mt-2" data-agent-activity aria-label="Codex is working" hidden><div class="progress-bar progress-bar-indeterminate bg-blue"></div></div><div class="d-flex align-items-center justify-content-between mt-2"><span class="dispatch-prompt-status"><span class="dispatch-status-dot" data-connector data-ready="false" title="Checking connectors" aria-label="Checking connectors"></span><span class="dispatch-status-dot" data-agent-status data-status="Connecting" title="Connecting" aria-label="Connecting" aria-live="polite"></span><button class="btn btn-sm btn-ghost-secondary" type="button" data-setup-open>Setup</button><span class="dispatch-model"><button class="badge bg-blue-lt text-blue border-0 dispatch-model-button" type="button" data-model-toggle aria-haspopup="menu" aria-expanded="false" title="Choose the Codex model and reasoning effort"><span data-model-label>GPT-5.6 Sol · Medium</span><i class="ti ti-chevron-down" aria-hidden="true"></i></button><div class="dropdown-menu dispatch-model-menu" data-model-menu role="menu" hidden><div class="dropdown-header" data-model-summary>Loading models</div><div data-model-list></div><div class="dropdown-divider"></div><div class="dropdown-header">Reasoning effort</div><div class="dispatch-model-efforts" role="group" aria-label="Reasoning effort" data-model-efforts></div></div></span></span><span><button class="btn btn-icon btn-sm btn-outline-danger" type="button" data-stop aria-label="Stop" hidden><i class="ti ti-player-stop-filled" aria-hidden="true"></i></button><button class="btn btn-icon btn-sm btn-primary" type="button" data-send aria-label="Send"><i class="ti ti-arrow-up" aria-hidden="true"></i></button></span></div></div></div>
        </footer>
      </aside>
    </div>
      <div class="dispatch-setup" data-setup role="dialog" aria-modal="true" aria-labelledby="dispatch-setup-title" hidden>
        <div class="dispatch-setup-card">
          <section class="dispatch-setup-brand">
            <span class="dispatch-setup-mark" aria-hidden="true"><svg viewBox="0 0 1024 1024"><g fill="none" stroke="#C8F51A" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"><path d="M250 300l210 212-210 212" opacity=".35"/><path d="M430 300l210 212-210 212" opacity=".65"/><path d="M610 300l210 212-210 212"/></g><path transform="translate(795 255) scale(.75)" d="M0-100C6-40 40-6 100 0 40 6 6 40 0 100-6 40-40 6-100 0-40-6-6-40 0-100z" fill="#C8F51A"/></svg></span>
            <h2 id="dispatch-setup-title" data-setup-heading tabindex="-1">Your whole Codex, pointed at your inbox.</h2>
            <p>Dispatch runs the Codex on your Mac, with the thread you clicked already in context. Ask for the gist, draft the reply, pull the numbers from the attachment, check your calendar, open the repo, write the doc. Anything your Codex can reach, it can do from here. You still press Send.</p>
            <ul class="dispatch-setup-asks" aria-label="Things you can ask">
              <li>Catch me up on this thread</li>
              <li>Draft a reply and attach the revised PDF</li>
              <li>Find every message from this vendor since June</li>
              <li>Is Thursday 10 AM free?</li>
              <li>Turn this into a task list</li>
              <li>Open the PR they’re asking about</li>
            </ul>
          </section>
          <section class="dispatch-setup-steps-pane" aria-label="Setup steps">
            <p class="dispatch-setup-eyebrow">Before you start</p>
            <ol class="dispatch-setup-steps">
              <li>
                <span class="dispatch-setup-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></span>
                <div><strong>Install Codex</strong><small>The CLI from OpenAI. Dispatch talks to its App Server.</small></div>
                <a class="btn btn-sm" data-setup-install href="${SETUP_INSTALL_URL}" target="_blank" rel="noreferrer">Open install guide</a>
              </li>
              <li>
                <span class="dispatch-setup-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></span>
                <div><strong>Sign in to ChatGPT</strong><small>Run <code>codex login</code> in a terminal, or sign in from ChatGPT desktop.</small></div>
              </li>
              <li>
                <span class="dispatch-setup-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></span>
                <div><strong>Connect Gmail</strong><small>Adds the Gmail plugin inside Codex. If the link does nothing, open ChatGPT desktop Plugins, or run <code>codex</code>, then <code>/plugins</code>, then connect Google.</small></div>
                <a class="btn btn-sm" data-setup-gmail href="${SETUP_GMAIL_URL}">Open Codex</a>
              </li>
            </ol>
            <div class="dispatch-setup-foot">
              <div class="dispatch-setup-status" aria-live="polite"><span data-setup-agent data-state="Connecting"><i aria-hidden="true"></i><span data-setup-agent-label>Connecting to Codex</span></span><span data-setup-connector data-ready="false"><i aria-hidden="true"></i><span data-setup-connector-label>Checking Gmail</span></span></div>
              <button class="btn btn-ghost-secondary" type="button" data-setup-later>Set up later</button>
              <button class="btn btn-primary" type="button" data-setup-continue>Continue</button>
            </div>
          </section>
        </div>
      </div>
  </div>`

app.insertAdjacentHTML('beforeend', `
  <div class="dispatch-undo-toast" data-undo-toast role="status" aria-live="polite" hidden><span data-undo-text></span><button class="btn btn-sm dispatch-undo-button" type="button" data-undo>Undo</button><kbd class="dispatch-undo-key" aria-hidden="true">⌘Z</kbd><button class="btn btn-icon btn-sm dispatch-undo-close" type="button" data-undo-dismiss aria-label="Dismiss"><i class="ti ti-x" aria-hidden="true"></i></button><span class="dispatch-undo-progress" aria-hidden="true"><span data-undo-bar></span></span></div>
  <div class="dispatch-sidebar-menu dropdown-menu" role="menu" aria-label="Folder rail style" data-sidebar-menu hidden><button class="dropdown-item" role="menuitemradio" aria-checked="true" data-sidebar-style="compact">Compact</button><button class="dropdown-item" role="menuitemradio" aria-checked="false" data-sidebar-style="expanded">Expanded</button></div>

  <dialog class="dispatch-utility-dialog dispatch-shortcuts-dialog" data-shortcuts-dialog aria-label="Keyboard shortcuts"><div class="d-flex justify-content-between align-items-center"><h2 class="m-0">Keyboard shortcuts</h2><span class="text-secondary small">Press <kbd>?</kbd> any time</span><button class="btn btn-sm" data-dialog-close>Close</button></div><div class="dispatch-shortcut-groups" data-shortcut-groups></div><p class="text-secondary small mb-0">Single letters work only with focus in the list or the reader, never inside a text field.</p></dialog>
  <dialog class="dispatch-utility-dialog" data-offline-dialog aria-label="Downloaded mail"><div class="d-flex justify-content-between"><h2>Downloaded mail</h2><button class="btn btn-sm" data-dialog-close>Close</button></div><p>Opened conversations are saved automatically. Download mailbox saves indexed conversations’ full message bodies. Attachments are separate and work offline when already downloaded.</p><label class="form-check"><input class="form-check-input" type="checkbox" data-offline-mode><span class="form-check-label">Use downloaded mail</span></label><p data-offline-status role="status"></p><button class="btn btn-primary btn-sm" data-download-mailbox>Download mailbox</button><button class="btn btn-sm" data-cancel-download hidden>Cancel download</button></dialog>
`)

const elements = {
  toolbar: app.querySelector<HTMLElement>('.dispatch-toolbar')!,
  workspace: app.querySelector<HTMLElement>('.dispatch-workspace')!,
  messagesPanel: app.querySelector<HTMLElement>('.dispatch-messages')!,
  readerPanel: app.querySelector<HTMLElement>('.dispatch-reader')!,
  agentPanel: app.querySelector<HTMLElement>('.dispatch-agent')!,
  messagesDivider: app.querySelector<HTMLElement>('[data-divider="messages"]')!,
  agentDivider: app.querySelector<HTMLElement>('[data-divider="agent"]')!,
  list: app.querySelector<HTMLElement>('[data-message-list]')!,
  mailSource: app.querySelector<HTMLElement>('[data-mail-source]')!,
  mailboxTitle: app.querySelector<HTMLElement>('[data-mailbox-title]')!,
  account: app.querySelector<HTMLSelectElement>('[data-account]')!,
  mailError: app.querySelector<HTMLElement>('[data-mail-error]')!,
  reader: app.querySelector<HTMLElement>('[data-reader]')!,
  readerEmpty: app.querySelector<HTMLElement>('[data-reader-empty]')!,
  subject: app.querySelector<HTMLElement>('[data-subject]')!,
  address: app.querySelector<HTMLElement>('[data-address]')!,
  messageCount: app.querySelector<HTMLElement>('[data-message-count]')!,
  threadMailbox: app.querySelector<HTMLElement>('[data-thread-mailbox]')!,
  accountDot: app.querySelector<HTMLElement>('[data-account-dot]')!,
  accountSep: app.querySelector<HTMLElement>('[data-account-sep]')!,
  copyStatus: app.querySelector<HTMLElement>('[data-copy-status]')!,
  copyLabel: app.querySelector<HTMLElement>('[data-copy-label]')!,
  countSep: app.querySelector<HTMLElement>('[data-count-sep]')!,
  recoveryStatus: app.querySelector<HTMLElement>('[data-recovery-status]')!,
  readerMore: app.querySelector<HTMLButtonElement>('[data-reader-more]')!,
  readerMenu: app.querySelector<HTMLElement>('[data-reader-menu]')!,
  body: app.querySelector<HTMLElement>('[data-body]')!,
  threadFilesToggle: app.querySelector<HTMLButtonElement>('[data-thread-files-toggle]')!,
  attachments: app.querySelector<HTMLElement>('[data-attachments]')!,
  draft: app.querySelector<HTMLElement>('[data-draft]')!,
  draftTo: app.querySelector<HTMLInputElement>('[data-draft-to]')!,
  draftCc: app.querySelector<HTMLInputElement>('[data-draft-cc]')!,
  draftBcc: app.querySelector<HTMLInputElement>('[data-draft-bcc]')!,
  draftAccount: app.querySelector<HTMLSelectElement>('[data-draft-account]')!,
  draftSubject: app.querySelector<HTMLInputElement>('[data-draft-subject]')!,
  draftBody: app.querySelector<HTMLTextAreaElement>('[data-draft-body]')!,
  draftPreview: app.querySelector<HTMLElement>('[data-draft-preview]')!,
  draftError: app.querySelector<HTMLElement>('[data-draft-error]')!,
  draftAttachments: app.querySelector<HTMLElement>('[data-draft-attachments]')!,
  draftFiles: app.querySelector<HTMLInputElement>('[data-draft-files]')!,
  discardDraft: app.querySelector<HTMLButtonElement>('[data-discard-draft]')!,
  sendDraft: app.querySelector<HTMLButtonElement>('[data-send-draft]')!,
  sendConfirm: app.querySelector<HTMLElement>('[data-send-confirm]')!,
  sendConfirmText: app.querySelector<HTMLElement>('[data-send-confirm-text]')!,
  sendConfirmGo: app.querySelector<HTMLButtonElement>('[data-send-confirm-go]')!,
  agentStatus: app.querySelector<HTMLElement>('[data-agent-status]')!,
  agentActivity: app.querySelector<HTMLElement>('[data-agent-activity]')!,
  connector: app.querySelector<HTMLElement>('[data-connector]')!,
  stream: app.querySelector<HTMLElement>('[data-agent-stream]')!,
  prompt: app.querySelector<HTMLTextAreaElement>('[data-prompt]')!,
  searchStatus: app.querySelector<HTMLElement>('[data-search-status]')!,
  searchSummary: app.querySelector<HTMLElement>('[data-search-summary]')!,
  search: app.querySelector<HTMLInputElement>('[data-search]')!,
  toolbarMessages: app.querySelector<HTMLElement>('[data-toolbar-messages]')!,
  toolbarAgent: app.querySelector<HTMLElement>('[data-toolbar-agent]')!,
  folderToggle: app.querySelector<HTMLButtonElement>('[data-folder-toggle]')!,
  folderMenu: app.querySelector<HTMLElement>('[data-folder-menu]')!,
  modelToggle: app.querySelector<HTMLButtonElement>('[data-model-toggle]')!,
  modelLabel: app.querySelector<HTMLElement>('[data-model-label]')!,
  modelMenu: app.querySelector<HTMLElement>('[data-model-menu]')!,
  modelSummary: app.querySelector<HTMLElement>('[data-model-summary]')!,
  modelList: app.querySelector<HTMLElement>('[data-model-list]')!,
  modelEfforts: app.querySelector<HTMLElement>('[data-model-efforts]')!,
  sync: app.querySelector<HTMLElement>('.dispatch-sync')!,
  stop: app.querySelector<HTMLButtonElement>('[data-stop]')!,
  readState: app.querySelector<HTMLButtonElement>('[data-read-state]')!,
  readStateIcon: app.querySelector<HTMLElement>('[data-read-state] > i')!,
  readStateLabel: app.querySelector<HTMLElement>('[data-read-state] > span')!,
  archive: app.querySelector<HTMLButtonElement>('[data-archive]')!,
  spam: app.querySelector<HTMLButtonElement>('[data-spam]')!,
  trash: app.querySelector<HTMLButtonElement>('[data-trash]')!,
  moveInbox: app.querySelector<HTMLButtonElement>('[data-move-inbox]')!,
  setup: app.querySelector<HTMLElement>('[data-setup]')!,
  setupHeading: app.querySelector<HTMLElement>('[data-setup-heading]')!,
  setupContinue: app.querySelector<HTMLButtonElement>('[data-setup-continue]')!,
  setupOpen: app.querySelector<HTMLButtonElement>('[data-setup-open]')!,
  setupLater: app.querySelector<HTMLButtonElement>('[data-setup-later]')!,
  setupAgent: app.querySelector<HTMLElement>('[data-setup-agent]')!,
  setupAgentLabel: app.querySelector<HTMLElement>('[data-setup-agent-label]')!,
  setupConnector: app.querySelector<HTMLElement>('[data-setup-connector]')!,
  setupConnectorLabel: app.querySelector<HTMLElement>('[data-setup-connector-label]')!,
}

installWebLinks(app, window as { isTauri?: unknown }, error => {
  elements.mailError.hidden = false
  elements.mailError.textContent = `Could not open link: ${error instanceof Error ? error.message : String(error)}`
})

function setAgentStatus(status: string, label = status): void {
  elements.agentStatus.dataset.status = status
  elements.agentStatus.title = label
  elements.agentStatus.setAttribute('aria-label', label)
  const stateText = app.querySelector<HTMLElement>('[data-agent-state-text]')!
  stateText.dataset.state = status
  stateText.hidden = status === 'Connected'
  stateText.textContent = label
  elements.setupAgent.dataset.state = status
  elements.setupAgentLabel.textContent = status === 'Connected' ? 'Codex connected' : label
  renderServiceStatus()
}

function setConnectorStatus(label: string, ready: boolean): void {
  elements.connector.dataset.ready = ready ? 'true' : 'false'
  elements.connector.title = label
  elements.connector.setAttribute('aria-label', label)
  elements.setupConnector.dataset.ready = ready ? 'true' : 'false'
  elements.setupConnectorLabel.textContent = label
}

function renderServiceStatus(): void {
  const status = elements.agentStatus.dataset.status ?? ''
  elements.agentActivity.hidden = status !== 'Working'
  const source = elements.mailSource.textContent?.trim() ?? ''
  elements.sync.dataset.syncState = /FAILED|Unavailable/.test(source) ? 'failed' : /^(Syncing|Refreshing)/.test(source) ? 'syncing' : /^(STALE|Partial)/.test(source) ? 'stale' : 'ready'
}

new MutationObserver(renderServiceStatus).observe(elements.mailSource, { childList: true, subtree: true })
new MutationObserver(renderServiceStatus).observe(elements.agentStatus, { attributes: true, attributeFilter: ['data-status'] })
renderServiceStatus()
let activeDraft: DraftProjection | undefined
let draftPreviewTimer: number | undefined
let draftAutosaveTimer: number | undefined
let recipientSuggestTimer: number | undefined
let draftPreviewSequence = 0
let draftEditSession = 0
let draftDirty = false
let draftEditRevision = 0
function markDraftDirty(): void { draftDirty = true; draftEditRevision += 1; checkpointDraft() }
// Keep Gmail draft writes in order so a slow save cannot overwrite a newer save.
let draftSaveFlight: Promise<DraftProjection | undefined> | undefined
// Keep Gmail send confirmation single-flight.
let draftSendFlight: Promise<void> | undefined
let sendConfirmationRevision: number | undefined
let draftDiscarding = false
const recovery = new DraftRecovery()
let draftSyncTimer: number | undefined
const backgroundDraftSaves = new Map<string, Promise<DraftProjection | undefined>>()
async function linkDraftTask(key: string, draft: DraftProjection): Promise<void> {
  if (!draft.accountId || !draft.gmailThreadId) return
  const id = readBindingCache()[`draft:${key}`]
  if (!id) return
  const target: CodexPaneKey = { kind: 'conversation', accountId: draft.accountId, gmailThreadId: draft.gmailThreadId }
  writeBindingCache(target, id)
  const bound = await api.bindThread(target, id)
  writeBindingCache(target, bound.threadId)
}
const draftSyncErrors = new Map<string, string>()
let draftSyncDelay = 3000
function retryableDraftError(error: unknown): boolean {
  const detail = String(error)
  if (/gmail_draft_not_found|invalid_gmail|permission.denied|unauthorized|\(403\)|\(400\)/i.test(detail)) return false
  return /Service request failed|502|503|429|timeout|timed out|draft_sync_pending|unavailable|fetch failed/i.test(detail)
}
function scheduleDraftSync(delay = draftSyncDelay): void {
  if (draftSyncTimer !== undefined) {
    if (delay !== 0) return
    window.clearTimeout(draftSyncTimer)
  }
  draftSyncTimer = window.setTimeout(() => { draftSyncTimer = undefined; void syncPendingDrafts().catch(error => { console.error('Draft sync could not read local drafts:', error) }) }, delay)
}
async function syncPendingDrafts(): Promise<void> {
  if (offlineMode || !navigator.onLine) return
  if (draftSaveFlight) { scheduleDraftSync(); return }
  let pending = false
  for (const record of recovery.list()) {
    if (!record.accountId || backgroundDraftSaves.has(record.key)) continue
    if (record.key === recoveryKey && activeDraft) {
      if (draftDirty && !draftSaveFlight && !draftSendFlight) autosaveDraft()
      continue
    }
    if ([record.to, record.cc, record.bcc].flatMap(parseRecipientList).some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) continue
    const save = (async () => {
      const restored = await recovery.restore(record.key)
      if (restored.missing.length) return
      const current = restored.record
      if ([current.to, current.cc, current.bcc].flatMap(parseRecipientList).some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return
      const fields = { accountId: current.accountId, messageId: current.inReplyToMessageId, clientDraftId: current.key, to: current.to, cc: current.cc, bcc: current.bcc, subject: current.subject, bodyMarkdown: current.bodyMarkdown, attachments: restored.attachments }
      const saved = current.gmailDraftId ? await api.updateDraft(current.gmailDraftId, fields) : await api.createDraft('', fields)
      void linkDraftTask(current.key, saved).catch(error => console.error('Draft task binding will need reconnection:', error))
      recovery.bindGmailIdentity(current.key, current.accountId!, saved.id, saved.gmailThreadId)
      recovery.removeSavedRevision(current.key, current.revision)
      draftSyncErrors.delete(current.key)
      pending ||= recovery.list().some(item => item.key === current.key)
      renderRecoveryList()
      return saved
    })()
    backgroundDraftSaves.set(record.key, save)
    try { await save; draftSyncDelay = 3000 }
    catch (error) {
      if (requestErrorCode(String(error)) === 'gmail_draft_not_found' && record.gmailDraftId) {
        // Gmail replaced or dropped the draft under us: forget the ghost id and let the next pass create or re-find it.
        recovery.clearGmailIdentity(record.key, record.accountId!)
        pending = true
      } else {
        pending ||= retryableDraftError(error)
        if (!retryableDraftError(error)) { draftSyncErrors.set(record.key, describeRequestError(String(error))); renderRecoveryList() }
      }
    }
    finally { backgroundDraftSaves.delete(record.key) }
  }
  if (pending) { draftSyncDelay = Math.min(60_000, draftSyncDelay * 2); scheduleDraftSync() }
}
window.addEventListener('online', () => { if (draftSyncTimer !== undefined) window.clearTimeout(draftSyncTimer); draftSyncTimer = undefined; scheduleDraftSync(0) })
let recoveryKey: string | undefined
let draftSeed: { fields: string; attachments: DraftProjection['attachments'] } | undefined
function editorFields(): string { return JSON.stringify([recipientValue(elements.draftTo), recipientValue(elements.draftCc), recipientValue(elements.draftBcc), elements.draftSubject.value, elements.draftBody.value]) }
// Older builds persisted network loss as an explicit offline preference.
// Only a deliberate user choice may disable live Gmail reads and refresh.
let offlineMode = localStorage.getItem('dispatch.offline-mode') === 'true' && localStorage.getItem('dispatch.offline-mode-source') === 'manual'
if (localStorage.getItem('dispatch.offline-mode-source') !== 'manual') localStorage.removeItem('dispatch.offline-mode')
let offlineStatus: OfflineStatus | undefined

let conversations: ConversationSummary[] = []
const pendingMailboxRemovals = new Set<string>()
let conversationTotal = 0
let nextConversationCursor: string | null = null
let loadingMoreConversations = false
let accounts: GmailAccount[] = []
let selectedAccountId: string | undefined
let mailState: MailStateFilter = 'all'
let mailbox: GmailMailbox = 'inbox'
let selected: ConversationProjection | undefined
let selectedSummary: ConversationSummary | undefined
let selectedConversationId: string | undefined
let selection: SelectionState = EMPTY_SELECTION
let readerNeedsRetry = false
let selectionSequence = 0
const markReadDwell = createMarkReadDwell()
let readStateActionSequence = 0
let conversationLoadSequence = 0
const conversationCache = new Map<string, Promise<ConversationProjection>>()
const BINDING_CACHE = 'dispatch.codex.bindings.v1'
type CodexPaneKey = { kind: 'unbound' } | { kind: 'draft'; draftKey: string } | { kind: 'conversation'; accountId: string; gmailThreadId: string }
const acceptedReadState = new Map<string, boolean>()
let threadId: string | undefined
let desiredCodexKey: CodexPaneKey = { kind: 'unbound' }
let bindingSequence = 0
const pendingCodexPrompts = new Map<string, string>()
type TaskStatus = { threadId: string; status: string; turnId?: string }
const taskStatuses = new Map<string, TaskStatus>()
const restoredMailEffects = new Map<string, string>()
const pendingMailEffects = new Map<string, { effect: CodexMailEffect; token: string }>()
let activityEvents: EventSource | undefined
const backgroundTasks = document.createElement('div')
backgroundTasks.dataset.backgroundTasks = ''
elements.prompt.closest('.dispatch-prompt')!.before(backgroundTasks)

function renderBackgroundTasks(): void {
  const bindings = readBindingCache()
  backgroundTasks.replaceChildren()
  for (const task of taskStatuses.values()) {
    if (task.threadId === threadId || !['Working', 'Needs attention', 'Failed'].includes(task.status)) continue
    const entry = Object.entries(bindings).find(([, id]) => id === task.threadId)
    if (!entry) continue
    const summary = conversations.find(c => bindingCacheKey(conversationBindingKey({ ...c, source: c.accountId ? 'gmail' : 'demo' })) === entry[0])
    const localDraft = entry[0].startsWith('draft:') ? recovery.list().find(record => `draft:${record.key}` === entry[0]) : undefined
    if (!summary && !localDraft && entry[0] !== 'unbound' && !entry[0].startsWith('draft:')) continue
    const button = document.createElement('button')
    button.className = 'btn btn-sm btn-ghost-secondary w-100 text-truncate'
    button.textContent = `${task.status} · ${summary?.subject ?? localDraft?.subject ?? 'New email / general chat'}`
    button.title = button.textContent
    button.onclick = () => { if (summary) void selectConversation(summary.id); else if (localDraft) void restoreLocalDraft(localDraft.key); else if (entry[0].startsWith('draft:')) openCompose(entry[0].slice(6)); else { selectCodexContext({ kind: 'unbound' }); void bindAndShowCodex({ kind: 'unbound' }) } }
    backgroundTasks.append(button)
  }
  backgroundTasks.hidden = !backgroundTasks.childElementCount
}

function connectTaskActivity(): void {
  if (activityEvents && activityEvents.readyState !== EventSource.CLOSED) return
  activityEvents = api.activity()
  activityEvents.onmessage = event => {
    for (const task of JSON.parse(event.data) as TaskStatus[]) taskStatuses.set(task.threadId, task)
    const current = threadId && taskStatuses.get(threadId)
    if (current && codexContextReady) {
      activeTurnId = current.turnId
      elements.stop.hidden = !activeTurnId
      setAgentStatus(current.status === 'Complete' ? 'Connected' : current.status)
    }
    renderBackgroundTasks()
  }
}

function bindingCacheKey(key: CodexPaneKey): string {
  if (key.kind === 'draft') return `draft:${key.draftKey}`
  return key.kind === 'unbound' ? 'unbound' : `conversation:${key.accountId}:${key.gmailThreadId}`
}

function selectCodexContext(key: CodexPaneKey): void {
  pendingCodexPrompts.set(bindingCacheKey(desiredCodexKey), elements.prompt.value)
  desiredCodexKey = key
  bindingSequence += 1
  paneSequence += 1
  codexContextReady = false
  threadId = undefined
  agentEvents?.close()
  agentEvents = undefined
  elements.stream.replaceChildren()
  elements.prompt.value = pendingCodexPrompts.get(bindingCacheKey(key)) ?? ''
  activeAgentMessage = undefined
  activeAgentText = ''
  activeTurnId = undefined
  elements.stop.hidden = true
  setAgentStatus('Connecting')
  renderBackgroundTasks()
}

function readBindingCache(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(BINDING_CACHE) ?? '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {}
  } catch {
    return {}
  }
}

function writeBindingCache(key: CodexPaneKey, id: string): void {
  const cache = readBindingCache()
  cache[bindingCacheKey(key)] = id
  localStorage.setItem(BINDING_CACHE, JSON.stringify(cache))
  localStorage.setItem('dispatch.codex.threadId', id)
}

function conversationBindingKey(conversation: { accountId?: string; threadId: string; source?: string }): { kind: 'conversation'; accountId: string; gmailThreadId: string } {
  const accountId = conversation.accountId || (conversation.source === 'demo' ? 'demo' : '')
  if (!accountId || !conversation.threadId) throw new Error('This conversation has no Gmail account or thread id for Codex.')
  return { kind: 'conversation', accountId, gmailThreadId: conversation.threadId }
}
let apps: AppSummary[] = []
let modelCatalog: DispatchModelCatalog | undefined
let modelCatalogError: string | undefined
let selectedModelId = localStorage.getItem('dispatch.codex.model') || ''
let selectedEffort = localStorage.getItem('dispatch.codex.effort') || ''
const userChoseModel = () => Boolean(localStorage.getItem('dispatch.codex.model'))
const userChoseEffort = () => Boolean(localStorage.getItem('dispatch.codex.effort'))
let activeAgentMessage: HTMLElement | undefined
let activeAgentText = ''
let agentEvents: EventSource | undefined
let paneSequence = 0
let reconnectTimer: number | undefined
let agentConnecting = false
let syncStatusTimer: number | undefined
let observedSyncCompletedAt: string | null | undefined
let observedDraftsRevision: number | undefined
let observedMailRevision: number | undefined
/** Ids from the last confirmed live inbox load, keyed by account and state filter so a scope change never chimes. */
let liveInboxBaseline: { scope: string; baseline: LiveListBaseline } | undefined
let toneContext: AudioContext | undefined
let syncErrorVisible = false
let mailReconnectTimer: number | undefined
/** How long after page load an unreachable mail service still counts as "starting" rather than failed. */
const MAIL_STARTUP_GRACE_MS = 20_000
const MAIL_STARTUP_RETRY_MS = 500
const mailStartupGraceUntil = performance.now() + MAIL_STARTUP_GRACE_MS
let searchQuery = ''
let acceptChatSearchResults = true
let searchView: (SearchResults & { phase: 'pending' | 'ready' | 'failed'; error?: string }) | undefined
let searchTimer: number | undefined
let activeTurnId: string | undefined
let codexContextReady = false
let selectedAttachmentContext: { accountId?: string; threadId: string; messageId: string; attachmentId: string; filename: string } | undefined
let mobilePanel: PanelName = 'messages'
let mobileReturnPanel: Exclude<PanelName, 'messages'> = 'reader'

type PanelName = 'messages' | 'reader' | 'agent'
interface PanelState {
  messages: boolean
  reader: boolean
  agent: boolean
  messagesWidth: number
  agentWidth: number
}

function loadPanelState(): PanelState {
  const defaults: PanelState = { messages: true, reader: true, agent: true, messagesWidth: 290, agentWidth: 340 }
  try {
    const saved = JSON.parse(localStorage.getItem('dispatch.panels.v1') ?? '{}') as Partial<PanelState>
    return {
      messages: saved.messages ?? defaults.messages,
      reader: saved.reader ?? defaults.reader,
      agent: saved.agent ?? defaults.agent,
      messagesWidth: Math.max(220, Math.min(640, saved.messagesWidth ?? defaults.messagesWidth)),
      agentWidth: Math.max(280, Math.min(900, saved.agentWidth ?? defaults.agentWidth)),
    }
  } catch {
    return defaults
  }
}

const panels = loadPanelState()
type SidebarStyle = 'compact' | 'expanded'
const savedSidebar = localStorage.getItem('dispatch.ui.sidebar')
let mailboxesVisible = savedSidebar !== 'hidden'
let sidebarStyle: SidebarStyle = (savedSidebar === 'expanded' || (savedSidebar === 'hidden' && localStorage.getItem('dispatch.ui.sidebar.last-visible') === 'expanded')) ? 'expanded' : 'compact'
let compactMessages = localStorage.getItem('dispatch.ui.density') !== 'comfortable'
document.documentElement.classList.toggle('dispatch-compact', compactMessages)

function usesMobilePanels(): boolean {
  return window.matchMedia('(max-width: 820px)').matches
}

function renderPanels(): void {
  const showMailboxes = mailboxesVisible && !usesMobilePanels()
  const displayedSidebarStyle = window.innerWidth < 1000 ? 'compact' : sidebarStyle
  app.querySelector<HTMLElement>('.dispatch-rail')!.hidden = !showMailboxes
  app.querySelector<HTMLElement>('.dispatch-rail')!.dataset.style = displayedSidebarStyle
  app.querySelectorAll('[data-sidebar-style]').forEach(button => button.setAttribute('aria-checked', String((button as HTMLElement).dataset.sidebarStyle === sidebarStyle)))
  const mailboxToggle = app.querySelector<HTMLButtonElement>('[data-mailboxes-toggle]')!
  mailboxToggle.setAttribute('aria-expanded', String(showMailboxes))
  mailboxToggle.setAttribute('aria-label', showMailboxes ? 'Hide mailboxes' : 'Show mailboxes')
  mailboxToggle.title = showMailboxes ? 'Hide mailboxes' : 'Show mailboxes'
  if (usesMobilePanels()) {
    elements.messagesPanel.hidden = mobilePanel !== 'messages'
    elements.readerPanel.hidden = mobilePanel !== 'reader'
    elements.agentPanel.hidden = mobilePanel !== 'agent'
    elements.messagesDivider.hidden = true
    elements.agentDivider.hidden = true
    elements.workspace.style.gridTemplateColumns = 'minmax(0, 1fr)'
    elements.toolbarMessages.style.width = ''
    elements.toolbarAgent.style.width = ''
    app.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((button) => {
      const active = button.dataset.panel === mobilePanel
      button.setAttribute('aria-pressed', String(active))
      button.classList.toggle('active', active)
    })
    return
  }
  const visible = (['messages', 'reader', 'agent'] as const).filter((name) => panels[name])
  if (visible.length === 0) panels.reader = true
  elements.messagesPanel.hidden = !panels.messages
  elements.readerPanel.hidden = !panels.reader
  elements.agentPanel.hidden = !panels.agent
  elements.messagesDivider.hidden = !(panels.messages && panels.reader)
  elements.agentDivider.hidden = !(panels.agent && (panels.reader || panels.messages))

  let messagesWidth = panels.messagesWidth
  let agentWidth = panels.agentWidth
  const railWidth = mailboxesVisible ? (displayedSidebarStyle === 'compact' ? 64 : 140) : 0
  const minimumReaderWidth = Math.max(220, Math.min(window.innerWidth <= 1100 ? 320 : 360, elements.workspace.clientWidth - railWidth - 518))
  if (panels.messages && panels.reader && panels.agent) {
    const sideWidth = Math.max(500, elements.workspace.clientWidth - railWidth - 18 - minimumReaderWidth)
    if (messagesWidth + agentWidth > sideWidth) {
      const scale = sideWidth / (messagesWidth + agentWidth)
      messagesWidth = Math.max(220, Math.round(messagesWidth * scale))
      agentWidth = Math.max(280, sideWidth - messagesWidth)
      if (messagesWidth + agentWidth > sideWidth) messagesWidth = Math.max(220, sideWidth - agentWidth)
    }
  }
  const columns: string[] = railWidth ? [`${railWidth}px`] : []
  if (panels.messages) columns.push(visible.length === 1 ? 'minmax(0, 1fr)' : `${messagesWidth}px`)
  if (!elements.messagesDivider.hidden) columns.push('9px')
  if (panels.reader) columns.push(`minmax(${minimumReaderWidth}px, 1fr)`)
  if (!elements.agentDivider.hidden) columns.push('9px')
  if (panels.agent) columns.push(visible.length === 1 ? 'minmax(0, 1fr)' : `${agentWidth}px`)
  elements.workspace.style.gridTemplateColumns = columns.join(' ')
  const messagesCluster = panels.messages && visible.length > 1
  const agentCluster = panels.agent && visible.length > 1
  elements.toolbarMessages.style.width = messagesCluster ? `${railWidth + messagesWidth + 9}px` : ''
  elements.toolbarAgent.style.width = agentCluster ? `${agentWidth + 9}px` : ''
  elements.toolbarMessages.classList.toggle('dispatch-toolbar-cluster-auto', !messagesCluster)
  elements.toolbarAgent.classList.toggle('dispatch-toolbar-cluster-auto', !agentCluster)
  elements.messagesDivider.setAttribute('aria-valuenow', String(Math.round(messagesWidth)))
  elements.agentDivider.setAttribute('aria-valuenow', String(Math.round(agentWidth)))
  app.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((button) => {
    const name = button.dataset.panel as PanelName
    button.setAttribute('aria-pressed', String(panels[name]))
    button.classList.toggle('active', panels[name])
  })
  localStorage.setItem('dispatch.panels.v1', JSON.stringify(panels))
}

/** Dragging a divider this far past its panel's minimum width closes the panel instead of pinning it. */
const CLOSE_DRAG_SLACK = 60

function resizePanel(name: 'messagesWidth' | 'agentWidth', event: PointerEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = panels[name]
  const direction = name === 'messagesWidth' ? 1 : -1
  const divider = event.currentTarget as HTMLElement
  divider.setPointerCapture?.(event.pointerId)
  document.body.classList.add('dispatch-resizing')
  const limit = name === 'messagesWidth' ? [220, 640] : [280, 900]
  const move = (next: PointerEvent) => {
    const requested = startWidth + ((next.clientX - startX) * direction)
    if (requested < limit[0]! - CLOSE_DRAG_SLACK) {
      panels[name] = limit[0]!
      panels[name === 'messagesWidth' ? 'messages' : 'agent'] = false
      renderPanels()
      stop()
      return
    }
    panels[name] = Math.max(limit[0]!, Math.min(limit[1]!, requested))
    renderPanels()
  }
  const stop = () => {
    document.body.classList.remove('dispatch-resizing')
    if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
}

function resizePanelWithKeyboard(name: 'messagesWidth' | 'agentWidth', event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const direction = name === 'messagesWidth' ? 1 : -1
  const limit = name === 'messagesWidth' ? [220, 640] : [280, 900]
  const delta = (event.key === 'ArrowRight' ? 20 : -20) * direction
  panels[name] = Math.max(limit[0]!, Math.min(limit[1]!, panels[name] + delta))
  renderPanels()
}

function defaultEmptyListMessage(): string {
  const label = mailbox === 'drafts' ? 'drafts' : mailbox
  if (mailState === 'unread') return `No unread messages in ${label}.`
  if (mailState === 'read') return `No read messages in ${label}.`
  return `No messages in ${label}.`
}

const mailboxLabels: Record<GmailMailbox, string> = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', spam: 'Spam', trash: 'Trash' }

function renderMailbox(): void {
  elements.mailboxTitle.textContent = mailboxLabels[mailbox]
  app.querySelectorAll<HTMLButtonElement>('[data-mailbox]').forEach((button) => {
    const active = button.dataset.mailbox === mailbox
    button.classList.toggle('active', active)
    button.setAttribute('aria-current', active ? 'page' : 'false')
  })
  elements.archive.hidden = mailbox !== 'inbox'
  elements.spam.hidden = mailbox === 'spam' || mailbox === 'trash'
  elements.trash.hidden = mailbox === 'trash'
  elements.moveInbox.hidden = mailbox !== 'archive' && mailbox !== 'spam' && mailbox !== 'trash'
}

const threadAttachmentCounts = new Map<string, number>()
const expandedAttachmentThreads = new Set<string>()

function attachmentIndicator(count?: number): HTMLElement {
  const indicator = document.createElement('span')
  indicator.className = 'dispatch-attachment-indicator text-primary'
  indicator.setAttribute('aria-label', count === undefined ? 'Has attachments' : `${count} attachments`)
  indicator.innerHTML = '<i class="ti ti-paperclip" aria-hidden="true"></i>'
  if (count !== undefined) indicator.append(document.createTextNode(String(count)))
  return indicator
}

function renderList(emptyMessage = defaultEmptyListMessage()): void {
  const focusedId = elements.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.conversationId : undefined
  renderListRows(emptyMessage)
  if (focusedId === undefined) return
  const focusId = selection.ids.length > 1 ? (selection.ids.includes(focusedId) ? focusedId : selection.anchor) : selectedConversationId ?? focusedId
  elements.list.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(focusId ?? focusedId)}"]`)?.focus()
}

function renderListRows(emptyMessage: string): void {
  elements.list.innerHTML = ''
  let localDrafts: RecoveryDraft[] = []
  if (mailbox === 'drafts' && !searchView) {
    try {
      localDrafts = recovery.list()
      for (const record of localDrafts) {
        if (selectedAccountId && record.accountId !== selectedAccountId) continue
        const row = document.createElement('button')
        row.className = 'list-group-item list-group-item-action dispatch-message'
        row.dataset.localDraftKey = record.key
        row.type = 'button'
        const title = document.createElement('strong'); title.textContent = record.subject || 'New message'
        const detail = document.createElement('small'); detail.textContent = record.to || 'No recipient'
        if (draftSyncErrors.has(record.key)) { detail.textContent += ' · Could not save'; detail.title = draftSyncErrors.get(record.key)! }
        row.append(title, document.createElement('br'), detail)
        row.onclick = () => { void restoreLocalDraft(record.key).catch(draftError) }
        elements.list.append(row)
      }
    } catch (error) { const notice = document.createElement('p'); notice.textContent = `Local drafts could not be read: ${String(error)}`; elements.list.append(notice) }
  }
  const listed = (searchView ? searchView.results.map(result => result.conversation) : conversations.filter(c => !localDrafts.some(record => record.accountId === c.accountId && record.gmailThreadId === c.threadId))).filter(c => !pendingMailboxRemovals.has(`${mailbox}:${c.id}`))
  renderSearchStatus()
  if (searchView) emptyMessage = searchView.phase === 'pending' ? 'Searching with Codex…' : searchView.phase === 'failed' ? searchView.error || 'Search failed.' : 'No matching conversations.'
  if (listed.length === 0) {
    if (elements.list.childElementCount) return
    const empty = document.createElement('div')
    empty.className = 'empty text-secondary p-4 dispatch-message-list-empty'
    empty.textContent = emptyMessage
    elements.list.append(empty)
    return
  }
  for (const conversation of listed) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'list-group-item list-group-item-action dispatch-message'
    button.dataset.conversationId = conversation.id
    const rowSelected = selection.ids.length > 1 ? selection.ids.includes(conversation.id) : selectedConversationId === conversation.id
    button.setAttribute('aria-selected', String(rowSelected))
    button.setAttribute('aria-label', `${conversation.sender.name}, ${conversation.subject}${conversation.unread ? ', unread' : ''}`)
    button.classList.toggle('dispatch-message-unread', conversation.unread)
    button.classList.toggle('active', rowSelected)
    button.draggable = true
    const avatar = document.createElement('span')
    avatar.className = 'avatar avatar-sm bg-blue-lt text-blue dispatch-avatar'
    avatar.textContent = conversation.sender.initials
    if (conversation.unread) {
      const unread = document.createElement('span')
      unread.className = 'avatar-status bg-blue'
      avatar.append(unread)
    }
    const content = document.createElement('span')
    const top = document.createElement('span')
    top.className = 'dispatch-message-top'
    const sender = document.createElement('strong')
    sender.textContent = conversation.sender.name
    sender.title = conversation.sender.name
    const time = document.createElement('time')
    time.textContent = conversation.receivedLabel
    top.append(sender, time)
    if (offlineMode && conversation.downloaded === false) { const unavailable = document.createElement('i'); unavailable.className = 'ti ti-cloud-off text-secondary'; unavailable.setAttribute('aria-label', 'Not downloaded'); top.append(unavailable) }
    const attachmentCount = threadAttachmentCounts.get(`${mailbox}:${conversation.id}`)
    if (attachmentCount ? attachmentCount > 0 : conversation.hasAttachment && attachmentCount !== 0) {
      top.append(attachmentIndicator(attachmentCount))
      button.setAttribute('aria-label', `${button.getAttribute('aria-label')}, has attachments`)
    }
    const subject = document.createElement('b')
    subject.textContent = conversation.subject
    subject.title = conversation.subject
    const preview = document.createElement('small')
    const match = searchView?.results.find(result => result.conversation.id === conversation.id)
    button.classList.toggle('dispatch-search-match', Boolean(match))
    if (match?.hits[0]) preview.append(resultExcerpt(match.hits[0]))
    else preview.textContent = conversation.preview
    preview.title = conversation.preview
    const account = document.createElement('span')
    account.className = 'dispatch-message-account'
    account.textContent = conversation.accountLabel ?? ''
    account.title = conversation.accountLabel ?? ''
    content.append(top, subject, preview)
    if (match?.hits[0]) {
      const reason = document.createElement('span')
      reason.className = 'dispatch-search-reason'
      reason.textContent = match.hits[0].reason
      content.append(reason)
    }
    if (conversation.accountLabel && accounts.length > 1) content.append(account)
    button.append(avatar, content)
    button.addEventListener('click', (event) => { void handleRowClick(conversation.id, event) })
    button.addEventListener('dragstart', (event) => startConversationDrag(conversation.id, event))
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      void openThreadContextMenu(event, conversation.id)
    })
    elements.list.append(button)
  }
  if (!searchView && nextConversationCursor) {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'btn btn-outline-secondary m-3 dispatch-load-more'
    more.textContent = loadingMoreConversations ? 'Loading more…' : `Load more · ${Math.max(0, conversationTotal - listed.length)} remaining`
    more.disabled = loadingMoreConversations
    more.addEventListener('click', () => { void loadMoreConversations() })
    elements.list.append(more)
  }
}

async function loadMoreConversations(): Promise<void> {
  if (!nextConversationCursor || loadingMoreConversations) return
  loadingMoreConversations = true
  renderList()
  try {
    const result = await api.listConversations(mailState, selectedAccountId, nextConversationCursor, searchQuery, mailbox, offlineMode)
    conversations = applyAcceptedReadState([...new Map([...conversations, ...result.conversations].map((conversation) => [conversation.id, conversation])).values()])
    nextConversationCursor = result.nextCursor ?? null
    conversationTotal = result.total ?? conversations.length
  } catch (error) {
    elements.mailError.hidden = false
    elements.mailError.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    loadingMoreConversations = false
    renderList()
  }
}

const accountPalette = ['var(--tblr-blue)', 'var(--tblr-green)', 'var(--tblr-yellow)', 'var(--tblr-purple)', 'var(--tblr-teal)']
function accountColor(accountId: string | undefined): string {
  const index = accounts.findIndex((account) => account.id === accountId)
  return accountPalette[index < 0 ? 0 : index % accountPalette.length]!
}

function renderCopyChip(availability: ConversationProjection['availability']): void {
  elements.copyStatus.hidden = availability?.mode !== 'downloaded'
  if (availability?.mode !== 'downloaded') return
  elements.copyStatus.dataset.mode = 'downloaded'
  elements.copyLabel.textContent = 'Downloaded copy'
  elements.copyStatus.title = `Showing the copy saved on this Mac · ${new Date(availability.cachedAt).toLocaleString()}${availability.reason ? ` · ${availability.reason}` : ''}`
}

function renderThreadMeta(summary: Pick<ConversationSummary, 'messageCount' | 'accountId' | 'accountLabel'>): void {
  const showCount = summary.messageCount > 1
  elements.messageCount.hidden = !showCount
  elements.countSep.hidden = !showCount
  elements.messageCount.textContent = showCount ? `${summary.messageCount} messages` : ''
  elements.threadMailbox.textContent = searchView ? 'Search result' : mailboxLabels[mailbox]
  const showAccount = Boolean(summary.accountLabel) && accounts.length > 1
  elements.address.hidden = !showAccount
  elements.accountDot.hidden = !showAccount
  elements.accountSep.hidden = !showAccount
  elements.address.textContent = summary.accountLabel ?? ''
  elements.accountDot.style.background = accountColor(summary.accountId)
}

function renderThreadMessage(message: MessageProjection, expanded: boolean): HTMLElement {
  const article = document.createElement('article')
  article.className = 'card dispatch-thread-message'
  article.dataset.messageId = message.id
  article.classList.toggle('dispatch-thread-collapsed', !expanded)
  const header = document.createElement('header')
  const avatar = document.createElement('span')
  avatar.className = 'avatar avatar-sm bg-blue-lt text-blue'
  avatar.textContent = message.sender.initials
  const identity = document.createElement('div')
  const name = document.createElement('strong')
  name.textContent = message.sender.name
  identity.append(name)
  if (expanded) {
    const address = document.createElement('small')
    const to = (message.to ?? []).map((item) => item.address).filter(Boolean).join(', ')
    address.textContent = to ? `${message.sender.address} · to ${to}` : message.sender.address
    identity.append(address)
  } else {
    const snippet = document.createElement('small')
    snippet.className = 'dispatch-thread-snippet'
    snippet.textContent = message.preview
    identity.append(snippet)
  }
  const time = document.createElement('time')
  time.dateTime = message.receivedAt
  time.textContent = expanded ? message.receivedFullLabel : message.receivedLabel
  header.append(avatar, identity, time)
  if (message.attachments.length) header.append(attachmentIndicator(message.attachments.length))
  article.append(header)
  if (!expanded) {
    article.tabIndex = 0
    article.setAttribute('role', 'button')
    article.setAttribute('aria-label', `Expand message from ${message.sender.name}`)
    const expand = () => { article.replaceWith(renderThreadMessage(message, true)) }
    article.addEventListener('click', expand)
    article.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        expand()
      }
    })
    return article
  }
  const content = renderEmailContent(message.body.kind, message.body.content, offlineMode || selected?.availability?.mode === 'downloaded')
  content.classList.add('dispatch-thread-content')
  const applySurface = () => {
    applyMailAppearance(content, theme.resolved === 'dark', mailSurfaceOverrides.get(message.id))
    surfaceToggle.textContent = content.dataset.paper === 'true' ? 'Show in dark' : 'Show in light'
    surfaceToggle.setAttribute('aria-pressed', String(content.dataset.paper === 'true'))
  }
  const surfaceToggle = document.createElement('button')
  surfaceToggle.type = 'button'
  surfaceToggle.className = 'btn btn-sm btn-ghost-secondary dispatch-thread-surface'
  surfaceToggle.dataset.surfaceToggle = ''
  surfaceToggle.title = 'Message appearance'
  surfaceToggle.addEventListener('click', (event) => {
    event.stopPropagation()
    mailSurfaceOverrides.set(message.id, content.dataset.paper === 'true' ? 'dark' : 'light')
    applySurface()
  })
  header.append(surfaceToggle)
  applySurface()
  article.append(content)
  if (message.attachments.length > 0) {
    const attachmentList = document.createElement('div')
    attachmentList.className = 'dispatch-thread-attachments'
    const previews = document.createElement('div')
    previews.className = 'dispatch-attachment-previews'
    for (const attachment of message.attachments) {
      if (attachment.contentId && message.body.kind === 'sanitized-html' && message.body.content.includes(encodeURIComponent(attachment.id))) continue
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'btn btn-sm dispatch-thread-attachment'
      const badge = document.createElement('span')
      badge.className = 'badge bg-blue-lt text-blue'
      badge.textContent = attachment.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'
      const attachmentName = document.createElement('strong')
      attachmentName.textContent = attachment.name
      const size = document.createElement('small')
      size.textContent = attachment.sizeLabel
      item.append(badge, attachmentName, size)
      item.addEventListener('click', () => { void openAttachment(message, attachment.id, attachment.name) })
      attachmentList.append(item)
      const fileUrl = api.attachmentFileUrl(message.id, attachment.id, message.accountId, attachment.name, offlineMode || selected?.availability?.mode === 'downloaded')
      if (attachment.mediaType.startsWith('image/')) {
        const figure = document.createElement('figure')
        figure.className = 'dispatch-attachment-preview'
        const image = document.createElement('img')
        image.src = fileUrl
        image.alt = attachment.name
        image.loading = 'lazy'
        image.addEventListener('click', () => { void openAttachment(message, attachment.id, attachment.name) })
        figure.append(image)
        previews.append(figure)
      } else if (attachment.mediaType === 'application/pdf') {
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'btn btn-sm btn-ghost-secondary dispatch-attachment-preview-toggle'
        toggle.textContent = 'Preview'
        toggle.setAttribute('aria-expanded', 'false')
        toggle.setAttribute('aria-label', `Preview ${attachment.name}`)
        let frame: HTMLIFrameElement | undefined
        toggle.addEventListener('click', () => {
          if (frame) {
            frame.remove()
            frame = undefined
            toggle.textContent = 'Preview'
            toggle.setAttribute('aria-expanded', 'false')
            return
          }
          frame = document.createElement('iframe')
          frame.className = 'dispatch-attachment-frame'
          frame.src = fileUrl
          frame.title = attachment.name
          previews.append(frame)
          toggle.textContent = 'Hide preview'
          toggle.setAttribute('aria-expanded', 'true')
        })
        attachmentList.append(toggle)
      }
    }
    article.append(attachmentList)
    if (previews.childElementCount > 0 || attachmentList.querySelector('.dispatch-attachment-preview-toggle')) article.append(previews)
  }
  return article
}

/**
 * Warms the mail cache for every attachment in the thread, newest message
 * first, so opening or previewing one later is instant. Stops as soon as the
 * selection moves on; failures are left for the explicit open to report.
 */
async function warmAttachments(conversation: ConversationProjection, sequence: number): Promise<void> {
  const ordered = [...conversation.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  for (const message of ordered) {
    for (const attachment of message.attachments) {
      if (sequence !== selectionSequence) return
      try {
        await api.cacheAttachment(message.id, attachment.id, message.accountId, attachment.name)
      } catch {
        // The explicit open reports connector failures; warming stays silent.
      }
    }
  }
}

async function openAttachment(message: MessageProjection, attachmentId: string, filename: string): Promise<void> {
  selectedAttachmentContext = { accountId: message.accountId, threadId: message.threadId, messageId: message.id, attachmentId, filename }
  try {
    await api.openAttachment(message.id, attachmentId, message.accountId, filename, offlineMode || selected?.availability?.mode === 'downloaded')
    addAgentMessage('tool', `Opened ${filename}`)
  } catch (error) { addAgentMessage('error', error instanceof Error ? error.message : String(error)) }
}

async function selectConversation(id: string, options: { revealOnMobile?: boolean; startReadDwell?: boolean; refresh?: boolean } = {}): Promise<void> {
  markReadDwell.cancel()
  const matchResult = searchView?.results.find(result => result.conversation.id === id)
  const summary = matchResult?.conversation ?? conversations.find((conversation) => conversation.id === id)
  if (!summary) return
  readerNeedsRetry = false
  // Navigation depends only on a durable local checkpoint. The existing save
  // flight and outbox finish independently of the selected email.
  if (activeDraft && draftDirty) {
    if (!checkpointDraft()) return
    scheduleDraftSync(0)
  }
  const sequence = ++selectionSequence
  const keepCodex = options.refresh && id === selectedConversationId && codexContextReady
  if (!keepCodex) {
    selectCodexContext(conversationBindingKey({ ...summary, source: summary.accountId ? 'gmail' : summary.id.startsWith('demo:') ? 'demo' : undefined }))
    selectedAttachmentContext = undefined
    codexContextReady = false
  }
  if (sequence !== selectionSequence) return
  if (options.revealOnMobile && usesMobilePanels()) {
    mobilePanel = 'reader'
    mobileReturnPanel = 'reader'
    renderPanels()
  }
  selectedConversationId = id
  selection = { ids: [id], anchor: id }
  selectedSummary = summary
  selected = undefined
  activeDraft = undefined
  recoveryKey = undefined
  draftEditSession += 1
  draftDirty = false
  if (draftPreviewTimer !== undefined) window.clearTimeout(draftPreviewTimer)
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  renderList()
  elements.readerEmpty.hidden = true
  elements.reader.hidden = false
  elements.reader.classList.remove('dispatch-drafting')
  elements.reader.classList.remove('dispatch-composing')
  elements.reader.classList.remove('dispatch-multi')
  elements.body.hidden = false
  renderMailbox()
  elements.draft.hidden = true
  elements.body.hidden = false
  elements.attachments.hidden = false
  elements.copyStatus.hidden = true
  elements.subject.textContent = summary.subject
  renderThreadMeta(summary)
  const loading = document.createElement('div')
  loading.className = 'empty text-secondary dispatch-reader-loading'
  loading.textContent = 'Loading conversation…'
  elements.body.replaceChildren(loading)
  elements.attachments.replaceChildren()
  elements.threadFilesToggle.hidden = true
  if (!offlineMode && options.startReadDwell && summary.unread && summary.accountId) {
    const conversationId = summary.id
    markReadDwell.schedule(conversationId, () => { void completeReadDwell(conversationId) })
  }

  if (!offlineMode && !searchView && mailbox === 'drafts' && summary.accountId) {
    try {
      const draft = await api.openDraftFromMessage(summary.accountId, summary.latestMessageId, summary.threadId)
      if (sequence !== selectionSequence || selectedConversationId !== id) return
      showDraft(draft, false)
      if (draft.cachedAt) void refreshOpenedDraft(draft, sequence, draftEditRevision)
      try {
        const key = conversationBindingKey({ accountId: summary.accountId, threadId: summary.threadId })
        await bindAndShowCodex(key, { sequence })
      } catch (error) {
        if (sequence !== selectionSequence) return
        elements.stream.replaceChildren()
        addAgentMessage('error', error instanceof Error ? error.message : String(error))
      }
    } catch (error) {
      if (sequence !== selectionSequence) return
      const detail = error instanceof Error ? error.message : String(error)
      const gone = detail.includes('gmail_draft_not_found')
      loading.className = 'alert alert-danger m-4 dispatch-reader-load-error'
      loading.textContent = gone ? 'This draft was sent or deleted.' : 'Gmail is unavailable. This draft will open when the connection returns.'
      if (gone) {
        conversations = conversations.filter(item => item.id !== id)
        selectedConversationId = undefined; selectedSummary = undefined
        renderList()
        void loadConversations()
      }
    }
    return
  }

  const key = `${offlineMode ? 'offline:' : ''}${mailbox}:${summary.accountId ?? selectedAccountId ?? ''}:${summary.threadId}`
  let request = conversationCache.get(key)
  if (!request) {
    request = api.readConversation(summary.threadId, summary.accountId ?? selectedAccountId, offlineMode, mailbox)
    conversationCache.set(key, request)
    request.catch(() => conversationCache.delete(key))
  }

  try {
    const conversation = await request
    if (sequence !== selectionSequence || selectedConversationId !== id) return
    // Cached bodies can have old labels. The current mailbox projection and
    // accepted commands own the row and toolbar's read state together.
    const currentSummary = conversations.find(item => item.id === id) ?? summary
    selected = { ...conversation, unread: acceptedReadState.get(id) ?? currentSummary.unread }
    readerNeedsRetry = !offlineMode && conversation.availability?.mode === 'downloaded'
    renderCopyChip(conversation.availability)
    if (conversation.availability?.mode === 'downloaded') markReadDwell.cancel()
    elements.readState.hidden = !conversation.accountId
    renderReadState(selected.unread)
    elements.subject.textContent = conversation.subject
    renderThreadMeta({ ...conversation, messageCount: conversation.messages.length })
    const newestFirst = [...conversation.messages].sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
    elements.body.replaceChildren(...newestFirst.map((message, index) => renderThreadMessage(message, index === 0 || Boolean(matchResult?.hits.some(hit => hit.messageId === message.id)))))
    const attachmentCount = newestFirst.reduce((count, message) => count + message.attachments.length, 0)
    threadAttachmentCounts.set(`${mailbox}:${id}`, attachmentCount)
    renderList()
    if (attachmentCount > 0) {
      const files = renderThreadAttachments(newestFirst, (message, attachmentId, name) => {
        void openAttachment(message, attachmentId, name)
      }, (message) => {
        const article = [...elements.body.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.dataset.messageId === message.id)
        if (!article) return
        const expanded = renderThreadMessage(message, true)
        article.replaceWith(expanded)
        expanded.tabIndex = -1
        expanded.focus({ preventScroll: true })
        expanded.scrollIntoView({ block: 'nearest' })
      })
      const toggle = elements.threadFilesToggle
      const renderDisclosure = () => {
        const expanded = expandedAttachmentThreads.has(id)
        files.hidden = !expanded
        toggle.setAttribute('aria-expanded', String(expanded))
        toggle.innerHTML = `<i class="ti ti-paperclip" aria-hidden="true"></i>${attachmentCount} ${attachmentCount === 1 ? 'attachment' : 'attachments'}<i class="ti ti-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></i>`
      }
      toggle.onclick = () => {
        if (expandedAttachmentThreads.has(id)) expandedAttachmentThreads.delete(id)
        else expandedAttachmentThreads.add(id)
        renderDisclosure()
      }
      toggle.hidden = false
      elements.body.prepend(files)
      renderDisclosure()
    }
    // Replacing a thread must not retain the previous thread's scroll offset.
    // Search hits below may intentionally move to their matching passage.
    elements.body.scrollTop = 0
    if (matchResult) {
      for (const hit of matchResult.hits) {
        const message = [...elements.body.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === hit.messageId)
        const content = message?.querySelector<HTMLElement>('.dispatch-thread-content')
        if (content && !highlightPassage(content, hit.quote)) {
          const evidence = document.createElement('div')
          evidence.className = 'dispatch-search-evidence'
          evidence.append(resultExcerpt(hit)); content.before(evidence)
        }
      }
      const first = matchResult.hits[0]
      if (first) {
        const message = [...elements.body.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === first.messageId)
        ;(message?.querySelector('mark') ?? message)?.scrollIntoView({ block: 'center' })
      }
    }
    if (!offlineMode && conversation.availability?.mode !== 'downloaded') void warmAttachments(conversation, sequence)
    prefetchConversations(id)
    if (keepCodex) return
    try {
      const key = conversationBindingKey({ accountId: conversation.accountId, threadId: conversation.threadId, source: conversation.source })
      if (bindingCacheKey(key) !== bindingCacheKey(desiredCodexKey)) selectCodexContext(key)
      await bindAndShowCodex(key, { sequence })
    } catch (error) {
      if (sequence !== selectionSequence) return
      elements.stream.replaceChildren()
      addAgentMessage('error', error instanceof Error ? error.message : String(error))
    }
  } catch (error) {
    if (sequence !== selectionSequence) return
    readerNeedsRetry = true
    loading.className = 'alert alert-danger m-4 dispatch-reader-load-error'
    loading.textContent = 'This message is not available yet. Dispatch will retry when Gmail reconnects.'
    const retry = document.createElement('button')
    retry.type = 'button'; retry.className = 'btn btn-sm btn-outline-primary ms-2'; retry.textContent = 'Retry message'
    retry.onclick = () => { if (!activeDraft && selectedConversationId === id) void selectConversation(id) }
    loading.append(retry)
if (!offlineMode && !String(error).includes('not_downloaded')) window.setTimeout(() => {
      if (sequence === selectionSequence && !activeDraft && selectedConversationId === id) void selectConversation(id)
    }, 5_000)
  }
}

async function completeReadDwell(conversationId: string): Promise<void> {
  if (selectedConversationId !== conversationId) return
  const summary = conversations.find((conversation) => conversation.id === conversationId)
  if (!summary?.accountId || !summary.unread) return
  const actionSequence = readStateActionSequence
  const messageIds = selectedConversationId === conversationId && selected ? selected.messages.map((message) => message.id) : []
  try {
    await api.setConversationUnread(summary.threadId, summary.accountId, false, messageIds)
    if (selectedConversationId !== conversationId || actionSequence !== readStateActionSequence) return
    applyLocalReadState(conversationId, false)
  } catch (error) {
    if (selectedConversationId !== conversationId) return
    elements.mailError.hidden = false
    elements.mailError.textContent = error instanceof Error ? error.message : String(error)
  }
}

function applyLocalReadState(conversationId: string, unread: boolean): void {
  acceptedReadState.set(conversationId, unread)
  dropConversationCache(conversationId)
  if (selectedConversationId === conversationId && selected) selected = { ...selected, unread }
  conversations = conversations
    .map((conversation) => conversation.id === conversationId ? { ...conversation, unread } : conversation)
    .filter((conversation) => mailState === 'all' || (mailState === 'unread' ? conversation.unread : !conversation.unread))
  if (selectedConversationId === conversationId) renderReadState(unread)
  renderList()
}

function dropConversationCache(conversationId: string): void {
  const threadId = (selectedConversationId === conversationId ? selected?.threadId : undefined)
    ?? conversations.find((conversation) => conversation.id === conversationId)?.threadId
  if (!threadId) return
  for (const key of conversationCache.keys()) {
    if (key.endsWith(`:${threadId}`)) conversationCache.delete(key)
  }
}

function applyAcceptedReadState(items: readonly ConversationSummary[]): ConversationSummary[] {
  return items
    .map((conversation) => {
      const unread = acceptedReadState.get(conversation.id)
      return unread === undefined ? conversation : { ...conversation, unread }
    })
    .filter((conversation) => mailState === 'all' || (mailState === 'unread' ? conversation.unread : !conversation.unread))
}

function syncSelectedReadState(): void {
  if (!selected || !selectedConversationId) return
  const unread = acceptedReadState.get(selectedConversationId)
    ?? conversations.find((conversation) => conversation.id === selectedConversationId)?.unread
  if (unread === undefined || selected.unread === unread) return
  selected = { ...selected, unread }
  renderReadState(unread)
}

function renderReadState(unread: boolean, busy = false): void {
  const label = unread ? 'Mark read' : 'Mark unread'
  elements.readState.setAttribute('aria-label', busy ? (unread ? 'Marking read…' : 'Marking unread…') : label)
  elements.readState.title = label
  elements.readStateIcon.className = unread ? 'ti ti-mail-opened' : 'ti ti-mail'
  elements.readStateLabel.textContent = unread ? 'Read' : 'Unread'
}

async function applyReadState(nextUnread: boolean, target: ConversationSummary | undefined = selected): Promise<void> {
  if (!target?.accountId) return
  markReadDwell.cancel()
  readStateActionSequence += 1
  const conversationId = target.id
  const messageIds = selected?.id === conversationId ? selected.messages.map(message => message.id) : []
  elements.readState.disabled = true
  renderReadState(!nextUnread, true)
  try {
    await api.setConversationUnread(target.threadId, target.accountId, nextUnread, messageIds)
    applyLocalReadState(conversationId, nextUnread)
  } catch (error) {
    if (selectedConversationId === conversationId) renderReadState(selected?.unread ?? target.unread)
    elements.mailError.hidden = false
    elements.mailError.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    elements.readState.disabled = false
  }
}

async function toggleReadState(): Promise<void> {
  if (!selected) return
  await applyReadState(!selected.unread)
}

function askCodex(): void {
  if (usesMobilePanels()) { mobilePanel = 'agent'; mobileReturnPanel = 'agent'; renderPanels() }
  elements.prompt.focus()
}

async function openThreadContextMenu(event: MouseEvent, conversationId: string): Promise<void> {
  if (selection.ids.length > 1 && selection.ids.includes(conversationId)) {
    const targets = listedConversations().filter((conversation) => selection.ids.includes(conversation.id))
    const items = threadContextMenuItems({ mailbox, unread: false, hasAccountId: targets.every((conversation) => Boolean(conversation.accountId)), count: targets.length })
    try {
      const chosen = await popupContextMenu(items, { clientX: event.clientX, clientY: event.clientY })
      if (chosen === 'archive' || chosen === 'inbox' || chosen === 'spam' || chosen === 'trash') await mutateConversations(targets.map((conversation) => conversation.id), chosen)
    } catch (error) {
      elements.mailError.hidden = false
      elements.mailError.textContent = error instanceof Error ? error.message : String(error)
    }
    return
  }
  const load = selectConversation(conversationId, { revealOnMobile: true })
  const summary = conversations.find((conversation) => conversation.id === conversationId)
  if (!summary) return
  const unread = acceptedReadState.get(conversationId) ?? summary.unread
  const items = threadContextMenuItems({ mailbox, unread, hasAccountId: Boolean(summary.accountId) })
  try {
    const chosen = await popupContextMenu(items, { clientX: event.clientX, clientY: event.clientY })
    if (!chosen) return
    if (chosen === 'markRead' || chosen === 'markUnread') {
      await applyReadState(chosen === 'markUnread', summary)
      return
    }
    await load
    await runThreadContextCommand(chosen)
  } catch (error) {
    elements.mailError.hidden = false
    elements.mailError.textContent = error instanceof Error ? error.message : String(error)
  }
}

async function runThreadContextCommand(id: string): Promise<void> {
  switch (id) {
    case 'reply':
      await openDraft(false).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error)))
      return
    case 'replyAll':
      await openDraft(true).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error)))
      return
    case 'forward':
      await openForward().catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error)))
      return
    case 'markRead':
      await applyReadState(false)
      return
    case 'markUnread':
      await applyReadState(true)
      return
    case 'archive':
      await mutateSelected('archive')
      return
    case 'inbox':
      await mutateSelected('inbox')
      return
    case 'spam':
      await mutateSelected('spam')
      return
    case 'trash':
      await mutateSelected('trash')
      return
    case 'ask':
      askCodex()
      return
    default:
      throw new Error(`Dispatch received an unknown menu command: ${id}`)
  }
}

function prefetchConversations(exceptId: string): void {
  for (const summary of (searchView?.results.map(result => result.conversation) ?? conversations).filter((item) => item.id !== exceptId).slice(0, 3)) {
    const key = `${offlineMode ? 'offline:' : ''}${mailbox}:${summary.accountId ?? selectedAccountId ?? ''}:${summary.threadId}`
    if (!conversationCache.has(key)) {
      const request = api.readConversation(summary.threadId, summary.accountId ?? selectedAccountId, offlineMode, mailbox)
      conversationCache.set(key, request)
      request.catch(() => conversationCache.delete(key))
    }
  }
}

function draftAddressList(addresses: readonly MailAddress[] | undefined): string {
  return (addresses ?? []).map((address) => address.address).filter(Boolean).join(', ')
}

function recipientField(input: HTMLInputElement): HTMLElement {
  const field = input.closest<HTMLElement>('[data-recipient-field]')
  if (!field) throw new Error('Draft recipient field is missing')
  return field
}

function recipientChipAddresses(input: HTMLInputElement): string[] {
  return [...recipientField(input).querySelectorAll('[data-recipient-address]')].map((chip) => chip.getAttribute('data-recipient-address') ?? '').filter(Boolean)
}

function recipientValue(input: HTMLInputElement): string {
  return serializeRecipientList(recipientChipAddresses(input), input.value)
}

function hideRecipientSuggestions(input: HTMLInputElement): void {
  const list = recipientField(input).querySelector<HTMLElement>('.dispatch-recipient-suggestions')
  if (!list) return
  list.hidden = true
  list.replaceChildren()
}

function renderRecipientChips(input: HTMLInputElement, addresses: readonly string[]): void {
  const chips = recipientField(input).querySelector('.dispatch-recipient-chips')
  if (!chips) throw new Error('Draft recipient chips are missing')
  chips.replaceChildren(...[...new Set(addresses.filter(Boolean))].map((address) => {
    const chip = document.createElement('span')
    chip.className = 'dispatch-recipient-chip'
    chip.dataset.recipientAddress = address
    const label = document.createElement('span')
    label.textContent = address
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn-close'
    remove.setAttribute('aria-label', `Remove ${address}`)
    remove.addEventListener('click', () => {
      chip.remove()
      hideRecipientSuggestions(input)
      markDraftDirty()
      if (activeDraft?.id) autosaveDraft()
    })
    chip.append(label, remove)
    return chip
  }))
}

function setRecipientField(input: HTMLInputElement, value: string): void {
  renderRecipientChips(input, parseRecipientList(value))
  input.value = ''
  hideRecipientSuggestions(input)
}

function addRecipientChip(input: HTMLInputElement, address: string): void {
  const next = address.trim()
  if (!next) return
  renderRecipientChips(input, [...recipientChipAddresses(input), next])
  input.value = ''
  hideRecipientSuggestions(input)
}

async function suggestRecipients(input: HTMLInputElement): Promise<void> {
  const query = input.value.trim()
  const list = recipientField(input).querySelector<HTMLElement>('.dispatch-recipient-suggestions')
  if (!list) return
  if (!query) {
    hideRecipientSuggestions(input)
    return
  }
  const accountId = activeDraft?.accountId || elements.draftAccount.value || selectedAccountId
  try {
    const recipients = await api.listRecipients(query, accountId)
    const exclude = new Set(recipientChipAddresses(input).map((address) => address.toLowerCase()))
    const matches = recipients.filter((recipient) => !exclude.has(recipient.address.toLowerCase()))
    if (matches.length === 0) {
      hideRecipientSuggestions(input)
      return
    }
    list.replaceChildren(...matches.map((recipient) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.className = 'dropdown-item'
      item.textContent = recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address
      item.addEventListener('mousedown', (event) => {
        event.preventDefault()
        addRecipientChip(input, recipient.address)
        markDraftDirty()
        if (activeDraft?.id) autosaveDraft()
      })
      return item
    }))
    list.hidden = false
  } catch (error) {
    hideRecipientSuggestions(input)
    draftError(error)
  }
}

function scheduleRecipientSuggestions(input: HTMLInputElement): void {
  if (recipientSuggestTimer !== undefined) window.clearTimeout(recipientSuggestTimer)
  recipientSuggestTimer = window.setTimeout(() => {
    void suggestRecipients(input)
  }, 150)
}

function acceptRecipientInput(input: HTMLInputElement): void {
  const leftover = input.value.trim()
  if (!leftover) return
  addRecipientChip(input, leftover)
}

function onRecipientInput(input: HTMLInputElement): void {
  const parsed = commitRecipientToken(input.value)
  if (parsed.committed.length > 0) {
    renderRecipientChips(input, [...recipientChipAddresses(input), ...parsed.committed])
    input.value = parsed.leftover
  }
  scheduleRecipientSuggestions(input)
}

const draftAttachmentObjectUrls = new Set<string>()

function clearDraftAttachmentObjectUrls(): void {
  for (const url of draftAttachmentObjectUrls) URL.revokeObjectURL(url)
  draftAttachmentObjectUrls.clear()
}

function draftAttachmentFileUrl(draft: DraftProjection, attachment: DraftProjection['attachments'][number]): string | undefined {
  if (attachment.contentBase64) {
    const bytes = Uint8Array.from(atob(attachment.contentBase64), (char) => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mediaType }))
    draftAttachmentObjectUrls.add(url)
    return url
  }
  const messageId = attachment.sourceMessageId ?? draft.gmailMessageId
  return messageId && attachment.id
    ? api.attachmentFileUrl(messageId, attachment.id, draft.accountId, attachment.name)
    : undefined
}

async function openDraftAttachment(draft: DraftProjection, attachment: DraftProjection['attachments'][number]): Promise<void> {
  try {
    if (attachment.contentBase64) await api.openLocalDraftAttachment(attachment.name, attachment.contentBase64)
    else {
      const messageId = attachment.sourceMessageId ?? draft.gmailMessageId
      if (!messageId || !attachment.id) throw new Error('This attachment has no file identity. Reopen the draft and try again.')
      await api.openAttachment(messageId, attachment.id, draft.accountId, attachment.name)
    }
  } catch (error) { draftError(error) }
}

function renderDraftAttachments(): void {
  clearDraftAttachmentObjectUrls()
  const items = activeDraft?.attachments ?? []
  elements.draftAttachments.replaceChildren(...items.map((attachment, index) => {
    const row = document.createElement('li')
    row.className = 'dispatch-draft-attachment'
    const actions = document.createElement('div')
    actions.className = 'dispatch-draft-attachment-actions'
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'btn btn-sm btn-ghost-secondary dispatch-draft-attachment-open'
    open.textContent = attachment.name
    open.setAttribute('aria-label', `Open ${attachment.name}`)
    const draft = activeDraft!
    open.disabled = !attachment.contentBase64 && !(attachment.id && (attachment.sourceMessageId || draft.gmailMessageId))
    open.addEventListener('click', () => { void openDraftAttachment(draft, attachment) })
    actions.append(open)
    if (attachment.mediaType.startsWith('image/') || attachment.mediaType === 'application/pdf') {
      const fileUrl = draftAttachmentFileUrl(draft, attachment)
      if (fileUrl) {
        const preview = document.createElement('button')
        preview.type = 'button'
        preview.className = 'btn btn-sm btn-ghost-secondary'
        preview.textContent = 'Preview'
        preview.setAttribute('aria-label', `Preview ${attachment.name}`)
        preview.setAttribute('aria-expanded', 'false')
        const container = document.createElement('div')
        container.className = 'dispatch-draft-attachment-preview'
        preview.addEventListener('click', () => {
          const expanded = preview.getAttribute('aria-expanded') === 'true'
          container.replaceChildren()
          if (!expanded) {
            const content = attachment.mediaType === 'application/pdf' ? document.createElement('iframe') : document.createElement('img')
            content.className = 'dispatch-attachment-frame'
            content.src = fileUrl
            if (content instanceof HTMLIFrameElement) content.title = attachment.name
            else content.alt = attachment.name
            container.append(content)
          }
          preview.setAttribute('aria-expanded', String(!expanded))
          preview.textContent = expanded ? 'Preview' : 'Hide preview'
        })
        actions.append(preview)
        row.append(container)
      }
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn btn-sm btn-ghost-secondary'
    remove.setAttribute('aria-label', `Remove attachment ${attachment.name}`)
    remove.addEventListener('click', () => {
      if (!activeDraft) return
      activeDraft = { ...activeDraft, attachments: activeDraft.attachments.filter((_, itemIndex) => itemIndex !== index) }
      renderDraftAttachments()
      markDraftDirty()
      if (activeDraft.id) void saveDraft(false).catch(draftError)
    })
    actions.append(remove)
    row.prepend(actions)
    return row
  }))
  elements.draftAttachments.hidden = items.length === 0
}

async function refreshOpenedDraft(draft: DraftProjection, sequence: number, revision: number): Promise<void> {
  if (!draft.accountId) return
  const current = () => sequence === selectionSequence && activeDraft?.id === draft.id && activeDraft.accountId === draft.accountId && !draftDirty && draftEditRevision === revision
  try {
    const fresh = await api.getDraft(draft.id, draft.accountId)
    if (current()) showDraft(fresh, false)
  } catch (error) {
    if (!current()) return
    if (String(error).includes('gmail_draft_not_found')) {
      hideDraftEditor()
      void loadConversations()
    } else {
      elements.recoveryStatus.textContent = 'Waiting for Gmail'
    }
  }
}

function checkpointDraft(): boolean {
  if (!activeDraft) return true
  if (!activeDraft.id && draftSeed?.fields === editorFields() && draftSeed.attachments === activeDraft.attachments) {
    // Reserve the identity for edits made while the initial Gmail create is
    // pending, without listing an untouched reply as an unsaved draft.
    recoveryKey ??= crypto.randomUUID()
    try { recovery.remove(recoveryKey); renderRecoveryList() } catch (error) { draftError(error); return false }
    return true
  }
  try {
    recoveryKey ??= crypto.randomUUID()
    const accountId = activeDraft.id ? activeDraft.accountId : elements.draftAccount.value || activeDraft.accountId
    recovery.save({ key: recoveryKey, updatedAt: new Date().toISOString(), revision: draftEditRevision,
      gmailThreadId: activeDraft.gmailThreadId ?? selected?.threadId,
      accountId, accountLabel: accounts.find(account => account.id === accountId)?.email, gmailDraftId: activeDraft.id,
      inReplyToMessageId: activeDraft.inReplyToMessageId, to: recipientValue(elements.draftTo), cc: recipientValue(elements.draftCc), bcc: recipientValue(elements.draftBcc), subject: elements.draftSubject.value, bodyMarkdown: elements.draftBody.value,
    }, activeDraft.attachments)
    elements.recoveryStatus.textContent = 'Saved · waiting to sync'
    scheduleDraftSync()
    renderRecoveryList()
    const draftId = activeDraft.id
    void recovery.cacheFiles(activeDraft.attachments).then(() => {
      if (activeDraft?.id === draftId && draftDirty && recoveryKey) {
        const pending = recovery.list().find(item => item.key === recoveryKey)?.attachments.some(file => file.contentPending)
        if (pending) checkpointDraft()
      }
    }).catch(draftError)
    return true
  } catch (error) { draftError(new Error('This device could not save your draft. Keep it open and free some disk space before leaving.')); return false }
}
function clearRecovery(key = recoveryKey): void {
  if (!key) return
  try { recovery.remove(key) } catch (error) { draftError(new Error(`Gmail action completed, but the local recovery copy could not be cleared: ${String(error)}`)); return }
  if (key === recoveryKey) recoveryKey = undefined
  renderRecoveryList()
}
function renderRecoveryList(): void {
  if (mailbox === 'drafts') renderList()
}
async function restoreLocalDraft(key: string): Promise<void> {
  if (activeDraft && draftDirty) checkpointDraft()
  const sequence = ++selectionSequence
  let codexKey: CodexPaneKey = { kind: 'draft', draftKey: key }
  selectCodexContext(codexKey)
  const restored = await recovery.restore(key)
  if (sequence !== selectionSequence) return
  const record = restored.record
  if (record.gmailThreadId && record.accountId) {
    codexKey = { kind: 'conversation', accountId: record.accountId, gmailThreadId: record.gmailThreadId }
    selectCodexContext(codexKey)
  }
  selected = undefined; selectedConversationId = undefined; selectedAttachmentContext = undefined
  selectedSummary = undefined
  codexContextReady = false
  elements.subject.textContent = record.subject || 'New message'
  elements.messageCount.textContent = 'Local draft'
  elements.copyStatus.hidden = true
  elements.address.hidden = true
  showDraft({ id: record.gmailDraftId, accountId: record.accountId, inReplyToMessageId: record.inReplyToMessageId,
    gmailThreadId: record.gmailThreadId,
    to: parseRecipientList(record.to).map(address => ({ name: address, address, initials: '@' })), cc: record.cc, bcc: record.bcc, subject: record.subject, bodyMarkdown: record.bodyMarkdown, bodyText: record.bodyMarkdown, bodyHtml: '', attachments: restored.attachments, state: 'draft' }, !record.gmailDraftId)
  draftSeed = undefined
  recoveryKey = key; draftDirty = true; draftEditRevision = Math.max(draftEditRevision, record.revision) + 1
  elements.recoveryStatus.textContent = 'Saved · waiting to sync'
  if (restored.missing.length) draftError(new Error(`Reattach these files before saving: ${restored.missing.join(', ')}`))
  refreshPreview()
  if (!offlineMode) void bindAndShowCodex(codexKey, { sequence })
}
function freezeDraft(disabled: boolean): void {
  elements.draft.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button').forEach(control => { control.disabled = disabled })
  if (!disabled) elements.draftAccount.disabled = Boolean(activeDraft?.id)
  if (!disabled) elements.sendDraft.disabled = Boolean(activeDraft?.cachedAt)
}

function draftError(error: unknown): void {
  if (retryableDraftError(error)) {
    elements.recoveryStatus.textContent = 'Saved · waiting to sync'
    elements.draftError.hidden = true
    scheduleDraftSync()
    if (!elements.sendConfirm.hidden) {
      elements.draftError.hidden = false
      elements.draftError.textContent = 'Sending could not be confirmed. Your draft is kept. Check Sent before trying again.'
    }
    return
  }
  elements.draftError.hidden = false
  const detail = error instanceof Error ? error.message : String(error)
  elements.draftError.textContent = describeRequestError(detail)
}

function replyQuoteMarkdown(message: MessageProjection): string {
  const content = emailPlainText(message.body.kind, message.body.content)
  return `\n\n> ${content.split(/\r?\n/).join('\n> ')}`
}

function setDraftCollapsed(collapsed: boolean): void {
  app.querySelector<HTMLElement>('[data-draft-content]')!.hidden = collapsed
  elements.reader.classList.toggle('dispatch-draft-collapsed', collapsed)
  const button = app.querySelector<HTMLButtonElement>('[data-collapse-draft]')!
  button.setAttribute('aria-expanded', String(!collapsed))
  button.innerHTML = `<i class="ti ti-chevron-${collapsed ? 'up' : 'down'} me-1" aria-hidden="true"></i>${collapsed ? 'Expand' : 'Collapse'} draft`
}
app.querySelector<HTMLButtonElement>('[data-collapse-draft]')!.addEventListener('click', () => {
  setDraftCollapsed(!app.querySelector<HTMLElement>('[data-draft-content]')!.hidden)
})

function showDraft(draft: DraftProjection, accountMutable: boolean): void {
  const sameDraft = Boolean(activeDraft && activeDraft.id === draft.id && activeDraft.accountId === draft.accountId && activeDraft.inReplyToMessageId === draft.inReplyToMessageId)
  if (!sameDraft) setDraftCollapsed(false)
  if (!draft.id || activeDraft?.id !== draft.id || activeDraft?.accountId !== draft.accountId) recoveryKey = undefined
  if (draftPreviewTimer !== undefined) window.clearTimeout(draftPreviewTimer)
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  draftPreviewTimer = undefined
  draftAutosaveTimer = undefined
  draftPreviewSequence += 1
  draftEditSession += 1
  draftDirty = false
  activeDraft = draft
  elements.reader.hidden = false
  elements.readerEmpty.hidden = true
  elements.reader.classList.add('dispatch-drafting')
  elements.reader.classList.toggle('dispatch-composing', !selected)
  if (!selected) { elements.threadFilesToggle.hidden = true; elements.copyStatus.hidden = true }
  if (!selected) [elements.archive, elements.spam, elements.trash, elements.moveInbox].forEach((control) => { control.hidden = true })
  elements.body.hidden = !selected
  elements.attachments.hidden = true
  elements.draft.hidden = false
  elements.draftAccount.replaceChildren(...accounts.map((account) => {
    const option = document.createElement('option')
    option.value = account.id
    option.textContent = account.email || account.name
    option.selected = account.id === draft.accountId
    return option
  }))
  if (draft.accountId && !accounts.some(account => account.id === draft.accountId)) {
    const option = document.createElement('option'); option.value = draft.accountId; option.textContent = 'Recovered account (offline)'; option.selected = true; elements.draftAccount.append(option)
  }
  elements.draftAccount.disabled = !accountMutable
  setRecipientField(elements.draftTo, draft.to.map((address) => address.address).join(', '))
  setRecipientField(elements.draftCc, draft.cc ?? '')
  setRecipientField(elements.draftBcc, draft.bcc ?? '')
  elements.draftSubject.value = draft.subject
  elements.draftBody.value = draft.bodyMarkdown || draft.bodyText
  elements.draftPreview.innerHTML = draft.bodyHtml
  elements.draftError.hidden = true
  elements.draftError.textContent = ''
  elements.sendConfirm.hidden = true
  renderDraftAttachments()
  draftSeed = { fields: editorFields(), attachments: draft.attachments }
  draftDiscarding = false
  elements.recoveryStatus.textContent = draft.cachedAt ? 'Checking Gmail…' : ''
  elements.recoveryStatus.title = draft.cachedAt ? `Last confirmed ${new Date(draft.cachedAt).toLocaleString()}` : ''
  freezeDraft(Boolean(draftSendFlight))
  void recovery.cacheFiles(draft.attachments).then(() => { if (activeDraft?.id === draft.id && draftDirty) checkpointDraft() }).catch(draftError)
}

function hideDraftEditor(): void {
  clearDraftAttachmentObjectUrls()
  if (draftPreviewTimer !== undefined) window.clearTimeout(draftPreviewTimer)
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  draftPreviewTimer = undefined
  draftAutosaveTimer = undefined
  draftPreviewSequence += 1
  draftEditSession += 1
  draftDirty = false
  draftDiscarding = false
  activeDraft = undefined
  recoveryKey = undefined
  elements.draft.hidden = true
  elements.sendConfirm.hidden = true
  elements.draftError.hidden = true
  elements.reader.classList.remove('dispatch-drafting', 'dispatch-composing')
  if (selected) {
    elements.reader.hidden = false
    elements.readerEmpty.hidden = true
    elements.body.hidden = false
    elements.attachments.hidden = false
  } else {
    elements.reader.hidden = true
    elements.readerEmpty.hidden = false
  }
}

function refreshPreview(): void {
  if (draftPreviewTimer !== undefined) window.clearTimeout(draftPreviewTimer)
  const sequence = ++draftPreviewSequence
  draftPreviewTimer = window.setTimeout(() => {
    draftPreviewTimer = undefined
    void api.previewDraft(elements.draftBody.value).then((bodyHtml) => {
      if (sequence === draftPreviewSequence && activeDraft) elements.draftPreview.innerHTML = bodyHtml
    }).catch(draftError)
  }, 300)
}

function autosaveDraft(): void {
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  draftAutosaveTimer = window.setTimeout(() => {
    draftAutosaveTimer = undefined
    if (draftDirty && activeDraft && !offlineMode && !draftSendFlight) {
      const addresses = [elements.draftTo, elements.draftCc, elements.draftBcc].flatMap(field => parseRecipientList(recipientValue(field)))
      if (addresses.some(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return
      if (!activeDraft.id && draftSeed?.fields === editorFields() && draftSeed.attachments === activeDraft.attachments) return
      void saveDraft(false).catch(error => {
        if (retryableDraftError(error)) { elements.recoveryStatus.textContent = 'Saved · waiting to sync'; scheduleDraftSync() }
        else draftError(error)
      })
    }
  }, 1_500)
}

async function flushDraftAutosave(): Promise<void> {
  if (offlineMode) { if (draftDirty) checkpointDraft(); return }
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  draftAutosaveTimer = undefined
  const draftId = activeDraft?.id
  const session = draftEditSession
  if (!draftId || !draftDirty) return
  if (draftSaveFlight) await draftSaveFlight
  if (draftEditSession !== session || activeDraft?.id !== draftId || !draftDirty) return
  await saveDraft(false)
}

async function openDraft(replyAll = false): Promise<void> {
  if (!selected) return
  const accountId = selected.accountId
  const latestMessageId = selected.latestMessageId
  const latest = selected.messages.find((message) => message.id === latestMessageId) ?? selected.messages[0]
  if (!latest) return
  const own = accounts.find((account) => account.id === accountId)?.email.toLowerCase()
  const participants = [latest.sender, ...(latest.to ?? [])].filter((address, index, values) => address.address.toLowerCase() !== own && values.findIndex((item) => item.address.toLowerCase() === address.address.toLowerCase()) === index)
  const primary = participants[0] ?? latest.sender
  const to = replyAll ? draftAddressList(participants) : primary.address
  const cc = replyAll ? draftAddressList((latest.cc ?? []).filter((address) => address.address.toLowerCase() !== own && !participants.some((item) => item.address.toLowerCase() === address.address.toLowerCase()))) : ''
  const bodyMarkdown = replyQuoteMarkdown(latest)
  const subject = /^re:/i.test(selected.subject) ? selected.subject : `Re: ${selected.subject}`
  const fields = { to, cc, bcc: '', subject, bodyMarkdown, bodyText: bodyMarkdown }
  if (offlineMode || (selected.source === 'gmail' && accountId)) {
    if (draftSaveFlight && activeDraft?.inReplyToMessageId === latest.id && activeDraft.accountId === accountId) { elements.draftBody.focus(); return }
    showDraft({ id: '', accountId, inReplyToMessageId: latest.id, to: parseRecipientList(to).map(address => ({ name: address, address, initials: '@' })), cc, bcc: '', subject, bodyMarkdown, bodyText: bodyMarkdown, bodyHtml: '', attachments: [], state: 'draft' }, true)
    markDraftDirty(); refreshPreview(); elements.draftBody.focus()
    if (!offlineMode) void saveDraft(false).catch(draftError)
    return
  }
  const draft: DraftProjection = selected.source === 'gmail' && accountId
    ? await api.createDraft(latest.id, { accountId, ...fields })
    : await api.createDraft(selected.latestMessageId, fields)
  showDraft(draft, false)
}

async function openForward(): Promise<void> {
  if (!selected?.accountId) return
  const latestMessageId = selected.latestMessageId
  const latest = selected.messages.find((message) => message.id === latestMessageId) ?? selected.messages[0]
  if (!latest) return
  const subject = selected.subject.startsWith('Fwd:') ? selected.subject : `Fwd: ${selected.subject}`
  if (draftSaveFlight && activeDraft?.subject === subject && activeDraft.accountId === selected.accountId) { elements.draftBody.focus(); return }
  const content = emailPlainText(latest.body.kind, latest.body.content)
  const bodyMarkdown = `\n\n---------- Forwarded message ----------\nFrom: ${latest.sender.name} <${latest.sender.address}>\nDate: ${latest.receivedFullLabel}\nSubject: ${latest.subject}\n\n${content}`
  if (offlineMode || selected.source === 'gmail') {
    showDraft({ id: '', accountId: selected.accountId, inReplyToMessageId: '', to: [], cc: '', bcc: '', subject, bodyMarkdown, bodyText: bodyMarkdown, bodyHtml: '', attachments: latest.attachments.map(file => ({ ...file, sourceMessageId: latest.id })), state: 'draft' }, true)
    markDraftDirty(); refreshPreview()
    if (!offlineMode) void saveDraft(false).catch(draftError)
    return
  }
  const draft = await api.createDraft('', {
    accountId: selected.accountId,
    to: '',
    cc: '',
    bcc: '',
    subject,
    bodyMarkdown,
    bodyText: bodyMarkdown,
    attachments: latest.attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      sizeLabel: attachment.sizeLabel,
      sourceMessageId: latest.id,
    })),
  })
  showDraft(draft, false)
}

function openCompose(existingKey?: string): void {
  const accountId = selectedAccountId ?? selected?.accountId ?? accounts[0]?.id
  if (!accountId) {
    addAgentMessage('error', 'Connect a Gmail account before composing mail.')
    return
  }
  markReadDwell.cancel()
  const sequence = ++selectionSequence
  const codexKey: CodexPaneKey = { kind: 'draft', draftKey: existingKey ?? crypto.randomUUID() }
  selectCodexContext(codexKey)
  selectedAttachmentContext = undefined
  codexContextReady = false
  selected = undefined
  selectedSummary = undefined
  selectedConversationId = undefined
  void bindAndShowCodex(codexKey, { sequence })
  if (usesMobilePanels()) {
    mobilePanel = 'reader'
    mobileReturnPanel = 'reader'
    renderPanels()
  }
  elements.subject.textContent = 'New message'
  elements.messageCount.textContent = 'Draft'
  elements.threadMailbox.textContent = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())
  elements.address.hidden = true
  elements.accountDot.hidden = true
  elements.accountSep.hidden = true
  const draft: DraftProjection = { id: '', inReplyToMessageId: '', to: [], cc: '', bcc: '', subject: '', bodyMarkdown: '', bodyHtml: '', bodyText: '', attachments: [], state: 'draft', accountId }
  showDraft(draft, true)
  recoveryKey = codexKey.draftKey
}

async function saveDraft(notify = true): Promise<void> {
  if (offlineMode) { checkpointDraft(); throw new Error('This draft is saved locally. Go online to save it to Gmail.') }
  if (draftDiscarding) return
  const session = draftEditSession
  if (recoveryKey && backgroundDraftSaves.has(recoveryKey)) {
    const synced = await backgroundDraftSaves.get(recoveryKey)!.catch(() => undefined)
    if (synced && session === draftEditSession && activeDraft && !activeDraft.id) activeDraft = { ...activeDraft, id: synced.id, gmailThreadId: synced.gmailThreadId, gmailMessageId: synced.gmailMessageId }
  }
  while (draftSaveFlight) await draftSaveFlight
  if (draftDiscarding || !activeDraft || session !== draftEditSession) return
  const draft = activeDraft
  const savingRecoveryKey = recoveryKey
  const savingRevision = draftEditRevision
  const accountId = draft.id ? draft.accountId : elements.draftAccount.value
  if (!accountId) throw new Error('Choose a Gmail account for this draft.')
  const bodyMarkdown = elements.draftBody.value
  const fields = { accountId, clientDraftId: savingRecoveryKey, messageId: draft.inReplyToMessageId, to: recipientValue(elements.draftTo), cc: recipientValue(elements.draftCc), bcc: recipientValue(elements.draftBcc), subject: elements.draftSubject.value, bodyMarkdown, bodyText: bodyMarkdown, attachments: draft.attachments }
  elements.draftAccount.disabled = true
  elements.recoveryStatus.textContent = 'Saving…'
  let savedSuccessfully = false
  let retrySave = false
  const operation = (async () => {
    const savedDraft = draft.id
      ? await api.updateDraft(draft.id, fields)
      : await api.createDraft('', fields)
    savedSuccessfully = true
    if (savingRecoveryKey) void linkDraftTask(savingRecoveryKey, savedDraft).catch(error => console.error('Draft task binding will need reconnection:', error))
    if (savingRecoveryKey) draftSyncErrors.delete(savingRecoveryKey)
    draftSyncDelay = 3000
    if (savingRecoveryKey && savedDraft.id) {
      try {
        recovery.bindGmailIdentity(savingRecoveryKey, accountId, savedDraft.id, savedDraft.gmailThreadId)
        recovery.removeSavedRevision(savingRecoveryKey, savingRevision)
        renderRecoveryList()
      }
      catch (error) { draftError(new Error(`Gmail saved the draft, but local recovery could not record its identity: ${String(error)}`)) }
    }
    if (session !== draftEditSession || !activeDraft || activeDraft.id !== draft.id || draftDiscarding) return savedDraft
    activeDraft = draftEditRevision === savingRevision ? savedDraft : { ...savedDraft, attachments: activeDraft.attachments }
    elements.sendDraft.disabled = false
    elements.draftAccount.disabled = true
    elements.draftPreview.innerHTML = savedDraft.bodyHtml
    elements.draftError.hidden = true
    elements.draftError.textContent = ''
    if (draftEditRevision === savingRevision && recipientValue(elements.draftTo) === fields.to
      && recipientValue(elements.draftCc) === fields.cc
      && recipientValue(elements.draftBcc) === fields.bcc
      && elements.draftSubject.value === fields.subject
      && elements.draftBody.value === bodyMarkdown) {
      draftDirty = false
      clearRecovery(savingRecoveryKey)
      elements.recoveryStatus.textContent = 'Saved to Gmail'
    } else { checkpointDraft() }
    if (notify) addAgentMessage('tool', 'Gmail draft saved.')
    return savedDraft
  })()
  draftSaveFlight = operation
  try {
    await operation
  } catch (error) {
    retrySave = retryableDraftError(error)
    if (retrySave) { draftSyncDelay = Math.min(60_000, draftSyncDelay * 2); scheduleDraftSync() }
    throw error
  } finally {
    if (draftSaveFlight === operation) draftSaveFlight = undefined
    if (session === draftEditSession && activeDraft) {
      elements.draftAccount.disabled = Boolean(activeDraft.id)
      if (!savedSuccessfully) elements.recoveryStatus.textContent = 'Saved · waiting to sync'
      if (savedSuccessfully && draftDirty && activeDraft.id && !draftSendFlight) autosaveDraft()
    }
  }
}

async function reviseDraft(): Promise<void> {
  if (!activeDraft) return
  if (activeDraft.id) {
    await flushDraftAutosave()
  } else {
    if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
    draftAutosaveTimer = undefined
    await saveDraft(false)
  }
  const draft = activeDraft
  if (!draft?.id) throw new Error('Gmail did not return a draft ID. Codex did not receive the revision prompt.')
  if (!draft.accountId) throw new Error('The Gmail account is missing from this draft.')
  elements.prompt.value = [
    `Revise Gmail draft ${draft.id} on account ${draft.accountId}.`,
    `Call Gmail update_draft on that draft ID using the installed tool schema and a multipart/alternative payload for plain text and HTML. Preserve existing attachments. This is a revision request, not permission to send.`,
    `Current draft:\n\n${elements.draftBody.value}`,
  ].join(' ')
  elements.prompt.focus()
  await sendPrompt()
}

function sendDraft(): void {
  if (offlineMode) { checkpointDraft(); draftError(new Error('Go online to send. Your local draft is kept.')); return }
  if (!activeDraft || draftSendFlight) return
  if (![elements.draftTo, elements.draftCc, elements.draftBcc].some(field => recipientValue(field).trim())) { draftError(new Error('Add a recipient before sending.')); return }
  sendConfirmationRevision = draftEditRevision
  elements.sendConfirmText.textContent = [
    `To: ${recipientValue(elements.draftTo) || '(no recipient)'}`,
    recipientValue(elements.draftCc) ? `Cc: ${recipientValue(elements.draftCc)}` : '',
    recipientValue(elements.draftBcc) ? `Bcc: ${recipientValue(elements.draftBcc)}` : '',
    `Subject: ${elements.draftSubject.value || '(no subject)'}`,
  ].filter(Boolean).join('\n')
  elements.sendConfirm.hidden = false
}

async function confirmSendDraft(): Promise<void> {
  if (!activeDraft || draftSendFlight || draftDiscarding) return
  const session = draftEditSession
  const revision = draftEditRevision
  const sendingRecoveryKey = recoveryKey
  const originalId = activeDraft.id
  const originalAccount = activeDraft.id ? activeDraft.accountId : elements.draftAccount.value
  if (sendConfirmationRevision !== revision || ![elements.draftTo, elements.draftCc, elements.draftBcc].some(field => recipientValue(field).trim())) {
    elements.sendConfirm.hidden = true
    throw new Error('The draft changed. Review its recipients before sending again.')
  }
  const operation = (async () => {
    if (draftSaveFlight) await draftSaveFlight
    if (session !== draftEditSession || revision !== draftEditRevision) throw new Error('The draft changed before sending. Review it again.')
    // An unchanged Gmail draft already has its exact recipients, MIME body, and files.
    // Do not rewrite it from the editor's projection as a side effect of Send.
    if (!activeDraft?.id || draftDirty) await saveDraft()
    if (session !== draftEditSession || revision !== draftEditRevision
      || (originalId && activeDraft?.id !== originalId) || activeDraft?.accountId !== originalAccount) {
      throw new Error('The draft changed before sending. Review it again.')
    }
    const draft = activeDraft
    if (!draft?.id || !draft.accountId) throw new Error('Save the Gmail draft before sending it.')
    const receipt = await api.sendDraft(draft.id, draft.accountId)
    if (!receipt) throw new Error('The send was not confirmed. Check Sent before retrying.')
    if (receipt.status !== 'accepted' && receipt.status !== 'verified') throw new Error(receipt.error || 'The send outcome is uncertain. Check Sent before retrying.')
    clearRecovery(sendingRecoveryKey)
    if (session === draftEditSession && activeDraft?.id === draft.id && activeDraft.accountId === draft.accountId) hideDraftEditor()
    void loadConversations()
  })()
  draftSendFlight = operation
  elements.sendConfirmGo.disabled = true
  elements.sendDraft.disabled = true
  elements.discardDraft.disabled = true
  freezeDraft(true)
  try {
    await operation
  } finally {
    freezeDraft(false)
    if (draftSendFlight === operation) draftSendFlight = undefined
    elements.sendConfirmGo.disabled = false
    elements.sendDraft.disabled = false
    elements.discardDraft.disabled = false
  }
}

async function discardDraft(): Promise<void> {
  if (draftSendFlight || draftDiscarding) return
  const draft = activeDraft
  if (!draft) return
  draftDiscarding = true
  if (draftAutosaveTimer !== undefined) window.clearTimeout(draftAutosaveTimer)
  draftAutosaveTimer = undefined
  draftEditSession += 1
  let savedDraft: DraftProjection | undefined = draft
  try {
    if (recoveryKey && backgroundDraftSaves.has(recoveryKey)) savedDraft = (await backgroundDraftSaves.get(recoveryKey)) ?? draft
    if (draftSaveFlight) savedDraft = (await draftSaveFlight) ?? draft
    const discardId = savedDraft.id
    if (discardId) {
      if (!savedDraft.accountId) throw new Error('The Gmail account is missing from this draft.')
      await api.discardDraft(discardId, savedDraft.accountId)
    }
    clearRecovery()
    hideDraftEditor()
    void loadConversations()
  } catch (error) {
    draftDiscarding = false
    throw error
  }
}

async function fileContentBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function attachDraftFiles(): Promise<void> {
  if (!activeDraft) return
  const attachmentSession = draftEditSession
  const files = [...(elements.draftFiles.files ?? [])]
  if (files.length === 0) return
  try {
    const attachments = await Promise.all(files.map(async (file) => ({
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      contentBase64: await fileContentBase64(file),
    })))
    await recovery.cacheFiles(attachments)
    if (!activeDraft || attachmentSession !== draftEditSession) return
    activeDraft = { ...activeDraft, attachments: [...activeDraft.attachments, ...attachments] }
    renderDraftAttachments()
    markDraftDirty()
    if (!offlineMode) await saveDraft()
  } catch (error) {
    draftError(error)
  } finally {
    elements.draftFiles.value = ''
  }
}

function listedConversations(): ConversationSummary[] {
  return (searchView ? searchView.results.map((result) => result.conversation) : conversations).filter((conversation) => !pendingMailboxRemovals.has(`${mailbox}:${conversation.id}`))
}

function listedIds(): string[] {
  return listedConversations().map((conversation) => conversation.id)
}

async function handleRowClick(id: string, event: MouseEvent): Promise<void> {
  const toggle = event.metaKey || event.ctrlKey
  if (!event.shiftKey && !toggle) {
    await selectConversation(id, { revealOnMobile: true, startReadDwell: true })
    return
  }
  event.preventDefault()
  await applySelection(selectionAfterClick(selection, listedIds(), id, { shift: event.shiftKey, toggle }))
}

async function applySelection(next: SelectionState): Promise<void> {
  if (next.ids.length === 1) {
    await selectConversation(next.ids[0]!, { revealOnMobile: true })
    return
  }
  if (next.ids.length === 0) {
    selection = next
    renderList()
    return
  }
  markReadDwell.cancel()
  if (activeDraft && draftDirty) {
    if (!checkpointDraft()) return
    scheduleDraftSync(0)
  }
  selectionSequence += 1
  selection = next
  selected = undefined
  selectedSummary = undefined
  selectedConversationId = undefined
  activeDraft = undefined
  recoveryKey = undefined
  draftEditSession += 1
  draftDirty = false
  renderMultiSelection()
}

function renderMultiSelection(): void {
  const count = selection.ids.length
  elements.readerEmpty.hidden = true
  elements.reader.hidden = false
  elements.reader.classList.remove('dispatch-drafting', 'dispatch-composing')
  elements.reader.classList.add('dispatch-multi')
  elements.subject.textContent = `${count} conversations selected`
  elements.body.hidden = true
  elements.attachments.hidden = true
  elements.draft.hidden = true
  elements.threadFilesToggle.hidden = true
  elements.copyStatus.hidden = true
  app.querySelector<HTMLElement>('[data-message-count]')!.textContent = `${count} conversations`
  app.querySelector<HTMLElement>('[data-message-count]')!.hidden = false
  elements.countSep.hidden = false
  app.querySelector<HTMLElement>('[data-thread-mailbox]')!.textContent = mailboxLabels[mailbox]
  app.querySelector<HTMLElement>('[data-account-sep]')!.hidden = true
  app.querySelector<HTMLElement>('[data-account-dot]')!.hidden = true
  app.querySelector<HTMLElement>('[data-address]')!.hidden = true
  renderMailbox()
  renderList()
}

function startConversationDrag(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return
  if (!selection.ids.includes(id) || selection.ids.length <= 1) selection = { ids: [id], anchor: id }
  const ids = selection.ids.length > 1 ? [...selection.ids] : [id]
  event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, encodeDragPayload(ids))
  event.dataTransfer.setData('text/plain', `${ids.length} conversation${ids.length === 1 ? '' : 's'}`)
  event.dataTransfer.effectAllowed = 'move'
  const badge = document.createElement('div')
  badge.className = 'dispatch-drag-badge'
  badge.textContent = ids.length === 1 ? (listedConversations().find((conversation) => conversation.id === id)?.subject || '1 conversation') : `${ids.length} conversations`
  document.body.append(badge)
  event.dataTransfer.setDragImage(badge, 12, 16)
  window.setTimeout(() => badge.remove(), 0)
  // Do not re-render here: replacing the source row mid-drag cancels the drag.
}

function installDropTargets(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-mailbox]').forEach((target) => {
    const targetMailbox = target.dataset.mailbox as GmailMailbox
    const accepts = (event: DragEvent): GmailConversationAction | undefined => {
      if (!event.dataTransfer || ![...event.dataTransfer.types].includes(CONVERSATION_DRAG_TYPE)) return undefined
      return dropActionForMailbox(targetMailbox, mailbox)
    }
    target.addEventListener('dragover', (event) => {
      const action = accepts(event)
      if (!action) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'move'
      target.classList.add('dispatch-drop-target')
    })
    target.addEventListener('dragleave', () => target.classList.remove('dispatch-drop-target'))
    target.addEventListener('drop', (event) => {
      target.classList.remove('dispatch-drop-target')
      const action = accepts(event)
      if (!action) return
      event.preventDefault()
      const ids = decodeDragPayload(event.dataTransfer!.getData(CONVERSATION_DRAG_TYPE))
      setFolderMenu(false)
      if (ids.length) void mutateConversations(ids, action)
    })
  })
  elements.folderToggle.addEventListener('dragenter', (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes(CONVERSATION_DRAG_TYPE)) setFolderMenu(true)
  })
  document.addEventListener('dragend', () => {
    app.querySelectorAll('.dispatch-drop-target').forEach((node) => node.classList.remove('dispatch-drop-target'))
    setFolderMenu(false)
  })
}

async function mutateSelected(action: GmailConversationAction): Promise<void> {
  const ids = selection.ids.length > 1 ? selection.ids : selectedConversationId ? [selectedConversationId] : []
  await mutateConversations(ids, action)
}

interface LastMove {
  readonly action: GmailConversationAction
  readonly mailbox: GmailMailbox
  readonly rows: ReadonlyArray<{ readonly summary: ConversationSummary; readonly index: number }>
}

let lastMove: LastMove | undefined
let undoTimer: number | undefined
let undoDeadline = 0
let undoRemaining = 0
const UNDO_WINDOW_MS = 6_000

const undoToast = {
  root: app.querySelector<HTMLElement>('[data-undo-toast]')!,
  text: app.querySelector<HTMLElement>('[data-undo-text]')!,
  bar: app.querySelector<HTMLElement>('[data-undo-bar]')!,
}

function showUndoToast(move: LastMove): void {
  lastMove = move
  undoToast.text.textContent = moveLabel(move.action, move.rows.length)
  undoToast.root.hidden = false
  startUndoCountdown(UNDO_WINDOW_MS)
}

function startUndoCountdown(ms: number): void {
  if (undoTimer !== undefined) window.clearInterval(undoTimer)
  undoDeadline = Date.now() + ms
  undoRemaining = ms
  undoToast.bar.style.width = `${Math.round((ms / UNDO_WINDOW_MS) * 100)}%`
  undoTimer = window.setInterval(() => {
    undoRemaining = Math.max(0, undoDeadline - Date.now())
    undoToast.bar.style.width = `${Math.round((undoRemaining / UNDO_WINDOW_MS) * 100)}%`
    if (undoRemaining === 0) hideUndoToast()
  }, 100)
}

function pauseUndoCountdown(): void {
  if (undoTimer === undefined) return
  window.clearInterval(undoTimer)
  undoTimer = undefined
  undoRemaining = Math.max(0, undoDeadline - Date.now())
}

function hideUndoToast(): void {
  if (undoTimer !== undefined) window.clearInterval(undoTimer)
  undoTimer = undefined
  undoToast.root.hidden = true
  lastMove = undefined
}

async function undoLastMove(): Promise<void> {
  const move = lastMove
  if (!move) return
  hideUndoToast()
  const steps = undoActionsFor(move.action, move.mailbox)
  if (steps.length === 0) return
  const ids = new Set(move.rows.map((row) => row.summary.id))
  if (mailbox === move.mailbox && !searchView) {
    conversations = conversations.filter((conversation) => !ids.has(conversation.id))
    for (const row of [...move.rows].sort((left, right) => left.index - right.index)) {
      conversations.splice(Math.min(row.index, conversations.length), 0, row.summary)
    }
    renderList()
  }
  const results = await Promise.allSettled(move.rows.map(async (row) => {
    for (const step of steps) await api.mutateConversation(row.summary.threadId, row.summary.accountId!, [], step)
  }))
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed) {
    elements.mailError.hidden = false
    elements.mailError.textContent = failed === move.rows.length ? 'The move could not be undone. Try again.' : `${failed} of ${move.rows.length} conversations could not be restored. Try again.`
  }
  await loadConversations(true)
  if (mailbox === move.mailbox && !selectedConversationId && selection.ids.length === 0) {
    const first = move.rows[0]?.summary.id
    if (first && conversations.some((conversation) => conversation.id === first)) void selectConversation(first)
  }
}

async function mutateConversations(ids: readonly string[], action: GmailConversationAction): Promise<void> {
  const listedBefore = listedConversations()
  const targets = listedBefore.filter((conversation) => ids.includes(conversation.id))
  const writable = targets.filter((conversation) => conversation.accountId && conversation.threadId)
  if (writable.length === 0) {
    elements.mailError.hidden = false
    elements.mailError.textContent = targets.length ? 'These messages are still loading. Refresh them before moving them.' : 'This message is still loading. Refresh it before moving it.'
    return
  }
  const loadedId = selected?.id
  const loadedMessageIds = selected?.messages.map((message) => message.id) ?? []
  const originalMailbox = mailbox
  const originalIndexes = new Map(writable.map((conversation) => [conversation.id, listedBefore.findIndex((item) => item.id === conversation.id)]))
  const remainsInMailbox = (value: GmailConversationAction): boolean => {
    if (value === 'archive') return mailbox === 'sent'
    if (value === 'spam') return mailbox === 'spam'
    if (value === 'trash') return mailbox === 'trash'
    return mailbox === 'inbox'
  }
  const removing = !remainsInMailbox(action)
  if (removing) {
    conversationLoadSequence += 1
    for (const conversation of writable) pendingMailboxRemovals.add(`${originalMailbox}:${conversation.id}`)
    const removedIds = new Set(writable.map((conversation) => conversation.id))
    const lastIndex = Math.max(...originalIndexes.values())
    const firstIndex = Math.min(...originalIndexes.values())
    const remaining = listedBefore.filter((conversation) => !removedIds.has(conversation.id))
    const indexOf = (conversation: ConversationSummary): number => listedBefore.indexOf(conversation)
    const nextSummary = remaining.find((conversation) => indexOf(conversation) > lastIndex)
      ?? remaining.find((conversation) => indexOf(conversation) > firstIndex)
      ?? [...remaining].reverse().find((conversation) => indexOf(conversation) < firstIndex)
    if (searchView) searchView = { ...searchView, results: searchView.results.filter((item) => !removedIds.has(item.conversation.id)) }
    conversations = conversations.filter((conversation) => !removedIds.has(conversation.id))
    selection = EMPTY_SELECTION
    selected = undefined
    selectedSummary = undefined
    selectedConversationId = undefined
    elements.reader.hidden = true
    elements.reader.classList.remove('dispatch-multi')
    elements.readerEmpty.hidden = false
    elements.readerEmpty.textContent = defaultEmptyListMessage()
    renderList()
    if (nextSummary) void selectConversation(nextSummary.id)
  }
  const results = await Promise.allSettled(writable.map((conversation) => api.mutateConversation(conversation.threadId, conversation.accountId!, conversation.id === loadedId ? loadedMessageIds : [], action)))
  const failed = writable.filter((_, index) => results[index]!.status === 'rejected')
  try {
    if (failed.length && mailbox === originalMailbox) {
      for (const conversation of [...failed].sort((left, right) => originalIndexes.get(left.id)! - originalIndexes.get(right.id)!)) {
        if (conversations.some((item) => item.id === conversation.id)) continue
        conversations.splice(Math.min(Math.max(originalIndexes.get(conversation.id)!, 0), conversations.length), 0, conversation)
      }
      renderList()
    }
    if (failed.length) {
      elements.mailError.hidden = false
      elements.mailError.textContent = writable.length === 1 ? 'The change could not be saved. Try again.' : `${failed.length} of ${writable.length} conversations could not be moved. Try again.`
    }
    const moved = writable.filter((conversation) => !failed.includes(conversation))
    if (moved.length && removing) showUndoToast({ action, mailbox: originalMailbox, rows: moved.map((summary) => ({ summary, index: originalIndexes.get(summary.id)! })) })
    if (failed.length < writable.length) await loadConversations(true)
  } finally {
    for (const conversation of writable) pendingMailboxRemovals.delete(`${originalMailbox}:${conversation.id}`)
    renderList()
  }
}

function addAgentMessage(kind: 'user' | 'agent' | 'tool' | 'error', text: string): HTMLElement {
  const item = document.createElement('div')
  item.className = `dispatch-agent-message dispatch-agent-${kind}`
  item.dataset.rawMessage = text
  if (kind === 'error') {
    const described = describeRequestError(text)
    if (described !== text) console.error('Dispatch request failed:', text)
    text = described
  }
  const timestamp = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())
  if (kind === 'user') {
    item.classList.add('d-flex', 'justify-content-end')
    const bubble = document.createElement('div')
    bubble.className = 'card dispatch-chat-bubble'
    const body = document.createElement('div')
    body.className = 'card-body p-3'
    const content = document.createElement('div')
    content.className = 'dispatch-chat-plain'
    content.textContent = text
    const time = document.createElement('time')
    time.className = 'd-block text-secondary small mt-2'
    time.textContent = timestamp
    body.append(content, time)
    bubble.append(body)
    item.append(bubble)
  } else if (kind === 'agent') {
    item.classList.add('d-flex', 'align-items-start')
    const avatar = document.createElement('span')
    avatar.className = 'avatar avatar-sm bg-blue-lt text-blue me-3 flex-shrink-0'
    avatar.innerHTML = '<i class="ti ti-sparkles" aria-hidden="true"></i>'
    const response = document.createElement('div')
    response.className = 'flex-grow-1 dispatch-chat-response'
    const content = document.createElement('div')
    content.dataset.agentContent = ''
    content.append(renderChatMarkdown(text))
    const footer = document.createElement('div')
    footer.className = 'border-top d-flex align-items-center justify-content-between mt-2 pt-2'
    const time = document.createElement('time')
    time.className = 'text-secondary small'
    time.textContent = timestamp
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'btn btn-icon btn-sm btn-ghost-secondary'
    copy.setAttribute('aria-label', 'Copy Codex response')
    copy.innerHTML = '<i class="ti ti-copy" aria-hidden="true"></i>'
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(item.dataset.rawMessage ?? '') })
    footer.append(time, copy)
    response.append(content, footer)
    item.append(avatar, response)
  } else {
    item.classList.add('alert', kind === 'error' ? 'alert-danger' : 'alert-secondary', 'py-2', 'px-3')
    const icon = document.createElement('i')
    icon.className = `ti ${kind === 'error' ? 'ti-alert-circle' : 'ti-point-filled'} me-2`
    icon.setAttribute('aria-hidden', 'true')
    item.append(icon, document.createTextNode(text))
  }
  elements.stream.append(item)
  elements.stream.scrollTop = elements.stream.scrollHeight
  return item
}

function updateAgentMessage(item: HTMLElement, text: string): void {
  item.dataset.rawMessage = text
  const content = item.querySelector<HTMLElement>('[data-agent-content]')
  if (content) content.replaceChildren(renderChatMarkdown(text))
}

type AgentEvent = { id?: number | string; method?: string; params?: unknown }
const requestIds = new Map<string, number | string>()

function originalRequestId(card: HTMLElement): number | string | undefined {
  const key = card.dataset.requestId
  return key === undefined ? undefined : requestIds.get(key)
}

function requestText(params: Record<string, unknown> | undefined, fallback: string): string {
  return String(params?.reason ?? params?.message ?? fallback)
}

function addRequestButton(card: HTMLElement, label: string, result: unknown, primary = false): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = primary ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline-secondary'
  button.textContent = label
  button.addEventListener('click', () => {
    const id = originalRequestId(card)
    if (id === undefined) return
    card.querySelectorAll('button, input, select, textarea').forEach((control) => {
      ;(control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true
    })
    void api.respondToServerRequest(id, result).then(() => {
      card.classList.add('dispatch-request-resolved')
      setAgentStatus('Working')
      const state = card.querySelector<HTMLElement>('[data-request-state]')
      if (state) state.textContent = label
    }).catch((error) => {
      card.querySelectorAll('button, input, select, textarea').forEach((control) => {
        ;(control as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = false
      })
      addAgentMessage('error', error instanceof Error ? error.message : String(error))
    })
  })
  card.querySelector('[data-request-actions]')?.append(button)
}

function renderUserInputRequest(card: HTMLElement, params: Record<string, unknown>): void {
  const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : []
  const fields = document.createElement('div')
  fields.className = 'd-grid gap-2 my-3 dispatch-request-fields'
  for (const question of questions) {
    const label = document.createElement('label')
    label.className = 'form-label'
    label.textContent = String(question.question ?? question.header ?? 'Response')
    const options = Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : []
    if (options.length > 0) {
      const select = document.createElement('select')
      select.className = 'form-select form-select-sm mt-1'
      select.dataset.questionId = String(question.id ?? '')
      for (const option of options) {
        const item = document.createElement('option')
        item.value = String(option.label ?? '')
        item.textContent = String(option.label ?? '')
        select.append(item)
      }
      label.append(select)
    } else {
      const input = document.createElement('input')
      input.className = 'form-control form-control-sm mt-1'
      input.dataset.questionId = String(question.id ?? '')
      input.placeholder = 'Type your response'
      label.append(input)
    }
    fields.append(label)
  }
  card.querySelector('[data-request-actions]')?.before(fields)
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'btn btn-sm btn-primary'
  submit.textContent = 'Submit'
  submit.addEventListener('click', () => {
    const answers: Record<string, { answers: string[] }> = {}
    fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-question-id]').forEach((field) => {
      answers[field.dataset.questionId ?? ''] = { answers: [field.value] }
    })
    const id = originalRequestId(card)
    if (id === undefined) return
    void api.respondToServerRequest(id, { answers }).then(() => {
      card.classList.add('dispatch-request-resolved')
      setAgentStatus('Working')
      card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach((control) => { control.disabled = true })
      const state = card.querySelector<HTMLElement>('[data-request-state]')
      if (state) state.textContent = 'Submitted'
    }).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error)))
  })
  card.querySelector('[data-request-actions]')?.append(submit)
}

/** A connector permission prompt carries an empty schema: one click, no JSON. */
function isPermissionElicitation(params: Record<string, unknown> | undefined): boolean {
  const schema = params?.requestedSchema as { properties?: Record<string, unknown> } | undefined
  const properties = schema?.properties
  return !properties || Object.keys(properties).length === 0
}

function renderElicitationRequest(card: HTMLElement, params?: Record<string, unknown>): void {
  if (isPermissionElicitation(params)) {
    addRequestButton(card, 'Allow', { action: 'accept', content: {} }, true)
    addRequestButton(card, 'Decline', { action: 'decline', content: null })
    return
  }
  const input = document.createElement('textarea')
  input.className = 'form-control my-3 dispatch-request-json'
  input.value = '{}'
  input.setAttribute('aria-label', 'Requested information')
  card.querySelector('[data-request-actions]')?.before(input)
  const accept = document.createElement('button')
  accept.type = 'button'
  accept.className = 'btn btn-sm btn-primary'
  accept.textContent = 'Submit'
  accept.addEventListener('click', () => {
    try {
      const content = JSON.parse(input.value) as unknown
      const id = originalRequestId(card)
      if (id === undefined) return
      void api.respondToServerRequest(id, { action: 'accept', content }).then(() => {
        card.classList.add('dispatch-request-resolved')
        setAgentStatus('Working')
        card.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach((control) => { control.disabled = true })
        const state = card.querySelector<HTMLElement>('[data-request-state]')
        if (state) state.textContent = 'Submitted'
      })
    } catch {
      addAgentMessage('error', 'The requested information must be valid JSON.')
    }
  })
  card.querySelector('[data-request-actions]')?.append(accept)
  addRequestButton(card, 'Decline', { action: 'decline', content: null })
}

function renderServerRequest(message: AgentEvent): void {
  if (message.id === undefined || !message.method) return
  const params = message.params as Record<string, unknown> | undefined
  const card = document.createElement('section')
  card.className = 'card card-body border-primary dispatch-agent-request'
  card.dataset.requestId = String(message.id)
  requestIds.set(card.dataset.requestId, message.id)
  card.dataset.timestamp = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())
  const title = document.createElement('strong')
  title.className = 'card-title'
  const description = document.createElement('p')
  description.className = 'text-secondary mb-2'
  const state = document.createElement('small')
  state.className = 'badge bg-blue-lt text-blue align-self-start'
  state.dataset.requestState = ''
  state.textContent = 'Waiting for you'
  const actions = document.createElement('div')
  actions.className = 'd-flex flex-wrap gap-2 mt-3'
  actions.dataset.requestActions = ''
  card.append(title, description, state, actions)
  elements.stream.append(card)

  if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
    title.textContent = message.method.includes('fileChange') ? 'Approve file changes?' : 'Approve command?'
    description.textContent = requestText(params, 'Codex needs approval to continue this task.')
    addRequestButton(card, 'Allow once', { decision: 'accept' }, true)
    addRequestButton(card, 'Decline', { decision: 'decline' })
  } else if (message.method === 'item/permissions/requestApproval') {
    title.textContent = 'Approve permissions?'
    description.textContent = requestText(params, 'Codex needs additional permissions to continue this task.')
    addRequestButton(card, 'Allow for this turn', { permissions: params?.permissions ?? {}, scope: 'turn' }, true)
    addRequestButton(card, 'Decline', { permissions: {}, scope: 'turn' })
  } else if (message.method === 'tool/requestUserInput' || message.method === 'item/tool/requestUserInput') {
    title.textContent = 'Codex needs your input'
    description.textContent = 'Answer this question to continue the task.'
    renderUserInputRequest(card, params ?? {})
  } else if (message.method === 'mcpServer/elicitation/request') {
    const permission = isPermissionElicitation(params)
    title.textContent = permission ? 'Allow this connector action?' : 'Connector needs information'
    description.textContent = requestText(params, permission ? 'Codex wants to run a connector tool.' : 'Provide the requested information to continue.')
    renderElicitationRequest(card, params)
  } else {
    title.textContent = 'Codex needs attention'
    description.textContent = `Unsupported request: ${message.method}`
    addRequestButton(card, 'Cancel request', { decision: 'cancel' })
  }
  setAgentStatus('Needs attention')
  elements.stream.scrollTop = elements.stream.scrollHeight
}

function handleAgentEvent(message: AgentEvent): void {
  if (message.id !== undefined && message.method) {
    renderServerRequest(message)
    return
  }
  const params = message.params as Record<string, unknown> | undefined
  if (message.method === 'dispatch/appServerDisconnected') {
    agentEvents?.close()
    setAgentStatus('Reconnecting', 'Restarting Codex App Server')
    scheduleAgentReconnect()
    return
  }
  if (message.method === 'serverRequest/resolved') {
    const requestId = String(params?.requestId ?? '')
    const card = elements.stream.querySelector<HTMLElement>(`[data-request-id="${CSS.escape(requestId)}"]`)
    if (card) {
      card.classList.add('dispatch-request-resolved')
      card.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea').forEach((control) => { control.disabled = true })
      const state = card.querySelector<HTMLElement>('[data-request-state]')
      if (state && state.textContent === 'Waiting for you') state.textContent = 'Resolved'
    }
    requestIds.delete(requestId)
  }
  if (message.method === 'account/rateLimits/updated') {
    void refreshModelCatalog()
    return
  }
  if (message.method === 'turn/started') {
    const turn = params?.turn as Record<string, unknown> | undefined
    activeTurnId = typeof turn?.id === 'string' ? turn.id : undefined
    elements.stop.hidden = !activeTurnId
    setAgentStatus('Working')
  }
  if (message.method === 'turn/completed') {
    const turn = params?.turn as Record<string, unknown> | undefined
    const status = String(turn?.status ?? 'completed')
    if (searchView?.phase === 'pending') {
      searchView = { ...searchView, phase: 'failed', error: status === 'interrupted' ? 'Search stopped.' : 'Codex did not publish verified results. Refine the request or try again.' }
      renderList()
    }
    // Codex may have created or updated a draft; the Drafts folder is served live, so show it now.
    if (mailbox === 'drafts') void loadConversations(true)
    if (status === 'failed') {
      const error = turn?.error as Record<string, unknown> | undefined
      setAgentStatus('Failed')
      addAgentMessage('error', String(error?.message ?? 'The Codex turn failed.'))
      if (error?.codexErrorInfo === 'usageLimitExceeded') void refreshModelCatalog()
    } else {
      setAgentStatus(status === 'interrupted' ? 'Interrupted' : 'Connected')
    }
    activeAgentMessage = undefined
    activeAgentText = ''
    activeTurnId = undefined
    elements.stop.hidden = true
    const draftToRefresh = activeDraft
    if (draftToRefresh?.id && draftToRefresh.accountId && codexDraftFlights === 0) {
      void refreshCodexDraft(draftToRefresh.id, draftToRefresh.accountId, false)
    }
  }
  if (message.method === 'item/agentMessage/delta') {
    if (!activeAgentMessage) {
      activeAgentText = ''
      activeAgentMessage = addAgentMessage('agent', '')
    }
    activeAgentText += String(params?.delta ?? '')
    updateAgentMessage(activeAgentMessage, activeAgentText)
  }
  // Tool-call starts (item/started for mcpToolCall) and plan updates are
  // intentionally not echoed into the chat: the Working status and activity
  // bar already show progress, and the rows only added noise.
  if (message.method === 'item/completed') {
    const item = params?.item as Record<string, unknown> | undefined
    if (item?.type === 'agentMessage') {
      activeAgentMessage = undefined
      activeAgentText = ''
    }
    const effect = codexMailEffect(item)
    if (effect) {
      if (threadId) restoredMailEffects.set(threadId, JSON.stringify(item))
      void applyCodexMailEffect(effect)
    }
  }
  if (message.method === 'error') {
    const error = params?.error as Record<string, unknown> | undefined
    setAgentStatus('Failed')
    addAgentMessage('error', String(error?.message ?? params?.message ?? 'Codex reported an error.'))
  }
}

let codexDraftFlights = 0
let codexDraftRequest = 0

/** A remote result may update only the editor revision that requested it. */
async function refreshCodexDraft(draftId: string, accountId: string, createdByCodex: boolean): Promise<void> {
  if (!codexContextReady) return
  const snapshot = { selection: selectionSequence, pane: paneSequence, session: draftEditSession, revision: draftEditRevision,
    dirty: draftDirty, saving: Boolean(draftSaveFlight), draftId: activeDraft?.id, accountId: activeDraft?.accountId }
  const request = ++codexDraftRequest
  codexDraftFlights += 1
  try {
    const draft = await api.getDraft(draftId, accountId)
    if (request !== codexDraftRequest || snapshot.selection !== selectionSequence || snapshot.pane !== paneSequence) return
    if (draft.id !== draftId || draft.accountId !== accountId) throw new Error('Gmail returned a different draft or account; the editor was not changed.')
    const unchanged = snapshot.session === draftEditSession && snapshot.revision === draftEditRevision
      && snapshot.draftId === activeDraft?.id && snapshot.accountId === activeDraft?.accountId
      && !snapshot.dirty && !snapshot.saving && !draftDirty && !draftSaveFlight
    if (unchanged) showDraft(draft, false)
    else if (createdByCodex) addAgentMessage('tool', 'Gmail saved the draft. Your current edits were kept; open Drafts to review the saved version.')
    if (createdByCodex && mailbox === 'drafts') void loadConversations(true)
  } catch (error) {
    if (snapshot.selection !== selectionSequence || snapshot.pane !== paneSequence) return
    if (requestErrorCode(String(error)) === 'gmail_draft_not_found') {
      // Codex sent the draft or Gmail replaced it; the id in the event is already stale.
      if (activeDraft?.id === draftId && activeDraft.accountId === accountId && !draftDirty && !draftSaveFlight) { clearRecovery(); hideDraftEditor() }
      addAgentMessage('tool', 'Gmail no longer has that draft; it was sent or replaced. Drafts has been refreshed.')
      if (mailbox === 'drafts') void loadConversations(true)
      return
    }
    addAgentMessage('error', error instanceof Error ? error.message : String(error))
  } finally { codexDraftFlights -= 1 }
}

async function applyCodexMailEffect(effect: CodexMailEffect): Promise<void> {
  if (!codexContextReady) return
  if (effect.kind === 'search') {
    if (!effect.search.requestId && !acceptChatSearchResults) return
    if (effect.search.requestId && effect.search.requestId !== searchView?.requestId) return
    if (searchView?.phase === 'pending' && effect.search.requestId !== searchView.requestId) return
    if (searchView?.requestId && selectedAccountId && effect.search.results.some(result => result.conversation.accountId !== selectedAccountId)) {
      searchView = { ...searchView, phase: 'failed', error: 'The results do not match the selected account. Please retry.' }; renderList(); return
    }
    conversationLoadSequence += 1
    const query = effect.search.requestId && effect.search.requestId === searchView?.requestId ? searchView.query : effect.search.query
    searchView = { ...effect.search, query, phase: 'ready' }
    searchQuery = query
    elements.search.value = searchQuery
    renderList()
    return
  }
  if (effect.kind === 'draft') {
    await refreshCodexDraft(effect.draftId, effect.accountId, true)
    return
  }
  if (effect.draftId && activeDraft?.id === effect.draftId && activeDraft.accountId === effect.accountId && !draftDirty && !draftSaveFlight) { clearRecovery(); hideDraftEditor() }
  if (!offlineMode) void loadConversations(true)
}

function scheduleAgentReconnect(): void {
  if (reconnectTimer !== undefined) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined
    void connectAgent()
  }, 1500)
}

function agentHistoryText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(agentHistoryText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const item = value as Record<string, unknown>
  for (const field of ['text', 'content', 'value']) {
    const extracted = agentHistoryText(item[field])
    if (extracted) return extracted
  }
  return ''
}

async function showCodexThread(nextThreadId: string, created: boolean, replaced: boolean, detail?: string): Promise<void> {
  if (nextThreadId === threadId && agentEvents && agentEvents.readyState !== EventSource.CLOSED) return
  const sequence = ++paneSequence
  threadId = nextThreadId
  agentEvents?.close()
  elements.stream.replaceChildren()
  activeAgentMessage = undefined
  activeAgentText = ''
  activeTurnId = undefined
  elements.stop.hidden = true
  if (replaced) console.info(detail ? `Codex thread replaced · ${detail}` : 'Codex thread replaced')
  if (!created) {
    try {
      const history = await api.readThread(nextThreadId) as { dispatchActivity?: TaskStatus & { requests: AgentEvent[] }; thread?: { turns?: Array<{ id?: string; status?: string; items?: Array<Record<string, unknown>> }> } }
      if (sequence !== paneSequence) return
      const restored = history.thread?.turns?.flatMap((turn) => turn.items ?? []) ?? []
      for (const item of restored) {
        const text = agentHistoryText(item)
        if (text && item.type === 'userMessage') addAgentMessage('user', visibleUserPrompt(text))
        if (text && item.type === 'agentMessage') addAgentMessage('agent', text)
      }
      const running = history.thread?.turns?.findLast(turn => turn.status === 'inProgress')
      const state = history.dispatchActivity ?? { threadId: nextThreadId, status: running ? 'Working' : 'Connected', turnId: running?.id, requests: [] }
      taskStatuses.set(nextThreadId, state)
      activeTurnId = state.turnId
      elements.stop.hidden = !activeTurnId
      const lastItem = restored.at(-1)
      if (activeTurnId && lastItem?.type === 'agentMessage') {
        activeAgentMessage = [...elements.stream.querySelectorAll<HTMLElement>('.dispatch-agent-agent')].at(-1)
        activeAgentText = agentHistoryText(lastItem)
      }
      requestIds.clear()
      for (const request of state.requests) renderServerRequest(request)
      const latest = [...restored].reverse().find(item => { const effect = codexMailEffect(item); return effect?.kind === 'draft' || effect?.kind === 'sent' })
      const effect = latest && codexMailEffect(latest)
      if (effect?.kind === 'draft' && restoredMailEffects.get(nextThreadId) !== JSON.stringify(latest)) pendingMailEffects.set(nextThreadId, { effect, token: JSON.stringify(latest) })
    } catch (error) {
      if (sequence !== paneSequence) return
      addAgentMessage('error', `Could not restore Codex history: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (sequence !== paneSequence) return
  agentEvents = api.events(nextThreadId)
  agentEvents.onopen = () => { if (sequence === paneSequence && nextThreadId === threadId) {
    const state = taskStatuses.get(nextThreadId)
    setAgentStatus(state?.status === 'Complete' ? 'Connected' : state?.status ?? 'Connected')
  } }
  agentEvents.onmessage = (event) => {
    if (sequence === paneSequence && nextThreadId === threadId) handleAgentEvent(JSON.parse(event.data) as AgentEvent)
  }
  agentEvents.onerror = () => {
    if (sequence !== paneSequence || nextThreadId !== threadId) return
    agentEvents?.close()
    setAgentStatus('Reconnecting')
    scheduleAgentReconnect()
  }
}

async function bindAndShowCodex(key: CodexPaneKey, options: { adoptThreadId?: string; sequence?: number; replace?: boolean } = {}): Promise<boolean> {
  const request = ++bindingSequence
  const selection = options.sequence ?? selectionSequence
  const current = () => request === bindingSequence && selection === selectionSequence && bindingCacheKey(key) === bindingCacheKey(desiredCodexKey)
  if (!current()) return false
  try {
    if (!await api.agentReady()) { if (current()) scheduleAgentReconnect(); return false }
    if (!current()) return false
    const binding = await api.bindThread(key, options.adoptThreadId ?? readBindingCache()[bindingCacheKey(key)], { replace: options.replace })
    if (!current()) return false
    writeBindingCache(key, binding.threadId)
    await showCodexThread(binding.threadId, binding.created, binding.replaced, binding.detail)
    if (!current()) return false
    const context = selected ?? (mailbox === 'drafts' ? conversations.find((item) => item.id === selectedConversationId) : undefined)
    const currentKey = context ? conversationBindingKey(context) : !selectedConversationId ? desiredCodexKey : undefined
    if (currentKey && JSON.stringify(key) === JSON.stringify(currentKey) && (options.sequence === undefined || options.sequence === selectionSequence)) codexContextReady = true
    const restore = pendingMailEffects.get(binding.threadId)
    if (codexContextReady && restore) {
      pendingMailEffects.delete(binding.threadId)
      restoredMailEffects.set(binding.threadId, restore.token)
      void applyCodexMailEffect(restore.effect)
    }
    renderBackgroundTasks()
    return true
  } catch (error) {
    if (!current()) return false
    const message = error instanceof Error ? error.message : String(error)
    codexContextReady = false
    elements.stream.replaceChildren()
    if (requestErrorCode(message) === 'codex_thread_busy') {
      setAgentStatus('Needs attention', 'This chat is open in another Codex app')
      renderThreadBusyCard(key, options.sequence)
      return false
    }
    setAgentStatus('Reconnecting')
    addAgentMessage('error', message)
    scheduleAgentReconnect()
    return false
  }
}

/** Codex allows one writer per thread across apps; offer a retry once the other app lets go, or a fresh chat now. */
function renderThreadBusyCard(key: CodexPaneKey, sequence?: number): void {
  const card = document.createElement('div')
  card.className = 'card dispatch-agent-message dispatch-agent-notice'
  card.dataset.threadBusy = 'true'
  const body = document.createElement('div')
  body.className = 'card-body'
  const title = document.createElement('strong')
  title.textContent = 'This chat is open in another Codex app'
  const text = document.createElement('p')
  text.className = 'mb-2 mt-1 text-secondary small'
  text.textContent = 'Codex lets one app write to a chat at a time, and another app (usually ChatGPT) has this one open. Close it there and retry, or start a new chat for this email. The old chat stays in Codex.'
  const actions = document.createElement('div')
  actions.className = 'd-flex gap-2'
  const retry = document.createElement('button')
  retry.type = 'button'; retry.className = 'btn btn-sm btn-outline-secondary'; retry.textContent = 'Retry'
  retry.addEventListener('click', () => { void bindAndShowCodex(key, { sequence: sequence ?? selectionSequence }) })
  const fresh = document.createElement('button')
  fresh.type = 'button'; fresh.className = 'btn btn-sm btn-primary'; fresh.textContent = 'Start new chat'
  fresh.addEventListener('click', () => { void bindAndShowCodex(key, { sequence: sequence ?? selectionSequence, replace: true }) })
  actions.append(retry, fresh)
  body.append(title, text, actions)
  card.append(body)
  elements.stream.append(card)
}

async function connectAgent(): Promise<void> {
  if (agentConnecting) return
  agentConnecting = true
  if (!await api.agentReady()) {
    setAgentStatus('Reconnecting', 'Waiting for Codex App Server')
    void refreshModelCatalog()
    agentConnecting = false
    scheduleAgentReconnect()
    return
  }
  try {
    connectTaskActivity()
    apps = await api.listApps()
    const gmail = gmailAppId(apps)
    setConnectorStatus(gmail ? 'Gmail available' : 'No Gmail connector', Boolean(gmail))
    // Reconnect only the selected context. Never render the general chat as
    // an intermediate step while an email conversation is selected.
    const key = desiredCodexKey
    await bindAndShowCodex(key, { sequence: selectionSequence,
      adoptThreadId: key.kind === 'unbound' ? readBindingCache().unbound : undefined })
    void refreshModelCatalog()
  } catch (error) {
    setAgentStatus('Reconnecting', error instanceof Error ? error.message : String(error))
    scheduleAgentReconnect()
  } finally {
    agentConnecting = false
  }
}

async function sendPrompt(): Promise<void> {
  const text = elements.prompt.value.trim()
  if (!text || !threadId) return
  if (!codexContextReady) { addAgentMessage('error', 'Codex is still connecting to the selected conversation. Please try again.'); return }
  const selection = selectionSequence
  acceptChatSearchResults = true
  addAgentMessage('user', text)
  setAgentStatus('Working')
  elements.prompt.value = ''
  try {
    if (activeTurnId) {
      await api.steerTurn(threadId, activeTurnId, text)
      return
    }
    await api.startTurn(threadId, {
      text,
      ...userChoseModel() ? { model: selectedModelId } : {},
      ...userChoseEffort() ? { effort: selectedEffort } : {},
      appId: gmailAppId(apps),
      mailContext: selected || activeDraft ? {
        searchMatch: selected && searchView ? { query: searchView.query, hits: searchView.results.find(result => result.conversation.id === selectedConversationId)?.hits } : undefined,
        draft: activeDraft ? { id: activeDraft.id, accountId: activeDraft.accountId, to: recipientValue(elements.draftTo), cc: recipientValue(elements.draftCc), bcc: recipientValue(elements.draftBcc), subject: elements.draftSubject.value, hasUnsavedChanges: draftDirty } : undefined,
        accountId: selected?.accountId,
        messageId: selected?.latestMessageId,
        threadId: selected?.threadId,
        subject: selected?.subject,
        sender: selected?.sender.address,
        attachment: selectedAttachmentContext?.accountId === selected?.accountId
          && selectedAttachmentContext?.threadId === selected?.threadId
          && selected?.messages.some((message) => message.id === selectedAttachmentContext?.messageId
            && message.attachments.some((file) => file.id === selectedAttachmentContext?.attachmentId))
          ? selectedAttachmentContext : undefined,
      } : undefined,
    })
  } catch (error) {
    if (selection !== selectionSequence) return
    addAgentMessage('error', error instanceof Error ? error.message : String(error))
  }
}

function renderSearchStatus(): void {
  elements.searchStatus.hidden = !searchView
  elements.searchSummary.textContent = !searchView ? '' : searchView.phase === 'pending' ? 'Searching with Codex…' : searchView.phase === 'failed' ? 'Search needs attention' : `${searchView.results.length} matching ${searchView.results.length === 1 ? 'thread' : 'threads'} · Codex search`
}

function clearSearchView(): void {
  acceptChatSearchResults = false
  if (!searchView) return
  searchView = undefined
  conversationLoadSequence += 1
  searchQuery = ''
  elements.search.value = ''
  renderSearchStatus()
}

async function searchWithCodex(): Promise<void> {
  const query = elements.search.value.trim()
  if (!query) return
  if (searchTimer !== undefined) window.clearTimeout(searchTimer)
  try {
    // Navigation must not drop a draft that has not reached Gmail yet.
    if (activeDraft && !activeDraft.id && draftDirty) await saveDraft(false)
    else await flushDraftAutosave()
    if (draftDirty || draftSaveFlight) throw new Error('Your draft still has unsaved changes. Save it before searching.')
  } catch (error) { elements.mailError.hidden = false; elements.mailError.textContent = String(error); return }
  const requestId = crypto.randomUUID()
  conversationLoadSequence += 1
  const sequence = ++selectionSequence
  selectCodexContext({ kind: 'unbound' })
  markReadDwell.cancel()
  acceptChatSearchResults = false
  searchView = { query, requestId, results: [], phase: 'pending' }
  searchQuery = query
  selected = undefined; selectedConversationId = undefined; selectedAttachmentContext = undefined
  activeDraft = undefined; draftEditSession += 1; codexContextReady = false
  elements.reader.hidden = true; elements.readerEmpty.hidden = false
  elements.readerEmpty.textContent = 'Search results will appear in the message list.'
  elements.mailError.hidden = true
  panels.messages = true; panels.agent = true
  if (usesMobilePanels()) mobilePanel = 'messages'
  renderPanels(); renderList()
  const account = selectedAccountId ? accounts.find(item => item.id === selectedAccountId) : undefined
  try {
    if (!await bindAndShowCodex({ kind: 'unbound' }, { sequence }) || !threadId) throw new Error('Codex is not connected. Try the search again when it is ready.')
    if (sequence !== selectionSequence || searchView?.requestId !== requestId) return
    addAgentMessage('user', query)
    const prompt = `${query}\n\nSelected Gmail search context: ` + [
      `Search email for this request: ${JSON.stringify(query)}.`,
      `Search scope: ${account ? `only account ${account.id} (${account.email})` : 'all connected Gmail accounts'}. Search across mail folders, not only the current Inbox list.`,
      `Current local time: ${new Date().toString()}.`,
      'Use Gmail tools to search and read candidates. For unanswered questions, inspect the conversation replies; unread does not mean unanswered. Do not infer customer identity when the evidence is unclear.',
      `Publish your findings with dispatch_mail.show_search_results using requestId ${requestId} and the original query. Supply the exact account ID, message ID, a verbatim body quote, and a short relevance reason for each match. Return an empty matches list if no sources match.`,
    ].join(' ')
    setAgentStatus('Working')
    if (activeTurnId) await api.steerTurn(threadId, activeTurnId, prompt)
    else await api.startTurn(threadId, { text: prompt, ...userChoseModel() ? { model: selectedModelId } : {}, ...userChoseEffort() ? { effort: selectedEffort } : {}, appId: gmailAppId(apps) })
  } catch (error) {
    if (searchView?.requestId !== requestId) return
    searchView = { ...searchView, phase: 'failed', error: error instanceof Error ? error.message : String(error) }
    renderList()
  }
}

async function loadConversations(preserveSelection = false): Promise<void> {
  if (searchView) { renderList(); return }
  const loadSequence = ++conversationLoadSequence
  const cacheKey = `${offlineMode ? 'offline:' : ''}dispatch.conversations.v1:${selectedAccountId ?? 'all'}:${mailbox}:${mailState}:${searchQuery}`
  let usedCache = false
  let cacheConfirmedAt: number | undefined
  if (!preserveSelection) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) ?? 'null') as { savedAt?: number; conversations?: ConversationSummary[]; nextCursor?: string | null; total?: number } | null
      if (cached?.savedAt && Date.now() - cached.savedAt < 86_400_000 && Array.isArray(cached.conversations)) {
        conversations = cached.conversations
        usedCache = true
        cacheConfirmedAt = cached.savedAt
        nextConversationCursor = cached.nextCursor ?? null
        conversationTotal = cached.total ?? cached.conversations.length
      } else {
        conversations = []
        nextConversationCursor = null
        conversationTotal = 0
      }
    } catch {
      conversations = []
    }
  }
  if (!preserveSelection && !usedCache && mailbox === 'inbox' && mailState !== 'all' && !searchQuery) {
    try {
      const allKey = `dispatch.conversations.v1:${selectedAccountId ?? 'all'}:inbox:all:`
      const cachedAll = JSON.parse(localStorage.getItem(allKey) ?? 'null') as { savedAt?: number; conversations?: ConversationSummary[]; total?: number } | null
      if (cachedAll?.savedAt && Date.now() - cachedAll.savedAt < 86_400_000 && Array.isArray(cachedAll.conversations)) {
        conversations = cachedAll.conversations.filter((conversation) => mailState === 'unread' ? conversation.unread : !conversation.unread)
        usedCache = true
        cacheConfirmedAt = cachedAll.savedAt
        nextConversationCursor = null
        conversationTotal = conversations.length
      }
    } catch {
      // A malformed optional cache must not block a live Gmail refresh.
    }
  }
  const cacheLabel = cacheConfirmedAt
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(cacheConfirmedAt))
    : ''
  elements.mailSource.textContent = usedCache ? `Refreshing · cached ${cacheLabel}` : 'Loading'
  elements.mailError.hidden = true
  if (!preserveSelection) {
    markReadDwell.cancel()
    selected = undefined
    selectedSummary = undefined
    selectedConversationId = undefined
    selectionSequence += 1
    selectCodexContext({ kind: 'unbound' })
    elements.reader.hidden = true
    elements.readerEmpty.hidden = false
    elements.readerEmpty.textContent = usedCache && conversations.length > 0 ? 'Select a message' : `Loading ${mailState === 'all' ? '' : `${mailState} `}${mailboxLabels[mailbox].toLowerCase()}…`
  }
  app.querySelectorAll<HTMLButtonElement>('[data-mail-state]').forEach((button) => {
    const active = button.dataset.mailState === mailState
    button.setAttribute('aria-pressed', String(active))
    button.classList.toggle('active', active)
  })
  renderList(usedCache ? defaultEmptyListMessage() : 'Loading messages…')
  if (usedCache && conversations[0] && !preserveSelection) void selectConversation(conversations[0].id)
  const selectionAtRequest = selectionSequence
  try {
    const result = await api.listConversations(mailState, selectedAccountId, undefined, searchQuery, mailbox, offlineMode)
    if (loadSequence !== conversationLoadSequence) return
    const previous = new Map(conversations.map(conversation => [conversation.id, conversation]))
    for (const conversation of result.conversations) {
      const old = previous.get(conversation.id)
      if (old && old.latestMessageId !== conversation.latestMessageId) dropConversationCache(conversation.id)
    }
    conversations = applyAcceptedReadState(result.conversations).filter(c => !pendingMailboxRemovals.has(`${mailbox}:${c.id}`))
    syncSelectedReadState()
    noteArrivals()
    void refreshMailboxCounts()
    if (mailReconnectTimer !== undefined) window.clearTimeout(mailReconnectTimer)
    mailReconnectTimer = undefined
    nextConversationCursor = result.nextCursor ?? null
    conversationTotal = result.total ?? conversations.length
    localStorage.setItem(cacheKey, JSON.stringify({ savedAt: result.sync?.completedAt ? Date.parse(result.sync.completedAt) : Date.now(), conversations, nextCursor: nextConversationCursor, total: conversationTotal }))
    const refreshedLabel = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date())
    elements.mailSource.textContent = result.source === 'demo'
      ? 'Demo mail'
      : result.coverage === 'downloaded' ? 'Downloaded mail · cached mailbox index'
      : result.coverage === 'recent'
        ? `Recent ${mailboxLabels[mailbox]} · ${refreshedLabel}`
        : `${!selectedAccountId && accounts.length > 1 ? 'Unified Gmail' : 'Gmail connected'} · ${refreshedLabel}`
    if (result.sync && result.coverage !== 'downloaded') elements.mailSource.textContent = result.sync.state === 'ready' ? `Gmail synced · ${syncTime(result.sync.completedAt)}` : result.sync.state === 'failed' ? 'Waiting for Gmail' : 'Syncing Gmail'
    renderList()
    const currentSummary = conversations.find(conversation => conversation.id === selectedConversationId)
    if (!activeDraft && !offlineMode && currentSummary && selectedSummary && (readerNeedsRetry || currentSummary.latestMessageId !== selectedSummary.latestMessageId)) {
      dropConversationCache(currentSummary.id)
      await selectConversation(currentSummary.id, { refresh: true })
      return
    }
    if (mailbox === 'drafts' && !activeDraft && selectedConversationId && !conversations.some(item => item.id === selectedConversationId)) {
      selected = undefined; selectedSummary = undefined; selectedConversationId = undefined
      if (conversations[0]) { await selectConversation(conversations[0].id); return }
      elements.reader.hidden = true; elements.readerEmpty.hidden = false; elements.readerEmpty.textContent = 'No drafts'
    }
    if (conversations[0]) {
      const selectedStillListed = Boolean(selectedConversationId && conversations.some((conversation) => conversation.id === selectedConversationId))
      if (!preserveSelection && !selectedStillListed && selectionSequence === selectionAtRequest) await selectConversation(conversations[0].id)
    } else if (!preserveSelection && selectionSequence === selectionAtRequest) {
      selected = undefined
      selectedConversationId = undefined
      elements.reader.hidden = true
      elements.readerEmpty.hidden = false
      elements.readerEmpty.textContent = mailbox === 'drafts' && elements.list.querySelector('[data-local-draft-key]') ? 'Select a draft' : defaultEmptyListMessage()
      void bindAndShowCodex({ kind: 'unbound' }, { sequence: selectionSequence })
    }
  } catch (error) {
    if (loadSequence !== conversationLoadSequence) return
    if (usedCache) {
      elements.mailSource.textContent = `STALE · ${cacheLabel}`
      elements.mailError.hidden = false
      const detail = error instanceof Error ? error.message : String(error)
      elements.mailError.textContent = `Gmail is unavailable. Showing mail saved ${cacheLabel}.`
      scheduleMailReconnect()
      return
    }
    elements.mailSource.textContent = 'Unavailable'
    elements.mailError.hidden = false
    elements.mailError.textContent = 'Gmail is unavailable. Dispatch will reconnect automatically.'
    scheduleMailReconnect()
  }
}

/** Compares a confirmed live inbox list against the previous one for the same scope and chimes only for newly arrived unread mail, never for older threads that an archive or delete scrolled onto the page. */
function noteArrivals(): void {
  if (mailbox !== 'inbox' || searchQuery || mailState === 'read') {
    liveInboxBaseline = undefined
    return
  }
  const scope = `${selectedAccountId ?? 'all'}:${mailState}`
  const previous = liveInboxBaseline?.scope === scope ? liveInboxBaseline.baseline : undefined
  const arrived = arrivedUnreadIds(previous, conversations)
  liveInboxBaseline = { scope, baseline: liveListBaseline(conversations) }
  if (arrived.length > 0) void chimeNewMail()
}

function unlockTone(): void {
  toneContext ??= new AudioContext()
  if (toneContext.state === 'suspended') void toneContext.resume()
}

async function chimeNewMail(): Promise<void> {
  try {
    toneContext ??= new AudioContext()
    const played = await playNewMailTone(toneContext)
    if (!played) console.warn('New mail arrived but the audio context is suspended until the first click or keypress.')
  } catch (error) {
    console.warn('New mail tone failed', error)
  }
}

function syncTime(value: string | null): string {
  if (!value) return 'never'
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

let mailboxCountsFlight: Promise<void> | undefined

function renderMailboxCounts(counts: MailboxCounts): void {
  for (const [name, value] of Object.entries(counts) as Array<[keyof MailboxCounts, number]>) {
    app.querySelectorAll<HTMLElement>(`[data-mailbox-count="${name}"]`).forEach((badge) => {
      badge.hidden = value <= 0
      badge.textContent = value > 99 ? '99+' : String(value)
      badge.classList.toggle('dispatch-mailbox-count-unread', name === 'inbox')
    })
  }
}

async function refreshMailboxCounts(): Promise<void> {
  if (offlineMode || mailboxCountsFlight) return
  mailboxCountsFlight = (async () => {
    try { renderMailboxCounts(await api.mailboxCounts(selectedAccountId)) } catch { /* the badges keep their last value until the next poll */ }
  })().finally(() => { mailboxCountsFlight = undefined })
  await mailboxCountsFlight
}

async function refreshSyncStatus(): Promise<void> {
  if (offlineMode) { elements.mailSource.textContent = 'Downloaded mail'; return }
  void refreshMailboxCounts()
  try {
    const sync = await api.syncStatus()
    if (sync.mailRevision !== undefined && observedMailRevision !== sync.mailRevision) {
      const changed = observedMailRevision !== undefined
      observedMailRevision = sync.mailRevision
      if (changed) void loadConversations(true)
    }
    if (sync.draftsRevision !== undefined && observedDraftsRevision !== sync.draftsRevision) {
      observedDraftsRevision = sync.draftsRevision
      if (mailbox === 'drafts') void loadConversations(true)
    }
    if (sync.state === 'failed') {
      if (/RATE_LIMITED|rateLimitExceeded|Retry after/i.test(sync.error ?? '')) {
        elements.mailSource.textContent = 'Waiting for Gmail'
        elements.mailSource.title = sync.error ?? ''
        if (syncErrorVisible) elements.mailError.hidden = true
        syncErrorVisible = true
        return
      }
      elements.mailSource.textContent = `SYNC FAILED · ${syncTime(sync.startedAt)}`
      elements.mailError.hidden = false
      elements.mailError.textContent = 'Gmail could not sync. Your mail and pending edits are kept on this device.'
      syncErrorVisible = true
    } else if (sync.state === 'syncing') {
      if (syncErrorVisible) elements.mailError.hidden = true
      syncErrorVisible = false
      const accountProgress = sync.accountCount
        ? ` · account ${Math.min((sync.accountsCompleted ?? 0) + 1, sync.accountCount)}/${sync.accountCount}`
        : ''
      elements.mailSource.textContent = `Syncing Gmail${accountProgress} · ${sync.fetchedMessages ?? sync.messageCount} fetched`
    } else if (sync.state === 'partial') {
      elements.mailSource.textContent = sync.error?.includes('mail changes') ? 'Changes waiting to sync' : `Partial Gmail index · ${sync.messageCount} messages`
      elements.mailSource.title = sync.error ?? ''
    } else if (sync.state === 'ready') {
      elements.mailSource.title = ''
      elements.mailSource.textContent = `Gmail synced · ${syncTime(sync.completedAt)}`
      if (syncErrorVisible) elements.mailError.hidden = true
      syncErrorVisible = false
      const changed = observedSyncCompletedAt !== undefined && sync.completedAt !== observedSyncCompletedAt
      observedSyncCompletedAt = sync.completedAt
      if (changed && !activeDraft) void loadConversations(true)
    }
  } catch (error) {
    elements.mailSource.textContent = 'SYNC STATUS FAILED'
    elements.mailError.hidden = false
    elements.mailError.textContent = 'Dispatch is reconnecting to mail.'
    syncErrorVisible = true
  }
}

function startSyncStatusWatch(): void {
  if (syncStatusTimer !== undefined) return
  void refreshSyncStatus()
  syncStatusTimer = window.setInterval(() => { void refreshSyncStatus() }, 5_000)
}

function scheduleMailReconnect(delayMs = 1_500): void {
  if (mailReconnectTimer !== undefined) return
  mailReconnectTimer = window.setTimeout(() => {
    mailReconnectTimer = undefined
    void connectMail()
  }, delayMs)
}

async function connectMail(): Promise<void> {
  try {
    accounts = await api.listAccounts(offlineMode)
    if (accounts.length > 0) {
      const all = document.createElement('option')
      all.value = ''
      all.textContent = `All inboxes (${accounts.length})`
      all.selected = !selectedAccountId
      elements.account.replaceChildren(all, ...accounts.map((account) => {
        const option = document.createElement('option')
        option.value = account.id
        option.textContent = account.email || account.name
        option.selected = account.id === selectedAccountId
        return option
      }))
    }
    await loadConversations()
    if (accounts.length > 0) startSyncStatusWatch()
  } catch (error) {
    if (isServiceUnreachable(error) && performance.now() < mailStartupGraceUntil) {
      // The native shell starts the mail sidecar alongside the window, so the
      // first requests can race its listener. That is startup, not a failure.
      elements.mailSource.textContent = 'Starting mail service…'
      scheduleMailReconnect(MAIL_STARTUP_RETRY_MS)
      return
    }
    elements.mailSource.textContent = 'Unavailable'
    elements.mailError.hidden = false
    elements.mailError.textContent = error instanceof Error ? error.message : String(error)
    scheduleMailReconnect()
  }
}

function isServiceUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Service request failed at ')
}

function renderOfflineStatus(): void {
  const checkbox = app.querySelector<HTMLInputElement>('[data-offline-mode]')!
  checkbox.checked = offlineMode
  const summary = app.querySelector<HTMLElement>('[data-offline-status]')!
  const job = offlineStatus?.download
  summary.textContent = offlineStatus ? `${offlineStatus.conversations} conversations downloaded · ${(offlineStatus.bytes / 1_000_000).toFixed(1)} MB${job ? `
${job.mailbox}: ${job.state} · ${job.completed}/${job.total}${job.errors.length ? `
${job.errors.length} failed: ${job.errors.slice(0, 3).join('; ')}` : ''}` : ''}` : 'Loading downloaded-mail status…'
  const download = app.querySelector<HTMLButtonElement>('[data-download-mailbox]')!
  download.textContent = `Download ${mailboxLabels[mailbox]}`
  download.disabled = job?.state === 'running' || offlineMode
  app.querySelector<HTMLElement>('[data-cancel-download]')!.hidden = job?.state !== 'running'
  app.querySelector('[data-offline-open]')?.classList.toggle('active', offlineMode)
}
async function refreshUtilities(): Promise<void> {
  try { offlineStatus = await api.offlineStatus(); renderOfflineStatus() }
  catch (error) { if (app.querySelector<HTMLDialogElement>('[data-offline-dialog]')!.open) app.querySelector<HTMLElement>('[data-offline-status]')!.textContent = `Downloaded-mail status unavailable: ${String(error)}` }
}
function setDownloadedMode(value: boolean): void {
  if (draftDirty) checkpointDraft()
  offlineMode = value; localStorage.setItem('dispatch.offline-mode', String(value)); localStorage.setItem('dispatch.offline-mode-source', 'manual')
  if (!value) scheduleDraftSync(0)
  clearSearchView(); conversationCache.clear(); renderOfflineStatus()
  void connectMail()
}
function persistSidebar(): void {
  localStorage.setItem('dispatch.ui.sidebar', mailboxesVisible ? sidebarStyle : 'hidden')
  localStorage.setItem('dispatch.ui.sidebar.last-visible', sidebarStyle)
}
function setSidebarMenu(open: boolean): void {
  const menu = app.querySelector<HTMLElement>('[data-sidebar-menu]')!
  const button = app.querySelector<HTMLButtonElement>('[data-sidebar-options]')!
  menu.hidden = !open; menu.classList.toggle('show', open); button.setAttribute('aria-expanded', String(open))
  if (open) {
    const rect = button.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 188))}px`
    menu.style.top = `${rect.bottom + 4}px`
    menu.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
  }
}
app.querySelector('[data-sidebar-options]')?.addEventListener('click', event => { event.stopPropagation(); setSidebarMenu(app.querySelector<HTMLElement>('[data-sidebar-menu]')!.hidden) })
app.querySelectorAll<HTMLButtonElement>('[data-sidebar-style]').forEach(button => button.addEventListener('click', () => {
  sidebarStyle = button.dataset.sidebarStyle as SidebarStyle; mailboxesVisible = true; persistSidebar(); renderPanels(); setSidebarMenu(false)
  app.querySelector<HTMLButtonElement>('[data-sidebar-options]')!.focus()
}))
// Appearance lives in the native View menu. The shell mirrors the preference
// (menu check marks and window theme) and forwards menu clicks as an event.
const nativeTauri = (window as { __TAURI__?: { core?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }; event?: { listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> } } }).__TAURI__
if (isNativeShell(window as { isTauri?: unknown })) {
  const reportAppearance = () => { nativeTauri?.core?.invoke('set_appearance', { preference: theme.preference }).catch(() => {}) }
  reportAppearance()
  void nativeTauri?.event?.listen('dispatch://appearance', event => {
    const next = event.payload
    if (!THEME_PREFERENCES.includes(next as ThemePreference)) return
    theme.set(next as ThemePreference)
    reportAppearance()
  })
}
app.querySelector('[data-sidebar-menu]')?.addEventListener('keydown', event => {
  const key = (event as KeyboardEvent).key
  if (!['ArrowDown','ArrowUp','Home','End'].includes(key)) return
  event.preventDefault()
  const buttons = [...app.querySelectorAll<HTMLButtonElement>('[data-sidebar-menu] [role="menuitemradio"]')]
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[key === 'Home' ? 0 : key === 'End' ? buttons.length - 1 : (current + (key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
})
app.querySelector('[data-mailboxes-toggle]')?.addEventListener('click', () => {
  if (usesMobilePanels()) { setFolderMenu(elements.folderMenu.hidden); return }
  mailboxesVisible = !mailboxesVisible; persistSidebar(); renderPanels()
})
function renderDensity(): void {
  document.documentElement.classList.toggle('dispatch-compact', compactMessages)
  const button = app.querySelector<HTMLButtonElement>('[data-density]')!
  button.setAttribute('aria-pressed', String(compactMessages))
  button.setAttribute('aria-label', compactMessages ? 'Use comfortable message list' : 'Use compact message list')
}
app.querySelector('[data-density]')?.addEventListener('click', () => { compactMessages = !compactMessages; localStorage.setItem('dispatch.ui.density', compactMessages ? 'compact' : 'comfortable'); renderDensity() })
renderDensity()
function closeActivity(): void { app.querySelector<HTMLElement>('#dispatch-activity')!.hidden = true; app.querySelector('[data-activity-toggle]')!.setAttribute('aria-expanded', 'false') }
app.querySelector('[data-activity-toggle]')?.addEventListener('click', () => {
  const panel = app.querySelector<HTMLElement>('#dispatch-activity')!; panel.hidden = !panel.hidden
  app.querySelector('[data-activity-toggle]')!.setAttribute('aria-expanded', String(!panel.hidden))
})
for (const selector of ['[data-offline-open]']) app.querySelector(selector)?.addEventListener('click', closeActivity)
document.addEventListener('click', event => { if (!(event.target as Element).closest('.dispatch-mail-activity')) closeActivity() })
for (const name of ['offline']) {
  const dialog = app.querySelector<HTMLDialogElement>(`[data-${name}-dialog]`)!
  dialog.addEventListener('close', () => app.querySelector<HTMLButtonElement>('[data-activity-toggle]')?.focus())
}
app.querySelectorAll<HTMLButtonElement>('[data-dialog-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog')!.close()))
app.querySelector('[data-offline-open]')?.addEventListener('click', () => { renderOfflineStatus(); app.querySelector<HTMLDialogElement>('[data-offline-dialog]')!.show(); void refreshUtilities() })
app.querySelector<HTMLInputElement>('[data-offline-mode]')?.addEventListener('change', event => setDownloadedMode((event.target as HTMLInputElement).checked))
app.querySelector('[data-download-mailbox]')?.addEventListener('click', () => { void api.downloadMailbox(mailbox, selectedAccountId).then(refreshUtilities).catch(error => { app.querySelector<HTMLElement>('[data-offline-status]')!.textContent = String(error) }) })
app.querySelector('[data-cancel-download]')?.addEventListener('click', () => { void api.cancelDownload().then(refreshUtilities).catch(error => { app.querySelector<HTMLElement>('[data-offline-status]')!.textContent = String(error) }) })
window.addEventListener('offline', () => { if (!offlineMode) elements.mailSource.textContent = 'Waiting for connection' })
renderRecoveryList()
scheduleDraftSync()
void refreshUtilities()
window.setInterval(() => { if (offlineStatus?.download?.state === 'running' || app.querySelector<HTMLDialogElement>('[data-offline-dialog]')!.open) void refreshUtilities() }, 5000)

async function start(): Promise<void> {
  await Promise.all([connectMail(), connectAgent()])
}

window.addEventListener('pointerdown', unlockTone, { once: true })
window.addEventListener('keydown', unlockTone, { once: true })
let refreshRequest: Promise<void> | undefined
let lastAutomaticRefresh = 0
function requestMailRefresh(reason: 'manual' | 'wake' | 'foreground' = 'manual'): Promise<void> {
  if (offlineMode || refreshRequest) return refreshRequest ?? Promise.resolve()
  if (reason === 'foreground' && Date.now() - lastAutomaticRefresh < 10_000) return Promise.resolve()
  const button = app.querySelector<HTMLButtonElement>('[data-refresh]')!
  button.disabled = true
  elements.mailSource.textContent = 'Refreshing Gmail…'
  elements.mailError.hidden = true
  refreshRequest = api.refreshMail(reason).then((sync) => {
    lastAutomaticRefresh = Date.now()
    observedSyncCompletedAt = sync.completedAt
    return loadConversations(true)
  }).catch((error) => {
    elements.mailSource.textContent = 'Reconnecting to mail'
    elements.mailError.hidden = false
    elements.mailError.textContent = 'Mail could not refresh yet. Your messages and drafts are kept. Dispatch will reconnect automatically.'
    scheduleMailReconnect()
  }).finally(() => { button.disabled = false; refreshRequest = undefined })
  return refreshRequest
}
app.querySelector<HTMLButtonElement>('[data-refresh]')?.addEventListener('click', () => { void requestMailRefresh() })
window.addEventListener('online', () => { void requestMailRefresh('wake') })
window.addEventListener('focus', () => { void requestMailRefresh('foreground') })
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void requestMailRefresh('foreground')
})
elements.account.addEventListener('change', () => {
  clearSearchView()
  selectedAccountId = elements.account.value || undefined
  void loadConversations()
})
function switchMailbox(next: GmailMailbox): void {
  clearSearchView()
  mailbox = next
  renderMailbox()
  void loadConversations()
}
app.querySelectorAll<HTMLButtonElement>('[data-mailbox]').forEach((button) => button.addEventListener('click', () => switchMailbox(button.dataset.mailbox as GmailMailbox)))
elements.search.addEventListener('input', () => {
  searchQuery = elements.search.value.trim()
  if (searchTimer !== undefined) window.clearTimeout(searchTimer)
  if (searchView && !searchQuery) clearSearchView()
  if (searchView || activeDraft) return
  searchTimer = window.setTimeout(() => { void loadConversations() }, 250)
})
elements.search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void searchWithCodex() } })
app.querySelector('[data-ai-search]')?.addEventListener('click', () => { void searchWithCodex() })
app.querySelector('[data-clear-search]')?.addEventListener('click', () => { clearSearchView(); void loadConversations() })
app.querySelectorAll<HTMLButtonElement>('[data-mail-state]').forEach((button) => button.addEventListener('click', () => {
  clearSearchView()
  mailState = button.dataset.mailState as MailStateFilter
  void loadConversations()
}))
app.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((button) => button.addEventListener('click', () => {
  const name = button.dataset.panel as PanelName
  if (usesMobilePanels()) {
    mobilePanel = name
    if (name !== 'messages') mobileReturnPanel = name
    renderPanels()
    return
  }
  const visibleCount = Number(panels.messages) + Number(panels.reader) + Number(panels.agent)
  if (panels[name] && visibleCount === 1) return
  panels[name] = !panels[name]
  renderPanels()
}))
elements.messagesDivider.addEventListener('pointerdown', (event) => resizePanel('messagesWidth', event))
elements.agentDivider.addEventListener('pointerdown', (event) => resizePanel('agentWidth', event))
elements.messagesDivider.addEventListener('keydown', (event) => resizePanelWithKeyboard('messagesWidth', event))
elements.agentDivider.addEventListener('keydown', (event) => resizePanelWithKeyboard('agentWidth', event))
elements.messagesDivider.addEventListener('dblclick', () => { panels.messages = false; renderPanels() })
elements.agentDivider.addEventListener('dblclick', () => { panels.agent = false; renderPanels() })
app.querySelector('[data-collapse-messages]')?.addEventListener('click', () => { panels.messages = false; renderPanels() })
app.querySelector('[data-collapse-reader]')?.addEventListener('click', () => { panels.reader = false; renderPanels() })
app.querySelector('[data-mobile-back]')?.addEventListener('click', () => { mobilePanel = 'messages'; renderPanels() })
app.querySelector('[data-compose]')?.addEventListener('click', () => openCompose())
app.querySelector('[data-reply]')?.addEventListener('click', () => { void openDraft(false).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))) })
app.querySelector('[data-reply-all]')?.addEventListener('click', () => { void openDraft(true).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))) })
app.querySelector('[data-forward]')?.addEventListener('click', () => { void openForward().catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))) })
elements.archive.addEventListener('click', () => { void mutateSelected('archive') })
elements.spam.addEventListener('click', () => { void mutateSelected('spam') })
elements.trash.addEventListener('click', () => { void mutateSelected('trash') })
elements.moveInbox.addEventListener('click', () => { void mutateSelected('inbox') })
app.querySelector('[data-ask]')?.addEventListener('click', askCodex)
app.querySelector('[data-save-draft]')?.addEventListener('click', () => { void saveDraft().catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))) })
app.querySelector('[data-send-draft]')?.addEventListener('click', sendDraft)
app.querySelector('[data-send-cancel]')?.addEventListener('click', () => { elements.sendConfirm.hidden = true })
app.querySelector('[data-send-confirm-go]')?.addEventListener('click', () => { void confirmSendDraft().catch(draftError) })
app.querySelector('[data-discard-draft]')?.addEventListener('click', () => { void discardDraft().catch(draftError) })
app.querySelector('[data-attach-draft]')?.addEventListener('click', () => { elements.draftFiles.click() })
elements.draftFiles.addEventListener('change', () => { void attachDraftFiles() })
elements.draftBody.addEventListener('input', () => {
  elements.sendConfirm.hidden = true
  markDraftDirty()
  refreshPreview()
  autosaveDraft()
})
for (const field of [elements.draftTo, elements.draftCc, elements.draftBcc]) {
  field.addEventListener('input', () => {
    elements.sendConfirm.hidden = true
    markDraftDirty()
    onRecipientInput(field)
    if (activeDraft?.id) autosaveDraft()
  })
  field.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === 'Tab') && field.value.trim()) {
      if (event.key === 'Enter') event.preventDefault()
      acceptRecipientInput(field)
      markDraftDirty()
      if (activeDraft?.id) autosaveDraft()
    }
    if (event.key === 'Backspace' && !field.value) {
      const chips = recipientChipAddresses(field)
      if (chips.length === 0) return
      renderRecipientChips(field, chips.slice(0, -1))
      markDraftDirty()
      if (activeDraft?.id) autosaveDraft()
    }
    if (event.key === 'Escape') hideRecipientSuggestions(field)
  })
  field.addEventListener('blur', () => {
    window.setTimeout(() => hideRecipientSuggestions(field), 120)
  })
}
elements.draftSubject.addEventListener('input', () => {
  elements.sendConfirm.hidden = true
  markDraftDirty()
  if (activeDraft?.id) autosaveDraft()
})
elements.draftAccount.addEventListener('input', () => { markDraftDirty(); elements.sendConfirm.hidden = true })
app.querySelector('[data-revise-draft]')?.addEventListener('click', () => { void reviseDraft().catch(draftError) })
elements.readState.addEventListener('click', () => { void toggleReadState() })
app.querySelector('[data-send]')?.addEventListener('click', () => { void sendPrompt() })
elements.stop.addEventListener('click', () => {
  if (threadId && activeTurnId) void api.interruptTurn(threadId, activeTurnId)
})
app.querySelectorAll<HTMLElement>('[data-suggestion]').forEach((button) => button.addEventListener('click', () => {
  elements.prompt.value = button.dataset.suggestion ?? ''
  elements.prompt.focus()
}))
elements.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendPrompt()
  }
})
const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }
function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1)
}
function placeholderModel(): DispatchModel {
  return {
    id: selectedModelId,
    label: selectedModelId || (modelCatalogError ? 'Model' : 'Loading models'),
    efforts: selectedEffort ? [selectedEffort] : [],
    exhausted: null,
    resetsAt: null,
  }
}
function currentModel(): DispatchModel {
  if (!modelCatalog) return placeholderModel()
  return modelCatalog.models.find((model) => model.id === selectedModelId)
    ?? (selectedModelId
      ? { id: selectedModelId, label: selectedModelId, efforts: selectedEffort ? [selectedEffort] : [], exhausted: null, resetsAt: null }
      : placeholderModel())
}
function modelToggleText(model: DispatchModel): string {
  if (!model.id) return model.label
  const effort = selectedEffort || modelCatalog?.defaults.effort || ''
  return effort ? `${model.label} · ${effortLabel(effort)}` : model.label
}
function resetLabel(resetsAt: number | null): string {
  if (!resetsAt) return ''
  return ` · resets ${new Date(resetsAt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}
function renderModelPicker(): void {
  const model = currentModel()
  elements.modelLabel.textContent = modelToggleText(model)
  elements.modelToggle.classList.toggle('bg-blue-lt', model.exhausted !== true)
  elements.modelToggle.classList.toggle('text-blue', model.exhausted !== true)
  elements.modelToggle.classList.toggle('bg-yellow-lt', model.exhausted === true)
  elements.modelToggle.classList.toggle('text-yellow', model.exhausted === true)
  if (modelCatalogError) elements.modelSummary.textContent = modelCatalogError
  else if (!modelCatalog) elements.modelSummary.textContent = 'Loading models'
  else if (model.exhausted === true) elements.modelSummary.textContent = `${model.label} has reached its usage limit. Pick another model.`
  else if (modelCatalog.rateLimitsError) elements.modelSummary.textContent = `Usage limits unavailable: ${modelCatalog.rateLimitsError}`
  else elements.modelSummary.textContent = 'Model'
  elements.modelList.replaceChildren()
  for (const candidate of modelCatalog?.models ?? (model.id ? [model] : [])) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'dropdown-item dispatch-model-option'
    row.setAttribute('role', 'menuitemradio')
    row.setAttribute('aria-checked', String(candidate.id === selectedModelId))
    row.dataset.modelId = candidate.id
    row.disabled = candidate.exhausted === true
    const name = document.createElement('span')
    name.className = 'dispatch-model-name'
    name.textContent = candidate.label
    row.append(name)
    if (candidate.id === selectedModelId && candidate.exhausted !== true) {
      const check = document.createElement('i')
      check.className = 'ti ti-check ms-auto'
      check.setAttribute('aria-hidden', 'true')
      row.append(check)
    }
    if (candidate.exhausted === true) {
      const note = document.createElement('span')
      note.className = 'text-secondary small dispatch-model-note'
      note.textContent = `Limit reached${resetLabel(candidate.resetsAt)}`
      row.append(note)
    }
    row.addEventListener('click', (event) => {
      event.stopPropagation()
      selectModel(candidate.id)
    })
    elements.modelList.append(row)
  }
  elements.modelEfforts.replaceChildren()
  for (const effort of model.efforts) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `btn btn-sm ${effort === selectedEffort ? 'btn-primary' : 'btn-outline-secondary'}`
    button.setAttribute('aria-pressed', String(effort === selectedEffort))
    button.dataset.effort = effort
    button.textContent = effortLabel(effort)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      selectedEffort = effort
      localStorage.setItem('dispatch.codex.effort', effort)
      renderModelPicker()
    })
    elements.modelEfforts.append(button)
  }
}
function selectModel(id: string): void {
  selectedModelId = id
  localStorage.setItem('dispatch.codex.model', id)
  const efforts = currentModel().efforts
  if (efforts.length > 0 && !efforts.includes(selectedEffort)) {
    selectedEffort = efforts.includes('medium') ? 'medium' : efforts[efforts.length - 1]!
    localStorage.setItem('dispatch.codex.effort', selectedEffort)
  }
  renderModelPicker()
}
let modelCatalogRequest: Promise<void> | undefined
async function refreshModelCatalog(): Promise<void> {
  if (modelCatalogRequest) return modelCatalogRequest
  modelCatalogRequest = (async () => {
    try {
      if (!await api.agentReady()) {
        modelCatalogError = 'Codex not connected'
        return
      }
      modelCatalog = await api.listModels()
      modelCatalogError = undefined
      if (!userChoseModel()) selectedModelId = modelCatalog.defaults.model
      if (!userChoseEffort()) selectedEffort = modelCatalog.defaults.effort
    } catch (error) {
      modelCatalogError = error instanceof Error ? error.message : String(error)
    } finally {
      modelCatalogRequest = undefined
      renderModelPicker()
    }
  })()
  return modelCatalogRequest
}
function setModelMenu(open: boolean): void {
  elements.modelMenu.hidden = !open
  elements.modelMenu.classList.toggle('show', open)
  elements.modelToggle.setAttribute('aria-expanded', String(open))
  if (open) void refreshModelCatalog()
}
elements.modelToggle.addEventListener('click', (event) => {
  event.stopPropagation()
  setModelMenu(elements.modelMenu.hidden)
})
renderModelPicker()
void refreshModelCatalog()
let setupReturnFocus: HTMLElement | null = null

function hideSetup(): void {
  markSetupSeen(localStorage)
  elements.setup.hidden = true
  elements.toolbar.inert = false
  elements.workspace.inert = false
  setupReturnFocus?.focus()
  setupReturnFocus = null
}

function showSetup(): void {
  const active = document.activeElement
  setupReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null
  elements.setup.hidden = false
  elements.toolbar.inert = true
  elements.workspace.inert = true
  elements.setupHeading.focus()
}

if (setupSeen(localStorage)) elements.setup.hidden = true
else showSetup()
elements.setupContinue.addEventListener('click', hideSetup)
elements.setupLater.addEventListener('click', hideSetup)
elements.setupOpen.addEventListener('click', showSetup)
elements.setup.addEventListener('keydown', (event) => event.stopPropagation())
function setFolderMenu(open: boolean): void {
  elements.folderMenu.hidden = !open
  elements.folderMenu.classList.toggle('show', open)
  elements.folderToggle.setAttribute('aria-expanded', String(open))
}
elements.folderToggle.addEventListener('click', (event) => {
  event.stopPropagation()
  setFolderMenu(elements.folderMenu.hidden)
})
elements.folderMenu.addEventListener('click', () => setFolderMenu(false))
function setReaderMenu(open: boolean): void {
  elements.readerMenu.hidden = !open
  elements.readerMenu.classList.toggle('show', open)
  elements.readerMore.setAttribute('aria-expanded', String(open))
}
elements.readerMore.addEventListener('click', (event) => {
  event.stopPropagation()
  setReaderMenu(elements.readerMenu.hidden)
})
elements.readerMenu.addEventListener('click', () => setReaderMenu(false))
document.addEventListener('click', (event) => {
  if (!(event.target as Element).closest('[data-sidebar-menu], [data-sidebar-options]')) setSidebarMenu(false)
  if (!elements.folderMenu.hidden && !elements.folderMenu.contains(event.target as Node)) setFolderMenu(false)
  if (!elements.readerMenu.hidden && !elements.readerMenu.contains(event.target as Node)) setReaderMenu(false)
  if (!elements.modelMenu.hidden && !elements.modelMenu.contains(event.target as Node)) setModelMenu(false)
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (!app.querySelector<HTMLElement>('[data-sidebar-menu]')!.hidden) { setSidebarMenu(false); app.querySelector<HTMLButtonElement>('[data-sidebar-options]')!.focus() }
  closeActivity()
  app.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close())
  setFolderMenu(false)
  setReaderMenu(false)
  setModelMenu(false)
})
window.addEventListener('resize', renderPanels)
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    elements.search.focus()
    elements.search.select()
    return
  }
  if (!event.ctrlKey || event.metaKey || event.altKey || event.code !== 'Backquote') return
  event.preventDefault()
  if (usesMobilePanels()) {
    if (mobilePanel === 'messages') mobilePanel = selectedConversationId || activeDraft ? mobileReturnPanel : 'agent'
    else {
      mobileReturnPanel = mobilePanel
      mobilePanel = 'messages'
    }
  } else {
    panels.messages = !panels.messages
  }
  renderPanels()
})

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  return Boolean(element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], dialog[open]'))
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return
  if (event.altKey || event.ctrlKey || event.shiftKey || (event.metaKey && event.key === 'Delete')) return
  if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
  if (activeDraft && !selectedConversationId && selection.ids.length <= 1) return
  const ids = selection.ids.length > 1 ? selection.ids : selectedConversationId ? [selectedConversationId] : []
  if (ids.length === 0) return
  event.preventDefault()
  if (mailbox === 'trash') {
    elements.mailError.hidden = false
    elements.mailError.textContent = 'Gmail does not allow Dispatch to delete permanently. Empty the trash in Gmail.'
    return
  }
  void mutateConversations(ids, 'trash')
})

elements.list.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape' && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a')) return
  const order = listedIds()
  if (order.length === 0) return
  event.preventDefault()
  if (event.key === 'Escape') {
    if (selection.ids.length > 1) void applySelection({ ids: [selection.anchor ?? selection.ids[0]!], anchor: selection.anchor ?? selection.ids[0] })
    return
  }
  if (event.key.toLowerCase() === 'a') { void applySelection({ ids: order, anchor: selection.anchor ?? order[0] }); return }
  moveSelection(event.key === 'ArrowDown' ? 1 : -1, event.shiftKey)
})

function moveSelection(direction: 1 | -1, extend: boolean): void {
  const order = listedIds()
  if (order.length === 0) return
  const next = selectionAfterArrow(pruneSelection(selection, order), order, direction, extend)
  const focusId = direction === 1 ? next.ids[next.ids.length - 1] : next.ids[0]
  void applySelection(next).then(() => { elements.list.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(focusId ?? '')}"]`)?.focus() })
}

const shortcutsDialog = app.querySelector<HTMLDialogElement>('[data-shortcuts-dialog]')!
shortcutsDialog.querySelector<HTMLElement>('[data-shortcut-groups]')!.replaceChildren(...SHORTCUT_GROUPS.map((group) => {
  const section = document.createElement('section')
  const heading = document.createElement('h3')
  heading.textContent = group.title
  const list = document.createElement('dl')
  for (const item of group.items) {
    const term = document.createElement('dt'); term.textContent = item.label
    const keys = document.createElement('dd'); const kbd = document.createElement('kbd'); kbd.textContent = item.keys; keys.append(kbd)
    list.append(term, keys)
  }
  section.append(heading, list)
  return section
}))
for (const [name, key] of Object.entries(TOOLBAR_KEYS)) {
  const selector = name === 'replyAll' ? '[data-reply-all]' : name === 'readState' ? '[data-read-state]' : `[data-${name}]`
  const button = app.querySelector<HTMLElement>(`.dispatch-reader-toolbar ${selector}`)
  if (button) button.dataset.shortcut = key
}

let pendingGo = false
let pendingGoTimer: number | undefined
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
  if (app.querySelector('dialog[open]')) return
  const resolved = resolveShortcut(event, pendingGo)
  const wasPending = pendingGo
  pendingGo = false
  if (pendingGoTimer !== undefined) { window.clearTimeout(pendingGoTimer); pendingGoTimer = undefined }
  if (!resolved) { if (wasPending) event.preventDefault(); return }
  event.preventDefault()
  if ('pendingGo' in resolved) {
    pendingGo = true
    pendingGoTimer = window.setTimeout(() => { pendingGo = false }, 1_500)
    return
  }
  const command = resolved.command
  const hasThread = Boolean(selectedConversationId) || selection.ids.length > 1
  if (typeof command === 'object') { switchMailbox(command.goto); return }
  switch (command) {
    case 'reply': if (selected) void openDraft(false).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))); return
    case 'replyAll': if (selected) void openDraft(true).catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))); return
    case 'forward': if (selected) void openForward().catch((error) => addAgentMessage('error', error instanceof Error ? error.message : String(error))); return
    case 'archive': if (hasThread && !elements.archive.hidden) void mutateSelected('archive'); return
    case 'spam': if (hasThread && !elements.spam.hidden) void mutateSelected('spam'); return
    case 'trash': if (hasThread && !elements.trash.hidden) void mutateSelected('trash'); return
    case 'toggleRead': if (selected && !elements.readState.hidden) void toggleReadState(); return
    case 'next': moveSelection(1, false); return
    case 'previous': moveSelection(-1, false); return
    case 'compose': openCompose(); return
    case 'ask': if (selected) askCodex(); return
    case 'help': shortcutsDialog.showModal(); return
  }
})
installDropTargets()
app.querySelector('[data-undo]')!.addEventListener('click', () => { void undoLastMove() })
app.querySelector('[data-undo-dismiss]')!.addEventListener('click', hideUndoToast)
undoToast.root.addEventListener('mouseenter', pauseUndoCountdown)
undoToast.root.addEventListener('mouseleave', () => { if (!undoToast.root.hidden && undoTimer === undefined) startUndoCountdown(undoRemaining || UNDO_WINDOW_MS) })
window.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return
  if (undoToast.root.hidden || isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return
  event.preventDefault()
  void undoLastMove()
})

renderMailbox()
renderPanels()
void start()
