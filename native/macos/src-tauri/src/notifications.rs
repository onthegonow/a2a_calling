use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

static SEEN_CALLS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Debug, serde::Deserialize)]
struct CallsResponse {
    success: bool,
    calls: Option<Vec<Conversation>>,
}

#[derive(Debug, serde::Deserialize)]
struct Conversation {
    id: String,
    contact_name: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    started_at: Option<String>,
}

/// Poll for new inbound calls and fire native notifications
pub fn start_notification_poller(app: tauri::AppHandle) {
    // Initialize seen set
    {
        let mut seen = SEEN_CALLS.lock().unwrap();
        *seen = Some(HashSet::new());
    }

    tokio::spawn(async move {
        // Wait for initial server discovery
        tokio::time::sleep(Duration::from_secs(10)).await;

        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;

            let port = crate::health::current_port();
            if port == 0 || !crate::health::is_connected() {
                continue;
            }

            let url = format!(
                "http://127.0.0.1:{}/api/a2a/dashboard/calls?status=active",
                port
            );

            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build();

            let client = match client {
                Ok(c) => c,
                Err(_) => continue,
            };

            let resp = match client.get(&url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };

            let data: CallsResponse = match resp.json().await {
                Ok(d) => d,
                Err(_) => continue,
            };

            if !data.success {
                continue;
            }

            let conversations = data.calls.unwrap_or_default();
            let mut seen = SEEN_CALLS.lock().unwrap();
            let seen_set = seen.as_mut().unwrap();

            for conv in &conversations {
                if seen_set.contains(&conv.id) {
                    continue;
                }
                seen_set.insert(conv.id.clone());

                let caller = conv.contact_name.as_deref().unwrap_or("Unknown agent");
                let summary = conv.summary.as_deref().unwrap_or("New inbound call");

                let _ = app.notification()
                    .builder()
                    .title(&format!("Inbound call from {}", caller))
                    .body(summary)
                    .show();
            }

            // Prevent unbounded memory growth — cap at 1000 entries
            if seen_set.len() > 1000 {
                seen_set.clear();
                for conv in &conversations {
                    seen_set.insert(conv.id.clone());
                }
            }
        }
    });
}
