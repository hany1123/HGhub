#!/usr/bin/env python3
"""往 iOS 工程的 main.mm 里注入 hg_disable_webview_safe_area。

背景（底部白块的真正根因）：
  iOS 11+ 的 UIScrollView.contentInsetAdjustmentBehavior 默认 .automatic，
  WKWebView 内部那个 scroll view 会从外层 view controller 继承安全区 inset，
  把文档的 layout viewport 压缩掉「顶部安全区 + 底部安全区」那么多像素
  （iPhone 14 Pro：852 → 771）。顶部由 contentOffset 补偿所以看不出来，
  底部那 81~85px 画不到，直接露出 WKWebView 的白色底 —— 就是那条白块。

  内容再多也画不进那 85px，因为可视区本身就只有 771 高，纯 CSS 补不动，必须动原生。

做法：
  把 contentInsetAdjustmentBehavior 设成 .never，layout viewport 恢复成整块屏幕，
  安全区改由 CSS 的 env(safe-area-inset-*) 自己避让。

为什么用 ObjC 而不是 Rust 直接调 objc2：
  objc2 / objc2-ui-kit 的 API 会随版本变。这里 Rust 侧只留一个 extern "C" 声明，
  真正的实现放在 main.mm 里，Rust 侧不碰任何 objc2 API，跨版本零风险。

用法：
  python3 scripts/patch-ios-main-mm.py src-tauri/gen/apple/Sources/<name>/main.mm
"""

import re
import sys

MARKER = "hg_disable_webview_safe_area"

HEADER = """#import <WebKit/WebKit.h>
#import <UIKit/UIKit.h>
"""

IMPL = """
// --- HGhub: 关掉 WKWebView 的自动安全区内缩（底部白块修复）---
// iOS 11+ 的 UIScrollView.contentInsetAdjustmentBehavior 默认 .automatic，
// WKWebView 内部的 scroll view 会继承 view controller 的安全区 inset，
// 把文档的 layout viewport 压矮「上+下安全区」那么多，页面底部画不到的地方
// 直接露出 WKWebView 的白底。设成 .never 后 layout viewport 恢复成整块屏幕，
// 安全区交回给 CSS 的 env(safe-area-inset-*) 处理。
extern "C" void hg_disable_webview_safe_area(void* webview) {
  if (webview == NULL) return;
  WKWebView* wv = (__bridge WKWebView*)webview;
  wv.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
}
"""


def patch(path: str) -> int:
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if MARKER in src:
        print(f"skip: {MARKER} already present in {path}")
        return 0

    if "#import <WebKit/WebKit.h>" not in src:
        src = HEADER + src

    # 插到 int main( 之前；找不到就追加到文件末尾
    m = re.search(r"^int\s+main\s*\(", src, flags=re.MULTILINE)
    if m:
        src = src[: m.start()] + IMPL.lstrip("\n") + "\n" + src[m.start() :]
    else:
        src = src.rstrip() + "\n" + IMPL

    with open(path, "w", encoding="utf-8") as f:
        f.write(src)

    print(f"patched: injected {MARKER} into {path}")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    return patch(sys.argv[1])


if __name__ == "__main__":
    raise SystemExit(main())
