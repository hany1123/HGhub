#!/usr/bin/env python3
"""往 iOS 工程的 main.mm 里注入「关掉 WKWebView 自动安全区内缩」的 ObjC 实现。

背景（底部白块的真正根因）：
  iOS 11+ 的 UIScrollView.contentInsetAdjustmentBehavior 默认 .automatic，
  WKWebView 内部那个 scroll view 会从外层 view controller 继承安全区 inset，
  把文档的 layout viewport 压缩掉「顶部安全区 + 底部安全区」那么多像素
  （iPhone 14 Pro：852 → 771）。顶部由 contentOffset 补偿所以看不出来，
  底部那 81~85px 画不到，直接露出 WKWebView 的白色底 —— 就是那条白块。

  内容再多也画不进那 85px，因为可视区本身就只有 771 高，纯 CSS 补不动，必须动原生。

做法（两层保险）：
  1) swizzle WKWebView 的 initWithFrame:configuration: —— 每个 WKWebView 创建的瞬间
     就把 scrollView.contentInsetAdjustmentBehavior 设成 .never，不依赖调用时机。
  2) 另外导出一个 C 函数 hg_disable_webview_safe_area(webview)，
     供 Rust 侧用 dlsym 运行时查找后精确设置主窗口那个 webview。
     （Rust 侧不能用 extern "C" 直接声明：iOS 是 cargo build 先出静态库、
      Xcode 之后才编译 main.mm，直接声明会在静态库链接期就报 Undefined symbols。）

注意：
  - C 函数带 __attribute__((used))，防止 release 构建的 dead-strip 把它删掉，
    否则 dlsym 找不到。
  - swizzle 用 +load 自动注册，不需要改 main()。
  - 脚本幂等：已注入过就跳过。

用法：
  python3 scripts/patch-ios-main-mm.py src-tauri/gen/apple/Sources/<name>/main.mm
"""

import re
import sys

MARKER = "hg_disable_webview_safe_area"

HEADER = """#import <WebKit/WebKit.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
"""

IMPL = """
// --- HGhub: 关掉 WKWebView 的自动安全区内缩（底部白块修复）---
// iOS 11+ 的 UIScrollView.contentInsetAdjustmentBehavior 默认 .automatic，
// WKWebView 内部的 scroll view 会继承 view controller 的安全区 inset，
// 把文档的 layout viewport 压矮「上+下安全区」那么多，页面底部画不到的地方
// 直接露出 WKWebView 的白底。设成 .never 后 layout viewport 恢复成整块屏幕，
// 安全区交回给 CSS 的 env(safe-area-inset-*) 处理。
//
// 用 __attribute__((used)) 是为了防止 release 构建的 dead-strip 把这个符号删掉 ——
// Rust 侧要用 dlsym 在运行时找到它。

// App 的画布色（CSS 变量 --p-canvas: #1a1a1a）。
// 万一 webview 在某些机型 / 安全区组合下没能铺满屏幕，露出来的原生视图
// 默认是系统白底（纯白，非常刺眼）。把祖先视图刷成画布色，最坏情况也只是
// 多一条深色边，而不是一条白边。
static UIColor* HGDarkBackdrop(void) {
  return [UIColor colorWithRed:0.10196 green:0.10196 blue:0.10196 alpha:1.0];
}

static void HGPaintBackdrop(WKWebView* wv) {
  UIColor* dark = HGDarkBackdrop();
  int guard = 0;
  UIView* host = wv.superview;
  while (host != nil && guard++ < 8) {
    host.backgroundColor = dark;
    if (host == wv.window) break;
    host = host.superview;
  }
  if (wv.window != nil) {
    wv.window.backgroundColor = dark;
  }
}

__attribute__((used)) extern "C" void hg_disable_webview_safe_area(void* webview) {
  if (webview == NULL) return;
  // Tauri 的 Xcode 工程开了 ARC，void* → ObjC 指针必须用 __bridge。
  WKWebView* wv = (__bridge WKWebView*)webview;
  wv.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
  wv.scrollView.contentInset = UIEdgeInsetsZero;
  HGPaintBackdrop(wv);
}

// 第二层保险：swizzle WKWebView 加入 window 的时机，任何 WKWebView 一进 view 层级就设好。
// 这里刻意不用 initWithFrame:configuration: —— ARC 规定「init family」之外的方法
// 不允许给 self 赋值，方法名改对很啰嗦；didMoveToWindow 没有这个约束，更省事也更稳。
@interface WKWebView (HGSafeArea)
+ (void)hg_disableSafeAreaInsets;
@end

@implementation WKWebView (HGSafeArea)

+ (void)load {
  [self hg_disableSafeAreaInsets];
}

+ (void)hg_disableSafeAreaInsets {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class cls = [WKWebView class];
    SEL origSel = @selector(didMoveToWindow);
    SEL swzSel = @selector(hg_didMoveToWindow);
    Method orig = class_getInstanceMethod(cls, origSel);
    Method swz = class_getInstanceMethod(cls, swzSel);
    if (orig != NULL && swz != NULL) {
      method_exchangeImplementations(orig, swz);
    }
  });
}

- (void)hg_didMoveToWindow {
  // 交换之后，这里的 hg_didMoveToWindow 就是原来的实现。
  [self hg_didMoveToWindow];
  if (self.window != nil) {
    self.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.scrollView.contentInset = UIEdgeInsetsZero;
    HGPaintBackdrop(self);
  }
}

@end
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
