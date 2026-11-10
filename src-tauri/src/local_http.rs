//! 本地 HTTP 媒体代理：把 [`crate::media::handle`] 挂到一个只监听
//! 127.0.0.1 的 HTTP 服务上。
//!
//! 为什么 iOS 必须走它（Linux 同理）：
//!
//! * **Linux**：Tauri 的自定义协议只对 WebView 自己的资源加载生效，而
//!   WebKitGTK 的 `<video>` 是交给 GStreamer 播放的，GStreamer 只认 http/https/file
//!   这类常规 URI，直接给它 `hg://localhost` 打不开。
//! * **iOS 16.x**：系统没有 Media Source Extensions（MSE 要 iOS 17.1+），
//!   所以 `Hls.isSupported()` 为 false，前端只能走原生 HLS 播放。而 iOS 的原生
//!   HLS 播放器（AVFoundation）**只接受 http/https**，拿到 `hg://localhost/...`
//!   会一直卡在转圈、永远不出画面。
//!
//! 所以 iOS 也改用 loopback HTTP：原生播放器拿到的是真正的 `http://127.0.0.1:PORT`
//! 地址，AVFoundation 能正常加载 m3u8 与分片；hls.js 在 iOS 17.1+ 上同样能走这条通道。
//!
//! 端口固定，前端 `src/api.ts` 的 `LOCAL` 必须与 [`ORIGIN`] 一致。
//! 只监听回环地址，外部设备访问不到，不构成开放代理。

use once_cell::sync::Lazy;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 监听端口。前端硬编码同一个值，两边必须同时改。
pub const PORT: u16 = 17650;

/// 前端与 m3u8 分片改写共用的 origin。
pub const ORIGIN: &str = "http://127.0.0.1:17650";

/* ───────────────────── 代理现场（诊断用） ─────────────────────
 *
 * 「视频一直转圈」有两种完全不同的成因，光看画面分不出来：
 *   A. 原生播放器（AVFoundation）根本没来请求 —— URL / ATS / 引擎选型的问题；
 *   B. 请求来了、也拿到了 200，但内容解不开 —— 改写或加密环节的问题。
 * A 和 B 的修法完全不同，所以必须能在手机上直接看到「代理到底被请求了几次、
 * 最后一次拿到什么状态、多少字节」，不必猜。
 *
 * 这些计数只在本进程内，不落盘、不含任何 URL 或凭据。
 */

#[derive(serde::Serialize, Clone, Default)]
pub struct ProxyStat {
    /// 启动以来处理的请求总数。0 = 原生播放器压根没来。
    pub total: u64,
    /// 最后一次请求的路由：hls（播放列表）/ seg（分片或 key）/ img（封面）
    pub route: String,
    /// 最后一次响应的 HTTP 状态码
    pub status: u16,
    /// 最后一次响应的字节数
    pub bytes: u64,
    /// 最后一次请求耗时（毫秒）
    pub ms: u64,
}

static REQ_TOTAL: AtomicU64 = AtomicU64::new(0);
static LAST_STATUS: AtomicU64 = AtomicU64::new(0);
static LAST_BYTES: AtomicU64 = AtomicU64::new(0);
static LAST_MS: AtomicU64 = AtomicU64::new(0);
static LAST_ROUTE: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

// Windows / macOS 不启动这个代理，record 会变成「没人调」—— 只是警告，不影响构建。
#[allow(dead_code)]
fn record(route: &str, status: u16, bytes: usize, ms: u64) {
    REQ_TOTAL.fetch_add(1, Ordering::Relaxed);
    LAST_STATUS.store(status as u64, Ordering::Relaxed);
    LAST_BYTES.store(bytes as u64, Ordering::Relaxed);
    LAST_MS.store(ms, Ordering::Relaxed);
    if let Ok(mut slot) = LAST_ROUTE.lock() {
        *slot = route.to_string();
    }
}

/// 前端诊断叠层读取。命名与其它 command 保持一致（snake_case）。
#[tauri::command]
pub fn proxy_stat() -> ProxyStat {
    ProxyStat {
        total: REQ_TOTAL.load(Ordering::Relaxed),
        route: LAST_ROUTE.lock().map(|s| s.clone()).unwrap_or_default(),
        status: LAST_STATUS.load(Ordering::Relaxed) as u16,
        bytes: LAST_BYTES.load(Ordering::Relaxed),
        ms: LAST_MS.load(Ordering::Relaxed),
    }
}

/// 在后台线程里起服务。绑定失败只记日志（播放会退回自定义协议，大概率失败）。
// Windows / macOS 走自定义协议，不启动这个服务；但 ORIGIN / PORT 仍被导航守卫引用，
// 所以模块始终编译，这里只是避免 start() 在这些平台上报 dead_code。
#[cfg_attr(
    not(any(target_os = "linux", target_os = "ios")),
    allow(dead_code)
)]
pub fn start() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("[hg] 媒体端口 {PORT} 绑定失败：{err}");
                return;
            }
        };
        eprintln!("[hg] 媒体代理就绪：{ORIGIN}");
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                if let Err(err) = serve(stream) {
                    eprintln!("[hg] 媒体请求失败：{err}");
                }
            });
        }
    });
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let started = std::time::Instant::now();
    let timeout = Some(std::time::Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    // 请求头整体丢弃：每个分片都是整包返回，不需要处理 Range。
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
    }

    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default();
    let target = request.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return write_plain(&mut stream, 405, "method not allowed");
    }

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let response = tauri::async_runtime::block_on(crate::media::handle(path, query, ORIGIN));
    let (parts, body) = response.into_parts();

    // 记现场：诊断「一直转圈」时第一眼要看的就是这个数。
    record(
        path.trim_start_matches('/'),
        parts.status.as_u16(),
        body.len(),
        started.elapsed().as_millis() as u64,
    );

    let mut head = String::with_capacity(320);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        parts.status.as_u16(),
        parts.status.canonical_reason().unwrap_or("OK")
    ));
    // Content-Length 统一在这里写一次：media::respond 已经带了同名头，
    // 若再遍历一遍就会输出两个 Content-Length，部分客户端会直接判为非法响应。
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    for (name, value) in parts.headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if lower == "content-length" || lower == "connection" {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), value));
        }
    }
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(&body)?;
    }
    stream.flush()
}

fn write_plain(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Error");
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
