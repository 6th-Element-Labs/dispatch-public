//! Stable-channel update coordinator. The Tauri updater plugin owns download
//! and signature verification. Dispatch asks twice and drains services first.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdatePhase {
    Check,
    Download,
    Install,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateOutcome {
    NeverChecked,
    UpToDate,
    Available { version: String, notes: String },
    Installed { version: String },
    Failed { phase: UpdatePhase, message: String },
}

impl Default for UpdateOutcome {
    fn default() -> Self {
        Self::NeverChecked
    }
}

#[derive(Default)]
pub struct UpdateCoordinator {
    outcome: Mutex<UpdateOutcome>,
    checking: AtomicBool,
}

impl UpdateCoordinator {
    pub fn begin_check(&self) -> bool {
        self.checking
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn finish(&self, outcome: UpdateOutcome) {
        *self.outcome.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = outcome;
        self.checking.store(false, Ordering::SeqCst);
    }

    pub fn last_outcome(&self) -> UpdateOutcome {
        self.outcome
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

pub fn available_prompt(version: &str, notes: Option<&str>) -> String {
    let notes = displayed_notes(notes);
    if notes.is_empty() {
        format!("Dispatch {version} is available.")
    } else {
        format!("Dispatch {version} is available.\n\n{notes}")
    }
}

pub fn failure_message(phase: UpdatePhase, error: &str) -> String {
    match phase {
        UpdatePhase::Check => format!("Dispatch could not check for updates: {error}"),
        UpdatePhase::Download => {
            format!("Dispatch could not download and verify the update: {error}")
        }
        UpdatePhase::Install => format!("Dispatch could not install the update: {error}"),
    }
}

pub fn should_check_on_launch(is_dev: bool) -> bool {
    !is_dev
}

fn displayed_notes(notes: Option<&str>) -> String {
    notes.unwrap_or("").trim().chars().take(2000).collect()
}

pub fn spawn_post_launch_check<R: Runtime>(app: AppHandle<R>) {
    if !should_check_on_launch(tauri::is_dev()) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        run_check(app, false).await;
    });
}

pub fn check_from_menu<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        run_check(app, true).await;
    });
}

async fn run_check<R: Runtime>(app: AppHandle<R>, from_menu: bool) {
    let Some(state) = app.try_state::<UpdateCoordinator>() else {
        return;
    };
    if !state.begin_check() {
        if from_menu {
            match state.last_outcome() {
                UpdateOutcome::Failed { phase, message } => {
                    show_message(&app, &failure_message(phase, &message), true).await;
                }
                _ => show_message(&app, "Dispatch is already checking for updates.", true).await,
            }
        }
        return;
    }

    let outcome = match check_and_maybe_install(&app, from_menu).await {
        Ok(outcome) => outcome,
        Err((phase, message)) => {
            let text = failure_message(phase.clone(), &message);
            if from_menu {
                show_message(&app, &text, true).await;
            } else {
                eprintln!("dispatch: {text}");
            }
            UpdateOutcome::Failed { phase, message }
        }
    };
    state.finish(outcome);
}

async fn check_and_maybe_install<R: Runtime>(
    app: &AppHandle<R>,
    from_menu: bool,
) -> Result<UpdateOutcome, (UpdatePhase, String)> {
    let updater = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| (UpdatePhase::Check, error.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|error| (UpdatePhase::Check, error.to_string()))?;

    let Some(update) = update else {
        if from_menu {
            show_message(app, "Dispatch is up to date.", false).await;
        }
        return Ok(UpdateOutcome::UpToDate);
    };

    let notes = update.body.clone().unwrap_or_default();
    let version = update.version.clone();
    let prompt = available_prompt(&version, Some(notes.as_str()));
    if !ask(app, &prompt, "Download", "Not Now").await {
        return Ok(UpdateOutcome::Available { version, notes });
    }

    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| (UpdatePhase::Download, error.to_string()))?;

    if !ask(
        app,
        &format!("Dispatch {version} is ready to install. Dispatch will restart."),
        "Install and Restart",
        "Later",
    )
    .await
    {
        return Ok(UpdateOutcome::Available { version, notes });
    }

    crate::background::prepare_for_app_update().map_err(|error| (UpdatePhase::Install, error))?;
    if let Err(error) = update.install(bytes) {
        crate::background::resume_after_failed_app_update();
        return Err((UpdatePhase::Install, error.to_string()));
    }
    app.restart();
    #[allow(unreachable_code)]
    Ok(UpdateOutcome::Installed { version })
}

async fn ask<R: Runtime>(app: &AppHandle<R>, message: &str, ok: &str, cancel: &str) -> bool {
    let app = app.clone();
    let message = message.to_string();
    let ok = ok.to_string();
    let cancel = cancel.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Dispatch")
            .buttons(MessageDialogButtons::OkCancelCustom(ok, cancel))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

async fn show_message<R: Runtime>(app: &AppHandle<R>, message: &str, error: bool) {
    let app = app.clone();
    let message = message.to_string();
    let kind = if error {
        MessageDialogKind::Error
    } else {
        MessageDialogKind::Info
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Dispatch")
            .kind(kind)
            .blocking_show();
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_prompt_has_version_and_notes() {
        assert_eq!(
            available_prompt("0.1.1", Some("Fix Gmail sync.")),
            "Dispatch 0.1.1 is available.\n\nFix Gmail sync."
        );
    }

    #[test]
    fn failures_name_the_failed_phase() {
        assert_eq!(
            failure_message(UpdatePhase::Download, "signature rejected"),
            "Dispatch could not download and verify the update: signature rejected"
        );
    }

    #[test]
    fn development_builds_do_not_poll_production_updates() {
        assert!(!should_check_on_launch(true));
        assert!(should_check_on_launch(false));
    }

    #[test]
    fn coordinator_rejects_a_second_check() {
        let state = UpdateCoordinator::default();
        assert!(state.begin_check());
        assert!(!state.begin_check());
        state.finish(UpdateOutcome::UpToDate);
        assert!(state.begin_check());
    }

    #[test]
    fn available_prompt_does_not_grant_download() {
        let prompt = available_prompt("0.1.1", Some("Fix Gmail sync."));
        assert!(!prompt.contains("Download"));
        assert_eq!(
            failure_message(UpdatePhase::Install, "replace failed"),
            "Dispatch could not install the update: replace failed"
        );
    }
}
