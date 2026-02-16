# A2A Callbook — Native macOS App (v1) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a native macOS Tauri app that wraps the existing A2A dashboard SPA, adding native notifications, deep links, menu bar status, and proper macOS app lifecycle.

**Architecture:** Tauri v2 shell with system WebKit WebView loading the existing SPA from the running Express server (`http://localhost:{port}/api/a2a/dashboard/`). The Rust backend handles port discovery, server lifecycle spawning, macOS notifications (via polling), and `a2a://` URL scheme registration. No server code changes — the app is a client of the existing HTTP API.

**Tech Stack:** Tauri v2, Rust, existing vanilla JS/HTML/CSS SPA, macOS WebKit, cargo for Rust build

**Linear ticket:** A2A-20

---

## Phase 1: Scaffold Tauri Project

### Task 1: Initialize Tauri v2 project structure

**Files:**
- Create: `native/macos/Cargo.toml`
- Create: `native/macos/src-tauri/Cargo.toml`
- Create: `native/macos/src-tauri/src/main.rs`
- Create: `native/macos/src-tauri/src/lib.rs`
- Create: `native/macos/src-tauri/tauri.conf.json`
- Create: `native/macos/src-tauri/capabilities/default.json`
- Create: `native/macos/src-tauri/icons/` (placeholder)
- Create: `native/macos/package.json` (for Tauri CLI)
- Create: `native/macos/index.html` (minimal loader page)

**Step 1: Create directory structure**

```bash
mkdir -p native/macos/src-tauri/src
mkdir -p native/macos/src-tauri/icons
mkdir -p native/macos/src-tauri/capabilities
```

**Step 2: Create `native/macos/package.json`**

This is just for the Tauri CLI tooling — not a Node app.

```json
{
  "name": "a2a-callbook-macos",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "tauri": "cargo tauri"
  }
}
```

**Step 3: Create `native/macos/index.html`**

