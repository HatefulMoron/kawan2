//! SSH key fingerprint lookup and challenge signing via `ssh-keygen -Y sign`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

fn make_temp_dir(prefix: &str) -> Result<PathBuf, String> {
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("failed to create temp dir {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn expand_tilde(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(trimmed)
}

pub fn default_ssh_key_path() -> String {
    if let Ok(path) = std::env::var("KAWAN_SSH_KEY")
        && !path.trim().is_empty()
    {
        return path;
    }
    if let Ok(home) = std::env::var("HOME") {
        let ed = PathBuf::from(&home).join(".ssh/id_ed25519");
        if ed.exists() {
            return ed.to_string_lossy().to_string();
        }
    }
    "~/.ssh/id_ed25519".to_string()
}

pub fn pubkey_and_fingerprint(key_path: &Path) -> Result<(String, String), String> {
    if !key_path.exists() {
        return Err(format!("SSH private key not found: {}", key_path.display()));
    }

    let pub_sibling = PathBuf::from(format!("{}.pub", key_path.display()));
    let pubkey = if pub_sibling.exists() {
        std::fs::read_to_string(&pub_sibling)
            .map_err(|e| format!("failed reading {}: {e}", pub_sibling.display()))?
            .trim()
            .to_string()
    } else {
        let out = Command::new("ssh-keygen")
            .args(["-y", "-f"])
            .arg(key_path)
            .output()
            .map_err(|e| format!("failed running ssh-keygen -y: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen -y failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    let dir = make_temp_dir("kawan-fp")?;
    let fp_res = (|| -> Result<String, String> {
        let pub_file = dir.join("key.pub");
        std::fs::write(&pub_file, format!("{pubkey}\n"))
            .map_err(|e| format!("failed writing temp pubkey: {e}"))?;
        let out = Command::new("ssh-keygen")
            .args(["-lf"])
            .arg(&pub_file)
            .output()
            .map_err(|e| format!("failed running ssh-keygen -lf: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen -lf failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        stdout
            .split_whitespace()
            .find(|tok| tok.starts_with("SHA256:"))
            .map(str::to_string)
            .ok_or_else(|| format!("unable to parse SHA256 fingerprint from: {}", stdout.trim()))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    let fingerprint = fp_res?;
    Ok((pubkey, fingerprint))
}

pub fn sign_nonce(key_path: &Path, nonce: &str, namespace: &str) -> Result<String, String> {
    let dir = make_temp_dir("kawan-sign")?;
    let res = (|| -> Result<String, String> {
        let nonce_path = dir.join("nonce.txt");
        std::fs::write(&nonce_path, nonce.as_bytes())
            .map_err(|e| format!("failed writing nonce file: {e}"))?;
        let out = Command::new("ssh-keygen")
            .args(["-Y", "sign", "-f"])
            .arg(key_path)
            .args(["-n", namespace])
            .arg(&nonce_path)
            .output()
            .map_err(|e| format!("failed running ssh-keygen -Y sign: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ssh-keygen -Y sign failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let sig_path = dir.join("nonce.txt.sig");
        std::fs::read_to_string(&sig_path)
            .map_err(|e| format!("failed reading signature {}: {e}", sig_path.display()))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::Stdio;

    #[test]
    fn generates_signs_and_verifies_nonce() {
        let dir = make_temp_dir("kawan-ssh-test").unwrap();
        let key_path = dir.join("id_ed25519");
        let keygen_status = Command::new("ssh-keygen")
            .args(["-t", "ed25519", "-N", "", "-C", "test@kawan", "-f"])
            .arg(&key_path)
            .arg("-q")
            .status()
            .unwrap();
        assert!(keygen_status.success());

        let (pubkey, fp) = pubkey_and_fingerprint(&key_path).unwrap();
        assert!(pubkey.starts_with("ssh-ed25519 "));
        assert!(fp.starts_with("SHA256:"));

        let nonce = "test-nonce-1234";
        let ns = "kawan@127.0.0.1:8787";
        let sig = sign_nonce(&key_path, nonce, ns).unwrap();
        assert!(sig.contains("BEGIN SSH SIGNATURE"));

        let allowed = dir.join("allowed_signers");
        let sig_file = dir.join("proof.sig");
        std::fs::write(&allowed, format!("{fp} {pubkey}\n")).unwrap();
        std::fs::write(&sig_file, &sig).unwrap();

        let mut verify = Command::new("ssh-keygen")
            .args(["-Y", "verify", "-f"])
            .arg(&allowed)
            .args(["-I", &fp, "-n", ns, "-s"])
            .arg(&sig_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        verify
            .stdin
            .as_mut()
            .unwrap()
            .write_all(nonce.as_bytes())
            .unwrap();
        let status = verify.wait().unwrap();
        assert!(status.success());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
