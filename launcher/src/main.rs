#![cfg_attr(windows, windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

const PORTS: [u16; 4] = [47816, 47817, 47818, 47819];
const IDLE_SECS: u64 = 600;
const ALIVE: &str = "/__alive";

fn main() {
    let args: Vec<String> = env::args().collect();
    let root = args
        .iter()
        .position(|a| a == "--root")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(default_root);
    if !root.join("index.html").is_file() {
        fail(&format!("The map files were not found in {}", root.display()));
    }
    let open = !args.iter().any(|a| a == "--no-browser");
    for port in PORTS {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return serve(listener, port, root, open),
            Err(_) if ours(port) => {
                if open {
                    browse(port);
                }
                return;
            }
            Err(_) => continue,
        }
    }
    fail("No free local port for the map (47816-47819).");
}

fn default_root() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("app")))
        .unwrap_or_else(|| PathBuf::from("app"))
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn serve(listener: TcpListener, port: u16, root: PathBuf, open: bool) {
    let last = Arc::new(AtomicU64::new(now()));
    let watch = Arc::clone(&last);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(15));
        if now().saturating_sub(watch.load(Ordering::Relaxed)) > IDLE_SECS {
            std::process::exit(0);
        }
    });
    if open {
        browse(port);
    }
    let root = Arc::new(root);
    for stream in listener.incoming().flatten() {
        let (root, last) = (Arc::clone(&root), Arc::clone(&last));
        thread::spawn(move || handle(stream, &root, port, &last));
    }
}

fn ours(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    s.set_read_timeout(Some(Duration::from_secs(2))).ok();
    let req = format!("GET {ALIVE} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).is_ok() && line.starts_with("HTTP/1.1 204")
}

fn handle(stream: TcpStream, root: &Path, port: u16, last: &AtomicU64) {
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let Ok(mut out) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let (mut close, mut host, mut tag, mut body) = (false, String::new(), String::new(), 0u64);
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let Some((k, v)) = h.split_once(':') else { continue };
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "connection" => close = v.eq_ignore_ascii_case("close"),
                "host" => host = v.to_ascii_lowercase(),
                "if-none-match" => tag = v.to_string(),
                "content-length" => body = v.parse().unwrap_or(0),
                _ => {}
            }
        }
        if body > 0 && std::io::copy(&mut reader.by_ref().take(body), &mut std::io::sink()).is_err() {
            return;
        }
        last.store(now(), Ordering::Relaxed);
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("/");
        let head = method == "HEAD";
        let path = target.split(['?', '#']).next().unwrap_or("/");
        let sent = if !hosts.contains(&host) {
            reply(&mut out, "403 Forbidden", "text/plain", b"Forbidden", None, head)
        } else if method != "GET" && !head {
            reply(&mut out, "405 Method Not Allowed", "text/plain", b"Method not allowed", None, false)
        } else if path == ALIVE {
            reply(&mut out, "204 No Content", "text/plain", b"", None, true)
        } else {
            match resolve(root, path).and_then(|p| fs::metadata(&p).ok().map(|m| (p, m))) {
                Some((p, meta)) => {
                    let stamp = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                    let etag = format!("\"{:x}-{:x}\"", meta.len(), stamp);
                    if tag == etag {
                        reply(&mut out, "304 Not Modified", mime(&p), b"", Some(&etag), true)
                    } else {
                        match fs::read(&p) {
                            Ok(body) => reply(&mut out, "200 OK", mime(&p), &body, Some(&etag), head),
                            Err(_) => reply(&mut out, "500 Internal Server Error", "text/plain", b"Read error", None, head),
                        }
                    }
                }
                None => reply(&mut out, "404 Not Found", "text/plain", b"Not found", None, head),
            }
        };
        if !sent || close {
            return;
        }
    }
}

fn reply(out: &mut TcpStream, status: &str, kind: &str, body: &[u8], etag: Option<&str>, empty: bool) -> bool {
    let len = if status.starts_with("204") || status.starts_with("304") { 0 } else { body.len() };
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {len}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\n"
    );
    if let Some(t) = etag {
        head.push_str(&format!("ETag: {t}\r\n"));
    }
    head.push_str("\r\n");
    if out.write_all(head.as_bytes()).is_err() {
        return false;
    }
    if !empty && len > 0 && out.write_all(body).is_err() {
        return false;
    }
    out.flush().is_ok()
}

fn resolve(root: &Path, path: &str) -> Option<PathBuf> {
    let decoded = decode(path)?;
    let rel = Path::new(decoded.trim_start_matches('/'));
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let full = root.join(rel);
    let full = if decoded.ends_with('/') || decoded.is_empty() { full.join("index.html") } else { full };
    full.is_file().then_some(full)
}

fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out).ok()?;
    (!s.contains('\0') && !s.contains('\\')).then_some(s)
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "webp" => "image/webp",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn browse(port: u16) {
    let url = format!("http://127.0.0.1:{port}/");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("cmd").args(["/C", "start", "", &url]).creation_flags(0x0800_0000).spawn();
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

#[cfg(windows)]
fn fail(msg: &str) -> ! {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(msg), wide("Dune Awakening Map"));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 0x10) };
    std::process::exit(1)
}

#[cfg(not(windows))]
fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}