This is the loading/fallback page shown before the server is detected. Once the server is found, the WebView navigates to the live SPA URL.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>A2A Callbook</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'IBM Plex Sans', sans-serif;
      background: linear-gradient(180deg, #eef3f8 0%, #f8f9fb 100%);
      color: #1a1a2e;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .status-card {
      background: #fff;
      border: 1px solid #d0d7de;
      border-radius: 12px;
      padding: 48px;
      text-align: center;
      max-width: 420px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    .status-indicator {
      display: inline-block;
      width: 10px; height: 10px;
      border-radius: 50%;
      margin-right: 8px;
      vertical-align: middle;
    }
    .status-indicator.searching { background: #f59e0b; animation: pulse 1.5s infinite; }
    .status-indicator.disconnected { background: #ef4444; }
    .status-indicator.connected { background: #22c55e; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .status-text { font-size: 14px; margin-bottom: 24px; color: #444; }
    .port-info { font-size: 12px; color: #888; margin-bottom: 16px; font-family: monospace; }
    button {
      background: #1466c1; color: #fff; border: none; border-radius: 8px;
      padding: 10px 24px; font-size: 14px; cursor: pointer; margin: 4px;
      font-family: inherit;
    }
    button:hover { background: #1052a0; }
    button.secondary {
      background: transparent; color: #1466c1; border: 1px solid #1466c1;
    }
    button.secondary:hover { background: #eef3f8; }
    #error-detail { color: #ef4444; font-size: 12px; margin-top: 12px; display: none; }
  </style>
</head>
<body>
  <div class="status-card">
    <h1>A2A Callbook</h1>
    <p class="subtitle">Agent-to-agent communication dashboard</p>

    <div id="status-searching">
      <p class="status-text">
        <span class="status-indicator searching"></span>
        Looking for a2a server...
      </p>
      <p class="port-info" id="port-info">Scanning ports: 3001, 80, 8080, 8443, 9001</p>
    </div>

    <div id="status-not-found" style="display:none;">
      <p class="status-text">
        <span class="status-indicator disconnected"></span>
        Server not running
      </p>
      <p class="port-info" id="last-port">No a2a server found on common ports</p>
      <button id="btn-start">Start Server</button>
      <button id="btn-retry" class="secondary">Retry</button>
      <p id="error-detail"></p>
    </div>

    <div id="status-connected" style="display:none;">
      <p class="status-text">
        <span class="status-indicator connected"></span>
        Connected to server
      </p>
      <p class="port-info" id="connected-port"></p>
    </div>
  </div>

  <script>
    const { invoke } = window.__TAURI__.core;

    async function checkServer() {
      show('status-searching');
      try {
        const result = await invoke('discover_server');
        if (result.port) {
          show('status-connected');
          document.getElementById('connected-port').textContent =
            `localhost:${result.port}`;
          // Navigate to live SPA
          setTimeout(() => {
            window.location.href =
              `http://127.0.0.1:${result.port}/api/a2a/dashboard/` +
              (window.__TAB_HASH || '');
          }, 400);
        } else {
          show('status-not-found');
        }
      } catch (err) {
        show('status-not-found');
        const detail = document.getElementById('error-detail');
        detail.textContent = err;
        detail.style.display = 'block';
      }
    }

    function show(id) {
      ['status-searching', 'status-not-found', 'status-connected']
        .forEach(s => document.getElementById(s).style.display = 'none');
      document.getElementById(id).style.display = 'block';
    }

    document.getElementById('btn-start')?.addEventListener('click', async () => {
      try {
        await invoke('start_server');
        // Wait for server to boot, then retry
        setTimeout(checkServer, 2000);
      } catch (err) {
        const detail = document.getElementById('error-detail');
        detail.textContent = `Failed to start: ${err}`;
        detail.style.display = 'block';
      }
    });

    document.getElementById('btn-retry')?.addEventListener('click', checkServer);

    // Start discovery on load
    checkServer();
  </script>
</body>
</html>
```

**Step 4: Create `native/macos/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "A2A Callbook",
  "version": "0.1.0",
  "identifier": "com.openclaw.a2a-callbook",
  "build": {
    "frontendDist": "../index.html"
  },
  "app": {
    "windows": [
      {
        "title": "A2A Callbook",
        "width": 1024,
        "height": 720,
        "minWidth": 480,
        "minHeight": 600,
        "resizable": true,
        "titleBarStyle": "Visible",
        "hiddenTitle": false
      }
    ],
    "security": {
      "dangerousRemoteUrlAccess": [
        { "url": "http://127.0.0.1:**" },
        { "url": "http://localhost:**" }
      ]
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "app"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ],
    "macOS": {
      "minimumSystemVersion": "12.0",
      "frameworks": []
    }
  }
}
```

**Step 5: Create `native/macos/src-tauri/Cargo.toml`**

```toml
[package]
name = "a2a-callbook"
version = "0.1.0"
edition = "2021"

[lib]
name = "a2a_callbook_lib"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-notification = "2"
tauri-plugin-deep-link = "2"
tauri-plugin-window-state = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"], default-features = false, features = ["rustls-tls"] }
tokio = { version = "1", features = ["full"] }
dirs = "6"
```

**Step 6: Create `native/macos/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/schema.json",
  "identifier": "default",
  "description": "Default capabilities for A2A Callbook",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open",
    "shell:allow-execute",
    "notification:default",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify",
    "deep-link:default",
    "window-state:default"
  ]
}
```

**Step 7: Create `native/macos/src-tauri/src/main.rs`**

```rust
// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    a2a_callbook_lib::run()
}
```

**Step 8: Create `native/macos/src-tauri/src/lib.rs`**

Minimal skeleton — just opens the window with the loader page.

```rust
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running A2A Callbook");
}
```

**Step 9: Create `native/macos/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

**Step 10: Verify the project compiles**

```bash
cd native/macos/src-tauri && cargo check
```

Expected: Successful compilation check (no errors).

**Step 11: Commit**

```bash
git add native/macos/
git commit -m "feat(macos): scaffold Tauri v2 project structure"
```

---

## Phase 2: Port Discovery & Server Detection

### Task 2: Implement port discovery in Rust

The app must find the running a2a server. Strategy:
1. Read `~/.config/openclaw/a2a-config.json` for `onboarding.server_port`
2. Fall back to probing default ports: `[3001, 80, 8080, 8443, 9001]`
3. Probe via `GET http://127.0.0.1:{port}/api/a2a/ping` (200 = found)

**Files:**
- Create: `native/macos/src-tauri/src/discovery.rs`
- Modify: `native/macos/src-tauri/src/lib.rs`

**Step 1: Write `discovery.rs` with port scanning logic**

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PORTS: &[u16] = &[3001, 80, 8080, 8443, 9001];
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub port: Option<u16>,
    pub source: String, // "config" | "scan" | "none"
}

#[derive(Debug, Deserialize)]
struct A2AConfig {
    onboarding: Option<OnboardingConfig>,
}

#[derive(Debug, Deserialize)]
struct OnboardingConfig {
    server_port: Option<u16>,
}

/// Read port from ~/.config/openclaw/a2a-config.json
fn read_config_port() -> Option<u16> {
    let config_dir = std::env::var("A2A_CONFIG_DIR")
        .or_else(|_| std::env::var("OPENCLAW_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join(".config")
                .join("openclaw")
        });

    let config_path = config_dir.join("a2a-config.json");
    let content = std::fs::read_to_string(config_path).ok()?;
    let config: A2AConfig = serde_json::from_str(&content).ok()?;
    config.onboarding?.server_port
}

/// Probe a single port — returns true if a2a server responds
async fn probe_port(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/a2a/ping", port);
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Discover the running a2a server
pub async fn discover_server() -> DiscoveryResult {
    // 1. Try config port first
    if let Some(port) = read_config_port() {
        if probe_port(port).await {
            return DiscoveryResult {
                port: Some(port),
                source: "config".to_string(),
            };
        }
    }

    // 2. Scan default ports
    for &port in DEFAULT_PORTS {
        if probe_port(port).await {
            return DiscoveryResult {
                port: Some(port),
                source: "scan".to_string(),
            };
        }
    }

    DiscoveryResult {
        port: None,
        source: "none".to_string(),
    }
}
```

**Step 2: Register the Tauri command in `lib.rs`**

```rust
use tauri::Manager;

mod discovery;

#[tauri::command]
async fn discover_server() -> Result<discovery::DiscoveryResult, String> {
    Ok(discovery::discover_server().await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![discover_server])
        .run(tauri::generate_context!())
        .expect("error while running A2A Callbook");
}
```

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

Expected: Compiles successfully.

**Step 4: Commit**

```bash
git add native/macos/src-tauri/src/discovery.rs native/macos/src-tauri/src/lib.rs
git commit -m "feat(macos): add port discovery — config read + port scanning"
```

---

## Phase 3: Server Lifecycle Management

### Task 3: Implement server start/stop commands

When the server isn't running, the app offers a "Start Server" button that spawns `a2a server --port 3001` as a detached child process.

**Files:**
- Create: `native/macos/src-tauri/src/server.rs`
- Modify: `native/macos/src-tauri/src/lib.rs`

**Step 1: Write `server.rs`**

```rust
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct StartResult {
    pub success: bool,
    pub message: String,
}

/// Find the `a2a` CLI binary
fn find_a2a_binary() -> Option<String> {
    // Check common locations
    let candidates = [
        "a2a",  // In PATH
    ];

    for candidate in &candidates {
        let result = Command::new("which")
            .arg(candidate)
            .output();

        if let Ok(output) = result {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }

    None
}

/// Start the a2a server as a detached process
pub fn start_server() -> StartResult {
    let binary = match find_a2a_binary() {
        Some(b) => b,
        None => {
            return StartResult {
                success: false,
                message: "Could not find 'a2a' CLI. Is a2acalling installed? Run: npm install -g a2acalling".to_string(),
            };
        }
    };

    let result = Command::new(&binary)
        .args(["server", "--port", "3001"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn();

    match result {
        Ok(_child) => StartResult {
            success: true,
            message: "Server starting on port 3001...".to_string(),
        },
        Err(err) => StartResult {
            success: false,
            message: format!("Failed to start server: {}", err),
        },
    }
}
```

**Step 2: Register `start_server` command in `lib.rs`**

Add to `lib.rs`:

```rust
mod server;

#[tauri::command]
fn start_server() -> Result<server::StartResult, String> {
    Ok(server::start_server())
}
```

Add `start_server` to the invoke handler:

```rust
.invoke_handler(tauri::generate_handler![discover_server, start_server])
```

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add native/macos/src-tauri/src/server.rs native/macos/src-tauri/src/lib.rs
git commit -m "feat(macos): add server lifecycle — start a2a server from app"
```

---

## Phase 4: macOS App Lifecycle & Window Behavior

### Task 4: Implement Cmd+W hide, keyboard shortcuts, window state

**Files:**
- Modify: `native/macos/src-tauri/src/lib.rs`
- Modify: `native/macos/src-tauri/tauri.conf.json`

**Step 1: Add macOS-specific window behavior to `lib.rs`**

Cmd+W should hide the window (not quit). Cmd+Q quits. Cmd+1–5 switch tabs. Cmd+R refreshes. Cmd+, opens Settings.

```rust
use tauri::{Manager, RunEvent, WindowEvent};
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem, AboutMetadata};

mod discovery;
mod server;

#[tauri::command]
async fn discover_server() -> Result<discovery::DiscoveryResult, String> {
    Ok(discovery::discover_server().await)
}

#[tauri::command]
fn start_server() -> Result<server::StartResult, String> {
    Ok(server::start_server())
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About A2A Callbook"), Some(AboutMetadata {
        name: Some("A2A Callbook".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    }))?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit A2A Callbook"))?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide A2A Callbook"))?;
    let separator = PredefinedMenuItem::separator(app)?;

    let app_menu = Submenu::with_items(app, "A2A Callbook", true, &[
        &about, &separator, &hide, &separator, &quit,
    ])?;

    // View menu with tab shortcuts
    let contacts = MenuItem::with_id(app, "tab-contacts", "Contacts", true, Some("CmdOrCtrl+1"))?;
    let calls = MenuItem::with_id(app, "tab-calls", "Calls", true, Some("CmdOrCtrl+2"))?;
    let logs = MenuItem::with_id(app, "tab-logs", "Logs", true, Some("CmdOrCtrl+3"))?;
    let settings = MenuItem::with_id(app, "tab-settings", "Settings", true, Some("CmdOrCtrl+4"))?;
    let invites = MenuItem::with_id(app, "tab-invites", "Invites", true, Some("CmdOrCtrl+5"))?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;

    let view_menu = Submenu::with_items(app, "View", true, &[
        &contacts, &calls, &logs, &settings, &invites, &sep2, &refresh,
    ])?;

    // Edit menu (standard macOS)
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = Submenu::with_items(app, "Edit", true, &[
        &cut, &copy, &paste, &select_all,
    ])?;

    let window_menu = Submenu::with_items(app, "Window", true, &[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::close_window(app, Some("Hide Window"))?,
    ])?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![discover_server, start_server])
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // Handle menu events
            let app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();
                let tab = match id {
                    "tab-contacts" => Some("contacts"),
                    "tab-calls" => Some("calls"),
                    "tab-logs" => Some("logs"),
                    "tab-settings" => Some("settings"),
                    "tab-invites" => Some("invites"),
                    "refresh" => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.eval("window.location.reload()");
                        }
                        None
                    }
                    _ => None,
                };

                if let Some(tab_name) = tab {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let js = format!("window.location.hash = '{}'", tab_name);
                        let _ = window.eval(&js);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building A2A Callbook");

    // Cmd+W hides window instead of quitting
    app.run(|app_handle, event| {
        if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = &event {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window(label) {
                let _ = window.hide();
            }
        }
    });
}
```

**Step 2: Update `tauri.conf.json` to enable Cmd+, shortcut for Settings**

Add to the window config:

```json
{
  "app": {
    "windows": [
      {
        "title": "A2A Callbook",
        "width": 1024,
        "height": 720,
        "minWidth": 480,
        "minHeight": 600,
        "resizable": true
      }
    ]
  }
}
```

(The Cmd+, mapping is handled by menu item "tab-settings" with shortcut "CmdOrCtrl+," — add this to the app menu in the Rust code above as a "Preferences" item.)

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add native/macos/src-tauri/
git commit -m "feat(macos): add app lifecycle — Cmd+W hide, tab shortcuts, native menus"
```

---

## Phase 5: Reconnection Overlay

### Task 5: Add server disconnection detection and auto-reconnect

When the server stops mid-session, the SPA will get fetch errors. We need a reconnection overlay and health-check polling.

**Files:**
- Create: `native/macos/src-tauri/src/health.rs`
- Modify: `native/macos/src-tauri/src/lib.rs`
- Modify: `native/macos/index.html` (add reconnection overlay JS)

**Step 1: Write `health.rs` — periodic health check**

```rust
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

static CONNECTED: AtomicBool = AtomicBool::new(false);
static CURRENT_PORT: AtomicU16 = AtomicU16::new(0);

pub fn is_connected() -> bool {
    CONNECTED.load(Ordering::Relaxed)
}

pub fn current_port() -> u16 {
    CURRENT_PORT.load(Ordering::Relaxed)
}

pub fn set_connected(port: u16) {
    CURRENT_PORT.store(port, Ordering::Relaxed);
    CONNECTED.store(true, Ordering::Relaxed);
}

/// Start background health check loop — emits "server-status" events
pub fn start_health_monitor(app: tauri::AppHandle) {
    let handle = Arc::new(app);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            let port = CURRENT_PORT.load(Ordering::Relaxed);
            if port == 0 {
                continue;
            }

            let url = format!("http://127.0.0.1:{}/api/a2a/ping", port);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(1500))
                .build()
                .unwrap();

            let ok = match client.get(&url).send().await {
                Ok(resp) => resp.status().is_success(),
                Err(_) => false,
            };

            let was_connected = CONNECTED.swap(ok, Ordering::Relaxed);

            // Only emit on state change
            if ok != was_connected {
                let _ = handle.emit("server-status", serde_json::json!({
                    "connected": ok,
                    "port": port
                }));
            }
        }
    });
}
```

**Step 2: Add reconnection overlay to `index.html`**

Append to the `<script>` block in `index.html`:

```javascript
// Listen for server disconnect/reconnect from Tauri backend
const { listen } = window.__TAURI__.event;

listen('server-status', (event) => {
  const { connected, port } = event.payload;
  if (!connected) {
    showReconnectionOverlay();
  } else {
    hideReconnectionOverlay();
  }
});

function showReconnectionOverlay() {
  if (document.getElementById('reconnect-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'reconnect-overlay';
  overlay.innerHTML = `
    <div style="position:fixed;top:0;left:0;right:0;z-index:9999;
      background:#fef3c7;border-bottom:2px solid #f59e0b;padding:12px 24px;
      text-align:center;font-family:-apple-system,sans-serif;font-size:14px;color:#92400e;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
        background:#f59e0b;margin-right:8px;animation:pulse 1.5s infinite;vertical-align:middle;"></span>
      Server disconnected — Reconnecting...
    </div>`;
  document.body.appendChild(overlay);
}

function hideReconnectionOverlay() {
  const overlay = document.getElementById('reconnect-overlay');
  if (overlay) overlay.remove();
}
```

**Step 3: Wire health monitor into `lib.rs` setup**

In the `setup` closure, after menu setup:

```rust
let handle = app.handle().clone();
tokio::spawn(async move {
    health::start_health_monitor(handle).await;
});
```

Actually — since `start_health_monitor` spawns its own tokio task, just call it directly:

```rust
health::start_health_monitor(app.handle().clone());
```

**Step 4: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 5: Commit**

```bash
git add native/macos/
git commit -m "feat(macos): add server health monitor with reconnection overlay"
```

---

## Phase 6: Native Notifications

### Task 6: Implement macOS notification bridge

Poll the calls endpoint for new inbound calls and fire macOS notifications.

**Files:**
- Create: `native/macos/src-tauri/src/notifications.rs`
- Modify: `native/macos/src-tauri/src/lib.rs`

**Step 1: Write `notifications.rs`**

```rust
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

static SEEN_CALLS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Debug, serde::Deserialize)]
struct CallsResponse {
    success: bool,
    conversations: Option<Vec<Conversation>>,
}

#[derive(Debug, serde::Deserialize)]
struct Conversation {
    id: String,
    caller_name: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    created_at: Option<String>,
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

            let conversations = data.conversations.unwrap_or_default();
            let mut seen = SEEN_CALLS.lock().unwrap();
            let seen_set = seen.as_mut().unwrap();

            for conv in &conversations {
                if seen_set.contains(&conv.id) {
                    continue;
                }
                seen_set.insert(conv.id.clone());

                let caller = conv.caller_name.as_deref().unwrap_or("Unknown agent");
                let summary = conv.summary.as_deref().unwrap_or("New inbound call");

                let _ = app.notification()
                    .builder()
                    .title(&format!("Inbound call from {}", caller))
                    .body(summary)
                    .show();
            }
        }
    });
}
```

**Step 2: Wire into `lib.rs` setup**

In the setup closure:

```rust
notifications::start_notification_poller(app.handle().clone());
```

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add native/macos/src-tauri/src/notifications.rs native/macos/src-tauri/src/lib.rs
git commit -m "feat(macos): add native notification bridge — polls for inbound calls"
```

