use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize)]
pub struct StartResult {
    pub success: bool,
    pub message: String,
    pub port: Option<u16>,
    pub source: String, // "sidecar" | "external" | "none"
}

/// Holds the sidecar child process and the port it was started on.
pub struct SidecarState {
    pub child: Mutex<Option<CommandChild>>,
    pub port: AtomicU16,
}

impl SidecarState {
    pub fn new() -> Self {
        SidecarState {
            child: Mutex::new(None),
            port: AtomicU16::new(0),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }
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

    let (_rx, child) = match sidecar_cmd
        .env("PORT", &port_str)
        .spawn()
    {
        Ok(pair) => pair,
        Err(_) => return start_external_server(port),
    };

    // Store the child handle for lifecycle management
    if let Some(state) = app.try_state::<SidecarState>() {
        state.port.store(port, Ordering::Relaxed);
        if let Ok(mut guard) = state.child.lock() {
            *guard = Some(child);
        }
    }

    StartResult {
        success: true,
        message: format!("Sidecar server starting on port {}...", port),
        port: Some(port),
        source: "sidecar".to_string(),
    }
}

/// Kill the running sidecar process (called on app exit).
pub fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
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
