/**
 * 视口 / 播放诊断叠层：把关键数值直接画在屏幕顶部，截图即可读数，不用猜。
 *
 * 为什么需要：
 *   1) iOS 上「底部白块」的根因在原生层（WKWebView 自动安全区内缩），
 *      光看画面很难区分「html 高度不够」和「WKWebView 视口本身矮一截」。
 *   2) 「视频一直转圈」更麻烦：可能是原生播放器压根没来请求（URL/ATS/引擎选型），
 *      也可能请求到了但内容解不开（改写/加密），两种成因修法完全相反，
 *      必须在手机上一眼分出来。
 *
 * 第一行（视口）：
 *   - innerH（window.innerHeight） layout viewport 高度
 *   - vvH（visualViewport.height）  动态视口高度
 *   - scrH（screen.height）         屏幕逻辑高度
 *   - docH（html 的实际盒高）       我们自己撑出来的高度
 *   - sab / sat（env() 实测值）     安全区环境变量是否真的生效
 *   - dpr                          设备像素比
 *   - b                            CI 构建号（确认装的是哪个包，版本号永远分不出来）
 *
 * 第二行（播放）：
 *   - px=<请求数>/<路由>:<状态>/<字节>/<毫秒>
 *       本地媒体代理（127.0.0.1:17650）的现场。
 *       px 的请求数为 0 → 原生播放器压根没来请求，问题在 URL/ATS/引擎；
 *       请求数不为 0 且状态 200 → 请求通了，问题在内容或解密。
 *   - vd=<readyState>/<networkState>[/e<code>]
 *       页面里 <video> 元素的状态。
 *       readyState: 0=无数据 1=只有元数据 2=有当前帧 3=有未来帧 4=够播
 *       networkState: 0=空 1=空闲 2=正在加载 3=没有可用源
 *       /e<code>: 媒体错误码（1=中止 2=网络 3=解码 4=格式不支持）
 *
 * 关掉：localStorage.setItem("hghub_vpdiag_off", "1") 后刷新。
 */

import { invoke } from "@tauri-apps/api/core";

const STYLE = [
  "position:fixed",
  "top:0",
  "left:0",
  "right:0",
  "z-index:2147483647",
  "font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  "color:#e8f6ff",
  "background:rgba(0,0,0,.78)",
  "padding:2px 5px",
  "pointer-events:none",
  "white-space:pre",
  "overflow:hidden",
].join(";");

export interface ViewportSnapshot {
  innerH: number;
  vvH: number;
  scrH: number;
  docH: number;
  sab: number;
  sat: number;
  dpr: number;
}

/** CI 构建号：一眼确认手机上装的是哪个包（版本号都是 1.2.14，看不出来）。 */
declare const __BUILD_NO__: string;

export function buildNo(): string {
  try {
    return typeof __BUILD_NO__ !== "undefined" ? String(__BUILD_NO__) : "?";
  } catch {
    return "?";
  }
}

export function readViewportSnapshot(): ViewportSnapshot {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:-9999px;top:0;padding-bottom:env(safe-area-inset-bottom);padding-top:env(safe-area-inset-top);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const sab = Math.round(parseFloat(cs.paddingBottom) || 0);
  const sat = Math.round(parseFloat(cs.paddingTop) || 0);
  probe.remove();
  return {
    innerH: Math.round(window.innerHeight),
    vvH: Math.round(window.visualViewport?.height ?? 0),
    scrH: Math.round(window.screen.height),
    docH: Math.round(document.documentElement.getBoundingClientRect().height),
    sab,
    sat,
    dpr: window.devicePixelRatio,
  };
}

/* ── 播放现场 ── */

interface ProxyStat {
  total: number;
  route: string;
  status: number;
  bytes: number;
  ms: number;
}

let lastProxy: ProxyStat | null = null;
let proxyFailed = false;

/** 拉一次本地媒体代理的现场。失败说明不是 Tauri 环境（浏览器里跑）或有别的问题。 */
async function pollProxy(): Promise<void> {
  try {
    lastProxy = await invoke<ProxyStat>("proxy_stat");
    proxyFailed = false;
  } catch {
    proxyFailed = true;
  }
}

/** 页面里 <video> 元素的状态：转圈时它到底卡在哪一环。 */
function videoStat(): string {
  const v = document.querySelector("video");
  if (!v) return "vd=-";
  const err = v.error ? v.error.code : 0;
  return `vd=${v.readyState}/${v.networkState}${err ? `/e${err}` : ""}`;
}

function proxyStat(): string {
  if (proxyFailed) return "px=err";
  if (!lastProxy) return "px=-";
  const p = lastProxy;
  return `px=${p.total}/${p.route || "-"}:${p.status}/${p.bytes}B/${p.ms}ms`;
}

export function installViewportDiag(): void {
  if (typeof document === "undefined" || document.getElementById("hg-vp-diag")) return;

  const el = document.createElement("div");
  el.id = "hg-vp-diag";
  el.style.cssText = STYLE;
  document.body.appendChild(el);

  const render = () => {
    const s = readViewportSnapshot();
    el.textContent =
      `b=${buildNo()} innerH=${s.innerH} vvH=${s.vvH} scrH=${s.scrH} docH=${s.docH} ` +
      `sab=${s.sab} sat=${s.sat} dpr=${s.dpr}\n` +
      `${proxyStat()} ${videoStat()}`;
  };

  render();
  void pollProxy();
  window.addEventListener("resize", render);
  window.addEventListener("orientationchange", render);
  window.visualViewport?.addEventListener("resize", render);
  window.setInterval(render, 1000);
  window.setInterval(() => void pollProxy(), 1000);
}