---

## Phase 7: Deep Link Support (a2a:// URL Scheme)

### Task 7: Register `a2a://` URL scheme handler

When a user clicks an `a2a://` invite link, the app should open and handle it.

**Files:**
- Modify: `native/macos/src-tauri/src/lib.rs`
- Modify: `native/macos/src-tauri/tauri.conf.json`

**Step 1: Add deep link config to `tauri.conf.json`**

Add to the bundle → macOS section:

```json
{
  "bundle": {
    "macOS": {
      "minimumSystemVersion": "12.0"
    }
  },
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["a2a"]
      }
    }
  }
}
```

**Step 2: Handle deep link events in `lib.rs`**

In the setup closure, add deep link listener:

```rust
use tauri_plugin_deep_link::DeepLinkExt;

// In setup:
let handle = app.handle().clone();
app.deep_link().on_open_url(move |event| {
    let urls = event.urls();
    for url in urls {
        let url_str = url.to_string();
        // a2a://host/callbook/CODE or a2a://host/fed_TOKEN
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
            // Pass URL to the SPA via JS
            let js = format!(
                "window.__A2A_DEEP_LINK = '{}'; \
                 window.dispatchEvent(new CustomEvent('a2a-deep-link', {{ detail: '{}' }}))",
                url_str.replace('\'', "\\'"),
                url_str.replace('\'', "\\'")
            );
            let _ = window.eval(&js);
        }
    }
});
```

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add native/macos/src-tauri/
git commit -m "feat(macos): register a2a:// URL scheme via deep-link plugin"
```

---

## Phase 8: Menu Bar Status Item

### Task 8: Add optional menu bar tray icon showing server status

**Files:**
- Create: `native/macos/src-tauri/icons/tray-connected.png` (16x16, green dot)
- Create: `native/macos/src-tauri/icons/tray-disconnected.png` (16x16, red dot)
- Modify: `native/macos/src-tauri/src/lib.rs`

**Step 1: Create placeholder tray icons**

These will be simple 16x16 PNGs. For initial development, generate them programmatically or use placeholder files. The final icons should be designed later.

```bash
# Create placeholder icon files (will be replaced with real assets)
# For now, create empty files as placeholders
touch native/macos/src-tauri/icons/tray-connected.png
touch native/macos/src-tauri/icons/tray-disconnected.png
```

> **Note:** Real tray icons must be created by a designer or generated. For development, use any 16x16 PNG with green/red dots.

**Step 2: Add tray setup to `lib.rs`**

```rust
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu as TrayMenu, MenuItem as TrayMenuItem};

