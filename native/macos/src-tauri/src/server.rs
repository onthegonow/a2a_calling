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

    let port = crate::discovery::read_config_ports()
        .first()
        .copied()
        .unwrap_or(3001);
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
            message: format!("Server starting on port {}...", port),
        },
        Err(err) => StartResult {
            success: false,
            message: format!("Failed to start server: {}", err),
        },
    }
}
