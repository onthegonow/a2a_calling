use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_CRASH_COUNT: u32 = 5;
const STABLE_THRESHOLD: Duration = Duration::from_secs(60);
const MAX_BACKOFF_MS: u64 = 30_000;

#[derive(Debug, Serialize)]
pub struct StartResult {
    pub success: bool,
    pub message: String,
    pub port: Option<u16>,
    pub source: String, // "sidecar" | "external" | "none"
}

/// Holds the sidecar child process, port, and crash recovery state.
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub port: AtomicU16,
    pub crash_count: AtomicU32,
    pub shutting_down: AtomicBool,
    last_start: Mutex<Option<Instant>>,
}

impl SidecarState {
    pub fn new() -> Self {
        SidecarState {
            child: Mutex::new(None),
            port: AtomicU16::new(0),
            crash_count: AtomicU32::new(0),
            shutting_down: AtomicBool::new(false),
            last_start: Mutex::new(None),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }
}

/// Calculate exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 30s).
fn backoff_ms(crash_count: u32) -> u64 {
    let exponent = crash_count.saturating_sub(1).min(4);
    let ms = 1000u64 << exponent;
    ms.min(MAX_BACKOFF_MS)
}

/// Pick a port for the sidecar: prefer config, then OS-assigned.
fn pick_port() -> u16 {
    let config_ports = crate::discovery::read_config_ports();
    if let Some(&port) = config_ports.first() {
        return port;
    }
    // Let the OS pick an available port
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(3001)
}

/// Start the A2A server via Tauri sidecar (bundled binary).
pub fn start_sidecar(app: &tauri::AppHandle) -> StartResult {
    let port = pick_port();
    let port_str = port.to_string();

    let sidecar_cmd = match app.shell().sidecar("a2a-server") {
        Ok(cmd) => cmd,
        Err(_) => return start_external_server(port),
    };

    let (rx, child) = match sidecar_cmd
        .env("PORT", &port_str)
        .spawn()
    {
        Ok(pair) => pair,
        Err(_) => return start_external_server(port),
    };

    // Store the child handle and record start time
    if let Some(state) = app.try_state::<SidecarState>() {
        state.port.store(port, Ordering::Relaxed);
        if let Ok(mut guard) = state.child.lock() {
            *guard = Some(child);
        }
        if let Ok(mut guard) = state.last_start.lock() {
            *guard = Some(Instant::now());
        }
    }

    // Monitor sidecar stdout/stderr and detect exit for crash recovery
    spawn_sidecar_monitor(app.clone(), rx);

    StartResult {
        success: true,
        message: format!("Sidecar server starting on port {}...", port),
        port: Some(port),
        source: "sidecar".to_string(),
    }
}

/// Monitor sidecar output and process exit for crash recovery.
fn spawn_sidecar_monitor(
    app: tauri::AppHandle,
    mut rx: tokio::sync::mpsc::Receiver<CommandEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let _ = app.emit(
                        "sidecar-log",
                        serde_json::json!({
                            "stream": "stdout",
                            "line": text.trim_end()
                        }),
                    );
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let _ = app.emit(
                        "sidecar-log",
                        serde_json::json!({
                            "stream": "stderr",
                            "line": text.trim_end()
                        }),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    handle_sidecar_exit(&app, payload.code);
                    break;
                }
                CommandEvent::Error(msg) => {
                    let _ = app.emit(
                        "sidecar-log",
                        serde_json::json!({
                            "stream": "stderr",
                            "line": format!("[sidecar error] {}", msg)
                        }),
                    );
                }
                _ => {}
            }
        }
    });
}

/// Handle unexpected sidecar exit with auto-restart and exponential backoff.
fn handle_sidecar_exit(app: &tauri::AppHandle, exit_code: Option<i32>) {
    let state = match app.try_state::<SidecarState>() {
        Some(s) => s,
        None => return,
    };

    // Don't restart during intentional shutdown
    if state.shutting_down.load(Ordering::Relaxed) {
        return;
    }

    // Clear the dead child from state
    if let Ok(mut guard) = state.child.lock() {
        guard.take();
    }

    // Reset crash counter if server ran long enough (60s of stable operation)
    if let Ok(guard) = state.last_start.lock() {
        if let Some(start_time) = *guard {
            if start_time.elapsed() >= STABLE_THRESHOLD {
                state.crash_count.store(0, Ordering::Relaxed);
            }
        }
    }

    let crashes = state.crash_count.fetch_add(1, Ordering::Relaxed) + 1;

    crate::health::set_disconnected();

    let _ = app.emit(
        "server-status",
        serde_json::json!({
            "connected": false,
            "crashed": true,
            "crashCount": crashes,
            "exitCode": exit_code
        }),
    );

    // Stop restarting after too many consecutive crashes
    if crashes >= MAX_CRASH_COUNT {
        let _ = app.emit(
            "server-status",
            serde_json::json!({
                "connected": false,
                "crashed": true,
                "crashCount": crashes,
                "fatal": true,
                "message": "Server crashed too many times. Use View > Restart Server to try again."
            }),
        );
        return;
    }

    // Schedule restart with exponential backoff
    let delay = backoff_ms(crashes);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay)).await;

        if let Some(st) = app_clone.try_state::<SidecarState>() {
            if st.shutting_down.load(Ordering::Relaxed) {
                return;
            }
        }

        let result = start_sidecar(&app_clone);
        if result.success {
            if let Some(port) = result.port {
                crate::health::set_connected(port);
            }
        }
    });
}

/// Restart the sidecar — kills existing process, resets crash counter, starts fresh.
pub fn restart_sidecar(app: &tauri::AppHandle) -> StartResult {
    kill_sidecar(app);

    if let Some(state) = app.try_state::<SidecarState>() {
        state.crash_count.store(0, Ordering::Relaxed);
        state.shutting_down.store(false, Ordering::Relaxed);
    }

    start_sidecar(app)
}

/// Kill the running sidecar process (called on app exit or restart).
pub fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        state.shutting_down.store(true, Ordering::Relaxed);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

// ── External CLI fallback ──

/// Find the `a2a` CLI binary on PATH
fn find_a2a_binary() -> Option<String> {
    let result = Command::new("which").arg("a2a").output();
    if let Ok(output) = result {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
}

/// Start the A2A server via external CLI (fallback when sidecar unavailable).
fn start_external_server(port: u16) -> StartResult {
    let binary = match find_a2a_binary() {
        Some(b) => b,
        None => {
            return StartResult {
                success: false,
                message: "Could not find bundled sidecar or 'a2a' CLI. Is a2acalling installed? Run: npm install -g a2acalling".to_string(),
                port: None,
                source: "none".to_string(),
            };
        }
    };

    let port_str = port.to_string();
    let result = Command::new(&binary)
        .args(["server", "--port", &port_str])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn();

    match result {
        Ok(_child) => StartResult {
            success: true,
            message: format!("External server starting on port {}...", port),
            port: Some(port),
            source: "external".to_string(),
        },
        Err(err) => StartResult {
            success: false,
            message: format!("Failed to start server: {}", err),
            port: None,
            source: "none".to_string(),
        },
    }
}