// In setup:
let show = TrayMenuItem::with_id(app, "show", "Show A2A Callbook", true, None::<&str>)?;
let quit = TrayMenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
let tray_menu = TrayMenu::with_items(app, &[&show, &quit])?;

let _tray = TrayIconBuilder::new()
    .tooltip("A2A Callbook")
    .menu(&tray_menu)
    .on_menu_event(|app, event| {
        match event.id().0.as_str() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-quit" => {
                app.exit(0);
            }
            _ => {}
        }
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    })
    .build(app)?;
```

**Step 3: Verify compilation**

```bash
cd native/macos/src-tauri && cargo check
```

**Step 4: Commit**

```bash
git add native/macos/src-tauri/
git commit -m "feat(macos): add menu bar tray icon with server status"
```

---

## Phase 9: CLI Integration

### Task 9: Update `a2a gui` to prefer native app when available

When A2A.app is installed, `a2a gui` should launch it instead of opening a browser.

**Files:**
- Modify: `bin/cli.js` (the `gui` command, around line 1460)

**Step 1: Write a failing test**

Create a test that verifies the GUI command checks for the native app.

**File:** `test/unit/cli-gui-native.test.js`

```javascript
module.exports = function (test, assert, helpers, ctx) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  test('findNativeApp returns app path when A2A.app exists', () => {
    // The function should check ~/Applications/A2A Callbook.app
    // and /Applications/A2A Callbook.app
    const { findNativeApp } = require('../../bin/cli');

    // Since the app won't be installed in test env, should return null
    const result = findNativeApp();
    assert.equal(result, null);
  });
};
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --filter cli-gui-native
```

Expected: FAIL (findNativeApp not exported)

**Step 3: Add `findNativeApp` function to `bin/cli.js`**

Add near the top of cli.js (after the existing helper functions):

```javascript
function findNativeApp() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  if (os.platform() !== 'darwin') return null;

  const candidates = [
    path.join(os.homedir(), 'Applications', 'A2A Callbook.app'),
    '/Applications/A2A Callbook.app',
  ];

  for (const appPath of candidates) {
    try {
      if (fs.existsSync(appPath)) return appPath;
    } catch (_) {}
  }

  return null;
}
```

Export it for testing (add to existing module.exports if present, or add at bottom):

```javascript
// At bottom of cli.js, if there's a test export pattern
if (typeof module !== 'undefined') {
  module.exports = { findNativeApp };
}
```

**Step 4: Update the `gui` command to prefer native app**

Modify the `gui` command (line ~1460):

```javascript
gui: async (args) => {
    const tab = (args.flags.tab || args.flags.t || '').trim().toLowerCase();
    const allowedTabs = new Set(['contacts', 'calls', 'logs', 'settings', 'invites']);
    const hash = allowedTabs.has(tab) ? `#${tab}` : '';

    const urlFlag = args.flags.url;
    if (urlFlag) {
      const url = String(urlFlag);
      console.log(`Dashboard URL: ${url}`);
      openInBrowser(url);
      return;
    }

    // Prefer native app on macOS
    if (!args.flags.browser) {
      const nativeApp = findNativeApp();
      if (nativeApp) {
        console.log('Opening A2A Callbook native app...');
        const tabArg = hash ? ['--args', `--tab=${tab}`] : [];
        const result = openInBrowser(nativeApp);
        if (result.attempted) {
          return;
        }
      }
    }

    // Fall back to browser
    const preferred = [];
    if (args.flags.port || args.flags.p) preferred.push(args.flags.port || args.flags.p);
    if (process.env.A2A_PORT) preferred.push(process.env.A2A_PORT);
    if (process.env.PORT) preferred.push(process.env.PORT);

    const port = await findLocalServerPort(preferred);
    if (!port) {
      console.log('Dashboard is not reachable on common ports.');
      console.log('Start the server (example):');
      console.log('  A2A_HOSTNAME="localhost:3001" a2a server --port 3001');
      console.log('Then open:');
      console.log('  http://127.0.0.1:3001/dashboard/');
      return;
    }

    const url = `http://127.0.0.1:${port}/dashboard/${hash}`;
    console.log(`Dashboard URL: ${url}`);
    const opened = openInBrowser(url);
    if (opened.attempted) {
      console.log(`Opening browser via: ${opened.command}`);
    } else {
      console.log('Could not auto-open browser; open the URL above manually.');
    }
  },
