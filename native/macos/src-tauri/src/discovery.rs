use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const DEFAULT_PORTS: &[u16] = &[80, 3001, 8080, 8443, 9001];
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub port: Option<u16>,
    pub source: String, // "config" | "scan" | "none"
}

#[derive(Debug, Deserialize)]
struct A2AConfig {
    onboarding: Option<OnboardingConfig>,
    agent: Option<AgentConfig>,
}

#[derive(Debug, Deserialize)]
struct OnboardingConfig {
    #[serde(alias = "serverPort")]
    server_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
struct AgentConfig {
    hostname: Option<String>,
}

fn parse_port_from_hostname(hostname: &str) -> Option<u16> {
    let trimmed = hostname.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Allow values like:
    // - 149.28.213.47:3007
    // - localhost:3007
    // - http://localhost:3007
    // - [::1]:3007
    let without_scheme = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let host_segment = without_scheme.split('/').next().unwrap_or(without_scheme);

    if host_segment.starts_with('[') {
        let end = host_segment.find(']')?;
        let remainder = &host_segment[end + 1..];
        let port_str = remainder.strip_prefix(':')?;
        return port_str.parse::<u16>().ok();
    }

    // Bare IPv6 literals contain multiple colons and no explicit port delimiter.
    if host_segment.matches(':').count() > 1 {
        return None;
    }

    let (_, port_str) = host_segment.rsplit_once(':')?;
    if !port_str.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    port_str.parse::<u16>().ok()
}

/// Read likely server ports from ~/.config/openclaw/a2a-config.json.
/// We prefer explicit onboarding server_port, then agent.hostname port.
pub fn read_config_ports() -> Vec<u16> {
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
    let content = match std::fs::read_to_string(config_path) {
        Ok(data) => data,
        Err(_) => return vec![],
    };
    let config: A2AConfig = match serde_json::from_str(&content) {
        Ok(parsed) => parsed,
        Err(_) => return vec![],
    };

    let mut ports = Vec::new();

    if let Some(port) = config.onboarding.and_then(|ob| ob.server_port) {
        ports.push(port);
    }

    if let Some(port) = config
        .agent
        .and_then(|agent| agent.hostname)
        .and_then(|hostname| parse_port_from_hostname(&hostname))
    {
        if !ports.contains(&port) {
            ports.push(port);
        }
    }

    ports
}

/// Probe a single port — returns true if a2a server responds
async fn probe_port(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => return false,
    };

    for host in ["127.0.0.1", "localhost"] {
        let url = format!("http://{}:{}/api/a2a/ping", host, port);
        let ok = match client.get(&url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    false
                } else {
                    match resp.text().await {
                        Ok(body) => body.contains("\"pong\":true"),
                        Err(_) => false,
                    }
                }
            }
            Err(_) => false,
        };

        if ok {
            return true;
        }
    }

    false
}

/// Discover the running a2a server.
/// If `sidecar_port` is provided, check it first before config/scan fallback.
pub async fn discover_server(sidecar_port: Option<u16>) -> DiscoveryResult {
    // 0. Check sidecar port first (highest priority)
    if let Some(port) = sidecar_port {
        if probe_port(port).await {
            return DiscoveryResult {
                port: Some(port),
                source: "sidecar".to_string(),
            };
        }
    }

    let config_ports = read_config_ports();

    // 1. Try config-derived ports
    for &port in &config_ports {
        if probe_port(port).await {
            return DiscoveryResult {
                port: Some(port),
                source: "config".to_string(),
            };
        }
    }

    // 2. Scan default ports (skip those already checked from config)
    for &port in DEFAULT_PORTS {
        if config_ports.contains(&port) {
            continue;
        }
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
