use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const CHECK_INTERVAL: Duration = Duration::from_secs(3600); // 1 hour

/// Shared state tracking last update check time.
pub struct UpdateCheckState {
    last_check: Mutex<Option<Instant>>,
}

impl UpdateCheckState {
    pub fn new() -> Self {
        Self {
            last_check: Mutex::new(None),
        }
    }

    /// Returns true if enough time has passed since the last check.
    fn should_check(&self) -> bool {
        let guard = self.last_check.lock().unwrap();
        match *guard {
            Some(last) => last.elapsed() >= CHECK_INTERVAL,
            None => true,
        }
    }

    fn mark_checked(&self) {
        let mut guard = self.last_check.lock().unwrap();
        *guard = Some(Instant::now());
    }
}

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
    pub error: Option<String>,
}

/// Check for updates in the background. Emits "update-status" event to frontend.
/// Respects rate limit unless `force` is true (for manual checks).
pub async fn check_for_update(app: tauri::AppHandle, force: bool) {
    let state = app.state::<UpdateCheckState>();

    if !force && !state.should_check() {
        return;
    }

    state.mark_checked();

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit("update-status", UpdateStatus {
                available: false,
                version: None,
                body: None,
                error: Some(format!("Updater init failed: {}", e)),
            });
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let _ = app.emit("update-status", UpdateStatus {
                available: true,
                version: Some(update.version.clone()),
                body: update.body.clone(),
                error: None,
            });
        }
        Ok(None) => {
            let _ = app.emit("update-status", UpdateStatus {
                available: false,
                version: None,
                body: None,
                error: None,
            });
        }
        Err(e) => {
            let _ = app.emit("update-status", UpdateStatus {
                available: false,
                version: None,
                body: None,
                error: Some(format!("{}", e)),
            });
        }
    }
}

/// Download and install the available update. Emits progress events.
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("Updater init failed: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Check failed: {}", e))?
        .ok_or_else(|| "No update available".to_string())?;

    // A2A-100: Download with progress events
    let app_clone = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_clone.emit("update-download-progress", serde_json::json!({
                    "chunkLength": chunk_length,
                    "contentLength": content_length
                }));
            },
            || {
                // Download finished — restart will happen after this returns
            },
        )
        .await
        .map_err(|e| format!("Install failed: {}", e))?;

    Ok(())
}
