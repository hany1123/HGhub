/**
 * 视口诊断叠层：把关键数值直接画在屏幕顶部，截图即可读数，不用猜。
 *
 * 为什么需要：
 *   iOS 上「底部白块」的根因在原生层（WKWebView 自动安全区内缩），
 *   光看画面很难区分「html 高度不够」和「WKWebView 视口本身矮一截」，
 *   这两组数值一摆出来就能定位：
 *
 *   - scrH（screen.height）        屏幕逻辑高度
 *   - innerH（window.innerHeight） layout viewport 高度
 *   - vvH（visualViewport.height） 动态视口高度
 *   - docH（html 的实际盒高）      我们自己撑出来的高度
 *   - sab / sat（env() 实测值）    安全区环境变量是否真的生效
 *
 *   判断：
 *   - innerH < scrH，且 sab=0  →  WKWebView 被安全区内缩了（原生问题，CSS 补不动）
 *   - innerH == scrH，但 docH < innerH →  html 高度不够（CSS 问题）
 *   - sab > 0  →  原生已放开，CSS 的 env() 避让生效
 *
 * 关掉：localStorage.setItem("hghub_vpdiag_off", "1") 后刷新。
 */

const STYLE = [
  "position:fixed",
  "top:0",
  "left:0",
  "right:0",
  "z-index:2147483647",
  "font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  "color:#e8f6ff",
  "background:rgba(0,0,0,.78)",
  "padding:2px 6px",
  "pointer-events:none",
  "white-space:nowrap",
  "overflow:hidden",
  "text-overflow:ellipsis",
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

export function installViewportDiag(): void {
  if (typeof document === "undefined" || document.getElementById("hg-vp-diag")) return;

  const el = document.createElement("div");
  el.id = "hg-vp-diag";
  el.style.cssText = STYLE;
  document.body.appendChild(el);

  const render = () => {
    const s = readViewportSnapshot();
    el.textContent =
      `innerH=${s.innerH} vvH=${s.vvH} scrH=${s.scrH} docH=${s.docH} ` +
      `sab=${s.sab} sat=${s.sat} dpr=${s.dpr}`;
  };

  render();
  window.addEventListener("resize", render);
  window.addEventListener("orientationchange", render);
  window.visualViewport?.addEventListener("resize", render);
  window.setInterval(render, 1000);
}
