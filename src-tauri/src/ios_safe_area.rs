//! iOS：关掉 WKWebView 内部的自动安全区内缩 —— 这才是「底部白块」的真正根因。
//!
//! ## 现象
//!
//! 手机底部出现一条纯白带（实测约 85 CSS px），App 内容在它上面就结束了。
//! 白区颜色是纯白 `#ffffff`，不是 App 自己的画布色 `#1a1a1a`，
//! 说明露出来的是 **WKWebView 的底色**，不是「html 高度不够露出的背景」。
//!
//! ## 机制
//!
//! iOS 11+ 的 `UIScrollView.contentInsetAdjustmentBehavior` 默认是 `.automatic`。
//! WKWebView 内部那个 scroll view 会从外层 view controller 继承安全区 inset，
//! 于是：
//!
//! - 文档的 layout viewport 被压缩掉「顶部安全区 + 底部安全区」那么多像素
//!   （iPhone 14 Pro：852 → 852 − (47 + 34) = 771）；
//! - 顶部由 contentOffset 补偿，所以内容看起来仍贴着 y=0（顶部 Logo 顶边）；
//! - 底部没人补 —— 771 以下画不到的地方直接露出 WKWebView 的白底。
//!
//! 关键是：**页面内容再多也画不进那 85px**，因为可视区本身就只有 771 高。
//! 所以纯 CSS 补 `height` / `padding-bottom` 是补不动的，必须动原生。
//!
//! ## 修法
//!
//! 把 `contentInsetAdjustmentBehavior` 设成 `.never`：
//! layout viewport 恢复成整块屏幕，`env(safe-area-inset-*)` 开始返回真实值，
//! 安全区改由 CSS 自己避让（`index.css` 里 `html { padding-bottom: env(safe-area-inset-bottom) }`，
//! 配合 `box-sizing: border-box` 让内容区正好收缩到安全区之上，底栏也就自然避开了 home indicator）。
//!
//! Tauri 2 自己完全没处理这件事（上游仓库搜 `contentInsetAdjustmentBehavior` / `safeAreaInsets`
//! 都是 0 命中），只能自己补。
//!
//! ## 为什么绕开 objc2
//!
//! 直接用 objc2 调 `setContentInsetAdjustmentBehavior:` 会随 objc2 / objc2-ui-kit
//! 的版本变化而崩。这里让构建脚本（`scripts/patch-ios-main-mm.py`）往 iOS 工程的
//! `main.mm` 里注入一段 ObjC 实现，Rust 侧只通过 `extern "C"` 调它 ——
//! Rust 侧不碰任何 objc2 API，跨版本零风险。

#[cfg(target_os = "ios")]
use std::ffi::c_void;

#[cfg(target_os = "ios")]
extern "C" {
    /// 由构建脚本注入到 iOS 工程 `main.mm` 的 ObjC 实现：
    /// 拿到 WKWebView，把它的 `scrollView.contentInsetAdjustmentBehavior` 设成 `.never`。
    fn hg_disable_webview_safe_area(webview: *mut c_void);
}

/// 给 webview 关掉 UIScrollView 的自动安全区 inset 调整。
///
/// 只在 iOS 上有实际动作；其它平台是空实现，调用点不必写 `cfg`。
///
/// 幂等：重复设置同一个属性没有副作用，所以 setup 与 on_page_load 两处都调用是安全的。
#[cfg(target_os = "ios")]
pub fn apply<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    let _ = webview.with_webview(move |wv| unsafe {
        hg_disable_webview_safe_area(wv.inner());
    });
}

/// 同上，但走窗口句柄。iOS 上窗口在 `setup` 之前就建好了，所以这里能立刻拿到 webview。
#[cfg(target_os = "ios")]
pub fn apply_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(move |wv| unsafe {
        hg_disable_webview_safe_area(wv.inner());
    });
}

#[cfg(not(target_os = "ios"))]
pub fn apply<R: tauri::Runtime>(_webview: &tauri::Webview<R>) {}

#[cfg(not(target_os = "ios"))]
pub fn apply_window<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
