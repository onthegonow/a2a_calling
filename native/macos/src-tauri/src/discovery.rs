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
pub fn read_config_port() -> Option<u16> {
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