```

**Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass.

**Step 6: Commit**

```bash
git add bin/cli.js test/unit/cli-gui-native.test.js
git commit -m "feat: a2a gui prefers native macOS app when installed"
```

---

## Phase 10: Installation Flow

### Task 10: Add npm postinstall hook for macOS app download

On macOS, `npm install -g a2acalling` should download A2A.app from GitHub Releases and install it to `~/Applications/`.

**Files:**
- Modify: `scripts/postinstall.js`

**Step 1: Add macOS app download to postinstall**

Add to `scripts/postinstall.js` — appended after existing logic:

```javascript
async function installMacOSApp() {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  if (os.platform() !== 'darwin') return;

  const version = require('../package.json').version;
  const appDir = path.join(os.homedir(), 'Applications');
  const appPath = path.join(appDir, 'A2A Callbook.app');

  // Skip if already installed at same version
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (fs.existsSync(plistPath)) {
    try {
      const plist = fs.readFileSync(plistPath, 'utf8');
      if (plist.includes(version)) {
        return; // Same version already installed
      }
    } catch (_) {}
  }

  const tarUrl = `https://github.com/onthegonow/a2a_calling/releases/download/v${version}/A2A-Callbook-${version}.app.tar.gz`;
  const tmpFile = path.join(os.tmpdir(), `a2a-callbook-${version}.tar.gz`);

  try {
    // Download
    execSync(`curl -sL -o "${tmpFile}" "${tarUrl}"`, { timeout: 30000 });

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 1000) {
      return; // Download failed or too small — skip silently
    }

    // Ensure ~/Applications exists
    fs.mkdirSync(appDir, { recursive: true });

    // Extract
    execSync(`tar -xzf "${tmpFile}" -C "${appDir}"`, { timeout: 15000 });

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  } catch (_) {
    // Silently fail — native app is optional
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// Call at end of postinstall
installMacOSApp().catch(() => {});
```

**Step 2: Run existing tests to verify no regression**

```bash
npm test
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add scripts/postinstall.js
git commit -m "feat: postinstall downloads A2A Callbook.app on macOS"
```

---

## Phase 11: GitHub Actions CI for Tauri Builds

### Task 11: Add CI workflow for building and releasing the macOS app

**Files:**
- Create: `.github/workflows/tauri-build.yml`

**Step 1: Create the workflow file**

```yaml
name: Build macOS App

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin

      - name: Install Tauri CLI
        run: cargo install tauri-cli --version "^2"

      - name: Build universal binary
        working-directory: native/macos/src-tauri
        run: |
          cargo tauri build --target universal-apple-darwin
        env:
          # For signed builds, add these secrets:
          # APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          # APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          # APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          # APPLE_ID: ${{ secrets.APPLE_ID }}
          # APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          # APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          TAURI_SIGNING_PRIVATE_KEY: ""

      - name: Package artifacts
        run: |
          VERSION=${GITHUB_REF_NAME#v}
          cd native/macos/src-tauri/target/universal-apple-darwin/release/bundle

          # Create tar.gz of .app for postinstall download
          if [ -d "macos/A2A Callbook.app" ]; then
            cd macos
            tar -czf "../../../A2A-Callbook-${VERSION}.app.tar.gz" "A2A Callbook.app"
            cd ..
          fi

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: macos-app
          path: |
            native/macos/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
            native/macos/src-tauri/target/universal-apple-darwin/release/bundle/A2A-Callbook-*.app.tar.gz

      - name: Attach to GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: |
            native/macos/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
            native/macos/src-tauri/target/universal-apple-darwin/release/bundle/A2A-Callbook-*.app.tar.gz
        env:
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}
```

**Step 2: Commit**

```bash
git add .github/workflows/tauri-build.yml
git commit -m "ci: add GitHub Actions workflow for macOS Tauri builds"
```

---

## Phase 12: Uninstall Support

### Task 12: Update `a2a uninstall` to remove the native app

**Files:**
- Modify: `bin/cli.js` (uninstall command)

**Step 1: Find the uninstall command and add app removal**

Locate the `uninstall` command in `bin/cli.js` and add cleanup for the macOS app:

```javascript
// Add to the uninstall flow, after existing cleanup:
if (os.platform() === 'darwin') {
  const appCandidates = [
    path.join(os.homedir(), 'Applications', 'A2A Callbook.app'),
    '/Applications/A2A Callbook.app',
  ];
  for (const appPath of appCandidates) {
    if (fs.existsSync(appPath)) {
      try {
        fs.rmSync(appPath, { recursive: true, force: true });
        console.log(`Removed ${appPath}`);
      } catch (err) {
        console.log(`Could not remove ${appPath}: ${err.message}`);
      }
    }
  }
}
```

**Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add bin/cli.js
git commit -m "feat: a2a uninstall removes macOS native app"
```

---

## Phase 13: Documentation

### Task 13: Update README and add native app docs

**Files:**
- Modify: `README.md` (add native app section)
- Modify: `CLAUDE.md` (add native app dev notes)

**Step 1: Add native app section to README**

Add a "Native macOS App" section describing:
- What it does (wraps the dashboard in a native window)
- Installation (automatic via `npm install -g a2acalling` on macOS)
- Manual install (download .dmg from Releases)
- Features (native notifications, Cmd+1–5 tab switching, menu bar, deep links)
- Building from source (`cd native/macos/src-tauri && cargo tauri build`)

**Step 2: Add dev notes to CLAUDE.md**

```markdown
## Native macOS App (Tauri)

Located in `native/macos/`. Tauri v2 app wrapping the dashboard SPA.

### Dev setup
\`\`\`bash
# Install Rust: https://rustup.rs
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Tauri CLI
cargo install tauri-cli --version "^2"

# Dev mode (live reload)
cd native/macos/src-tauri
cargo tauri dev

# Production build
cargo tauri build
\`\`\`

### Key files
- `native/macos/src-tauri/src/lib.rs` - App entry, menus, event handling
- `native/macos/src-tauri/src/discovery.rs` - Port scanning / server detection
- `native/macos/src-tauri/src/health.rs` - Background health monitor
- `native/macos/src-tauri/src/notifications.rs` - macOS notification bridge
- `native/macos/src-tauri/src/server.rs` - Server lifecycle (start/stop)
- `native/macos/index.html` - Loading page (shown before server found)
```

**Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add native macOS app documentation"
```

---

## Summary

| Phase | Task | Description | Key Files |
|-------|------|-------------|-----------|
| 1 | 1 | Scaffold Tauri v2 project | `native/macos/` (all) |
| 2 | 2 | Port discovery (config + scan) | `discovery.rs` |
| 3 | 3 | Server start/stop | `server.rs` |
| 4 | 4 | macOS lifecycle (Cmd+W, menus, shortcuts) | `lib.rs` |
| 5 | 5 | Reconnection overlay + health monitor | `health.rs`, `index.html` |
| 6 | 6 | Native notifications (poll + notify) | `notifications.rs` |
| 7 | 7 | Deep links (`a2a://` URL scheme) | `lib.rs`, `tauri.conf.json` |
| 8 | 8 | Menu bar tray icon | `lib.rs` |
| 9 | 9 | CLI integration (`a2a gui` prefers app) | `bin/cli.js` |
| 10 | 10 | npm postinstall app download | `scripts/postinstall.js` |
| 11 | 11 | GitHub Actions CI for builds | `.github/workflows/tauri-build.yml` |
| 12 | 12 | Uninstall cleanup | `bin/cli.js` |
| 13 | 13 | Documentation | `README.md`, `CLAUDE.md` |

### Out of Scope (per ticket)

- Windows/Linux builds
- Embedded server (beyond spawning `a2a server`)
- Offline mode / bundled SPA
- Custom native UI (SwiftUI)
- Real-time push (WebSocket/SSE)
- Auto-update mechanism
- App Store distribution
- Multiple server connections
- iOS/iPadOS companion
