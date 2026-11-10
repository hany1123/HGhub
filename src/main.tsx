import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./playbackDiagnostics";
import { initAutoLine } from "./autoLine";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./api";
import { buildNo, installViewportDiag, readViewportSnapshot } from "./viewportDiag";
import Hls from "hls.js";
installPlaybackPageEvents();
void initPlaybackLog();
/* 自动选线：启动时比一次 com / ai，之后跟着网络变化复查 */
initAutoLine();

/* 视口诊断叠层：把 innerH/vvH/scrH/docH/sab 直接画在屏幕顶部，截图即可读数。
   底部白块那类问题光看画面分不清是「html 高度不够」还是「WKWebView 视口本身矮一截」，
   这两组数值一摆出来就能定位。行首 b= 是 CI 构建号，用来确认装的是哪个包
   （版本号永远是 1.2.14，光看版本号分不出来）。
   localStorage 设 hghub_vpdiag_off=1 可关掉。 */
try {
  if (localStorage.getItem("hghub_vpdiag_off") !== "1") installViewportDiag();
} catch (e) {
  // localStorage 不可用（隐私模式等）时也要装诊断层，否则更难查
  installViewportDiag();
}

/* 环境指纹：写进始终记录的 debug.log。用户复制诊断时不用再自报版本、平台、内核版本 */
const vp = readViewportSnapshot();
logLine(
  `[env] ver=${APP_VERSION} build=${buildNo()} platform=${platform} webview=${webviewVersion} ` +
    `engine=${Hls.isSupported() ? "hls.js" : "native"} ` +
    `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
    `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language} ` +
    `innerH=${vp.innerH} vvH=${vp.vvH} docH=${vp.docH} sab=${vp.sab} sat=${vp.sat}`,
);

/* 环境指纹也进结构化日志（开诊断后不会只有一行空跑） */
tracePlayback("app.env", {
  ver: APP_VERSION, platform, webview: webviewVersion,
  engine: Hls.isSupported() ? "hls.js" : "native",
  media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
  media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
  dpr: devicePixelRatio, lang: navigator.language,
});
/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* iOS: WKWebView 的 layout viewport 在工具栏收起 / 键盘弹出后不更新，
   `height: 100%` 会停在偏小的旧值，底部露出一截空白（横屏再竖屏才恢复的根源）。
   index.css 已改用 `100dvh` + `env(safe-area-inset-bottom)` 处理，这里只做兜底：
   万一 dvh 不可用（iOS < 15.4），再把高度钉到 window.innerHeight。
   注意不能钉 visualViewport.height —— 它不含底部 home indicator 安全区，
   钉上去根容器会矮一截，底部照样露白。 */
if (platform === "ios" && window.visualViewport) {
  const supportsDvh = CSS.supports("height", "100dvh");
  if (!supportsDvh) {
    const apply = () => {
      // innerHeight 是 layout viewport 高度，含安全区；取它才不会矮一截。
      const h = window.innerHeight || window.visualViewport?.height;
      if (h) document.documentElement.style.height = `${h}px`;
    };
    apply();
    window.visualViewport.addEventListener("resize", apply);
    window.addEventListener("orientationchange", () => setTimeout(apply, 150));
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
