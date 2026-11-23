//! Blocking background WebSocket transport using `tungstenite` + `std::sync::mpsc`.

use std::io::ErrorKind;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

use crate::protocol::ServerFrame;
use crate::ssh::{expand_tilde, pubkey_and_fingerprint, sign_nonce};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Bootstrap,
    Register,
    Login,
}

#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub url: String,
    pub mode: AuthMode,
    pub token: String,
    pub name: String,
    pub key_path: String,
}

#[derive(Debug)]
pub enum WsEvent {
    Frame(Box<ServerFrame>),
    Disconnected(String),
}

pub struct WsHandle {
    out_tx: Sender<String>,
    pub in_rx: Receiver<WsEvent>,
    req_counter: u64,
}

impl WsHandle {
    pub fn connect(config: ConnectConfig) -> Self {
        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (in_tx, in_rx) = mpsc::channel::<WsEvent>();

        std::thread::spawn(move || {
            if let Err(err) = run_ws_loop(config, out_rx, &in_tx) {
                let _ = in_tx.send(WsEvent::Disconnected(err));
            }
        });

        Self {
            out_tx,
            in_rx,
            req_counter: 0,
        }
    }

    pub fn send_command(&mut self, command: &str, mut payload: Value) -> String {
        self.req_counter += 1;
        let id = format!("cli-{}", self.req_counter);
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
            obj.insert("type".to_string(), json!(command));
        }
        let line = serde_json::to_string(&payload).unwrap_or_default();
        let _ = self.out_tx.send(line);
        id
    }
}

fn read_next_frame(
    socket: &mut tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>,
) -> Result<Option<ServerFrame>, String> {
    match socket.read() {
        Ok(Message::Text(txt)) => {
            for line in txt.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let frame: ServerFrame = serde_json::from_str(trimmed)
                    .map_err(|e| format!("invalid host frame: {e}"))?;
                return Ok(Some(frame));
            }
            Ok(None)
        }
        Ok(Message::Ping(payload)) => {
            let _ = socket.send(Message::Pong(payload));
            Ok(None)
        }
        Ok(Message::Close(frame)) => {
            let reason = frame
                .map(|c| c.reason.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "connection closed".to_string());
            Err(reason)
        }
        Ok(_) => Ok(None),
        Err(tungstenite::Error::Io(ref io_err))
            if matches!(io_err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
        {
            Ok(None)
        }
        Err(err) => Err(format!("websocket error: {err}")),
    }
}

fn run_ws_loop(
    config: ConnectConfig,
    out_rx: Receiver<String>,
    in_tx: &Sender<WsEvent>,
) -> Result<(), String> {
    let key_path = expand_tilde(&config.key_path);
    let (pubkey, fingerprint) = pubkey_and_fingerprint(&key_path)?;

    let url = config.url.trim().to_string();
    let url = if url.starts_with("ws://") || url.starts_with("wss://") {
        url
    } else {
        format!("ws://{url}")
    };

    let (mut socket, _) =
        tungstenite::connect(&url).map_err(|e| format!("failed to connect to {url}: {e}"))?;

    if let MaybeTlsStream::Plain(tcp) = socket.get_mut() {
        let _ = tcp.set_read_timeout(Some(Duration::from_millis(25)));
    }

    let init_frame = match config.mode {
        AuthMode::Bootstrap => json!({
            "type": "bootstrap",
            "token": config.token.trim(),
            "pubkey": pubkey,
            "name": config.name.trim(),
            "version": 1
        }),
        AuthMode::Register => json!({
            "type": "register",
            "token": config.token.trim(),
            "pubkey": pubkey,
            "name": config.name.trim(),
            "version": 1
        }),
        AuthMode::Login => json!({
            "type": "hello",
            "key": fingerprint,
            "version": 1
        }),
    };

    socket
        .send(Message::Text(init_frame.to_string().into()))
        .map_err(|e| format!("failed sending auth hello: {e}"))?;

    // Wait for challenge (handling brief read timeouts)
    let (nonce, namespace) = loop {
        if let Some(frame) = read_next_frame(&mut socket)? {
            match frame {
                ServerFrame::Challenge {
                    nonce, namespace, ..
                } => break (nonce, namespace),
                ServerFrame::Error { message, .. } => return Err(message),
                other => return Err(format!("expected challenge, got {other:?}")),
            }
        }
    };

    let signature = sign_nonce(&key_path, &nonce, &namespace)?;
    let proof_frame = json!({
        "type": "proof",
        "signature": signature,
    });
    socket
        .send(Message::Text(proof_frame.to_string().into()))
        .map_err(|e| format!("failed sending proof: {e}"))?;

    // Wait for welcome
    loop {
        if let Some(frame) = read_next_frame(&mut socket)? {
            match frame {
                ServerFrame::Welcome { .. } => {
                    let _ = in_tx.send(WsEvent::Frame(Box::new(frame)));
                    break;
                }
                ServerFrame::Error { message, .. } => return Err(message),
                other => return Err(format!("expected welcome, got {other:?}")),
            }
        }
    }

    // Main bidirectional loop
    loop {
        while let Ok(line) = out_rx.try_recv() {
            if let Err(err) = socket.send(Message::Text(line.into())) {
                return Err(format!("websocket send error: {err}"));
            }
        }

        match socket.read() {
            Ok(Message::Text(txt)) => {
                for line in txt.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let frame: ServerFrame = serde_json::from_str(trimmed)
                        .map_err(|e| format!("invalid host frame: {e}"))?;
                    if in_tx.send(WsEvent::Frame(Box::new(frame))).is_err() {
                        return Ok(());
                    }
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = socket.send(Message::Pong(payload));
            }
            Ok(Message::Close(frame)) => {
                let reason = frame
                    .map(|c| c.reason.to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "disconnected".to_string());
                return Err(reason);
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref io_err))
                if matches!(io_err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(err) => return Err(format!("websocket read error: {err}")),
        }
    }
}
