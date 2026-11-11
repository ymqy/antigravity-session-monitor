#!/usr/bin/env python3
"""Zero-dependency macOS native Accessibility helper to submit `/compact` on manual click.

Uses only built-in macOS frameworks (`CoreFoundation`, `ApplicationServices`, `CoreGraphics`)
via Python standard-library `ctypes` — no third-party packages or external binaries required.
"""

from __future__ import annotations

import ctypes
import json
import re
import subprocess
import sys
import time

PLACEHOLDER = "Ask anything, @ to mention, / for actions"
K_CF_STRING_ENCODING_UTF8 = 0x08000100
KEYCODE_RETURN = 36

cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
ax = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
cg = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFStringGetLength.argtypes = [ctypes.c_void_p]
cf.CFStringGetLength.restype = ctypes.c_long
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFStringGetTypeID.restype = ctypes.c_ulong
cf.CFArrayGetTypeID.restype = ctypes.c_ulong
cf.CFRelease.argtypes = [ctypes.c_void_p]
cf.CFRetain.argtypes = [ctypes.c_void_p]
cf.CFRetain.restype = ctypes.c_void_p

K_CF_BOOLEAN_TRUE = ctypes.c_void_p.in_dll(cf, "kCFBooleanTrue")

ax.AXIsProcessTrusted.restype = ctypes.c_bool
ax.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
ax.AXUIElementCreateApplication.restype = ctypes.c_void_p
ax.AXUIElementCopyAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
ax.AXUIElementCopyAttributeValue.restype = ctypes.c_int32
ax.AXUIElementSetAttributeValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
ax.AXUIElementSetAttributeValue.restype = ctypes.c_int32
ax.AXUIElementPerformAction.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
ax.AXUIElementPerformAction.restype = ctypes.c_int32

cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventKeyboardSetUnicodeString.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_uint16)]
cg.CGEventPostToPid.argtypes = [ctypes.c_int, ctypes.c_void_p]

STR_ID = cf.CFStringGetTypeID()
ARR_ID = cf.CFArrayGetTypeID()


def cfstr(text: str) -> int:
    return cf.CFStringCreateWithCString(None, text.encode("utf-8"), K_CF_STRING_ENCODING_UTF8)


def py_str(ref: int | None) -> str:
    if not ref or cf.CFGetTypeID(ref) != STR_ID:
        return ""
    buf_len = cf.CFStringGetLength(ref) * 4 + 4
    buf = ctypes.create_string_buffer(buf_len)
    if cf.CFStringGetCString(ref, buf, buf_len, K_CF_STRING_ENCODING_UTF8):
        return buf.value.decode("utf-8", "replace")
    return ""


def copy_attr(el: int, name: str) -> int | None:
    key = cfstr(name)
    out = ctypes.c_void_p()
    err = ax.AXUIElementCopyAttributeValue(el, key, ctypes.byref(out))
    cf.CFRelease(key)
    return out.value if err == 0 else None


def read_str_attr(el: int, name: str) -> str:
    ref = copy_attr(el, name)
    if not ref:
        return ""
    try:
        return py_str(ref)
    finally:
        cf.CFRelease(ref)


def set_attr(el: int, name: str, val_ref: int | ctypes.c_void_p) -> int:
    key = cfstr(name)
    try:
        return int(ax.AXUIElementSetAttributeValue(el, key, val_ref))
    finally:
        cf.CFRelease(key)


def set_str_attr(el: int, name: str, text: str) -> int:
    val = cfstr(text)
    try:
        return set_attr(el, name, val)
    finally:
        cf.CFRelease(val)


def perform_action(el: int, action_name: str) -> int:
    act = cfstr(action_name)
    try:
        return int(ax.AXUIElementPerformAction(el, act))
    finally:
        cf.CFRelease(act)


def clean_draft(raw: str) -> str:
    s = (raw or "").strip()
    return "" if s == PLACEHOLDER else s


def find_antigravity_pid() -> int | None:
    try:
        out = subprocess.check_output(
            ["/usr/bin/lsappinfo", "info", "-only", "pid", "com.google.antigravity"],
            text=True,
            timeout=2,
        )
        m = re.search(r"pid\s*=\s*(\d+)", out)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return None


def ordered_windows(app_ref: int, title_hint: str, ws_hint: str) -> list[int]:
    wins_ref = copy_attr(app_ref, "AXWindows")
    if not wins_ref:
        return []
    if cf.CFGetTypeID(wins_ref) != ARR_ID:
        cf.CFRelease(wins_ref)
        return []

    try:
        count = cf.CFArrayGetCount(wins_ref)
        if count <= 0:
            return []
        th = (title_hint or "").strip().lower()
        wh = (ws_hint or "").strip().lower()
        matched: list[int] = []
        others: list[int] = []
        for i in range(count):
            w = cf.CFArrayGetValueAtIndex(wins_ref, i)
            if not w:
                continue
            wt = read_str_attr(w, "AXTitle").lower()
            retained = int(cf.CFRetain(w))
            if (th and th[:14] in wt) or (wh and wh in wt):
                matched.append(retained)
            else:
                others.append(retained)
        return matched + others
    finally:
        cf.CFRelease(wins_ref)


def scan_window(win_ref: int) -> tuple[int | None, bool]:
    msg_el: int | None = None
    compacting = False

    def walk(el: int, depth: int = 0) -> None:
        nonlocal msg_el, compacting
        if not el or depth > 36 or (msg_el is not None and compacting):
            return
        role = read_str_attr(el, "AXRole")
        if role in ("AXStaticText", "AXButton", "AXGroup"):
            txt = f"{read_str_attr(el, 'AXValue')} {read_str_attr(el, 'AXTitle')}".strip()
            if txt.startswith("Compacting") or "Compacting ·" in txt:
                compacting = True
        elif role == "AXTextArea" and msg_el is None:
            desc = read_str_attr(el, "AXDescription")
            title = read_str_attr(el, "AXTitle")
            if desc == "Message input" or title == "Message input":
                msg_el = int(cf.CFRetain(el))

        children_ref = copy_attr(el, "AXChildren")
        if children_ref:
            try:
                if cf.CFGetTypeID(children_ref) == ARR_ID:
                    cnt = min(cf.CFArrayGetCount(children_ref), 250)
                    for i in range(cnt):
                        child = cf.CFArrayGetValueAtIndex(children_ref, i)
                        walk(child, depth + 1)
                        if msg_el is not None and compacting:
                            break
            finally:
                cf.CFRelease(children_ref)

    walk(win_ref, 0)
    return msg_el, compacting


def locate_composer(app_ref: int, title_hint: str, ws_hint: str) -> tuple[str, int | None, bool]:
    """Locate Message input across windows, retrying briefly if Electron AX tree is waking up."""
    for attempt in range(4):
        wins = ordered_windows(app_ref, title_hint, ws_hint)
        try:
            for w in wins:
                win_title = read_str_attr(w, "AXTitle")
                msg_el, compacting = scan_window(w)
                if compacting or msg_el is not None:
                    return win_title, msg_el, compacting
        finally:
            for w in wins:
                cf.CFRelease(w)
        if attempt < 3:
            time.sleep(0.12)
    return "", None, False


def post_unicode_text(pid: int, text: str) -> None:
    for ch in text:
        u16 = ch.encode("utf-16-le")
        units = (ctypes.c_uint16 * (len(u16) // 2)).from_buffer_copy(u16)
        down = cg.CGEventCreateKeyboardEvent(None, 0, True)
        up = cg.CGEventCreateKeyboardEvent(None, 0, False)
        cg.CGEventKeyboardSetUnicodeString(down, len(units), units)
        cg.CGEventKeyboardSetUnicodeString(up, len(units), units)
        cg.CGEventPostToPid(pid, down)
        cg.CGEventPostToPid(pid, up)
        cf.CFRelease(down)
        cf.CFRelease(up)
        time.sleep(0.008)


def post_return(pid: int) -> None:
    down = cg.CGEventCreateKeyboardEvent(None, KEYCODE_RETURN, True)
    up = cg.CGEventCreateKeyboardEvent(None, KEYCODE_RETURN, False)
    cg.CGEventPostToPid(pid, down)
    cg.CGEventPostToPid(pid, up)
    cf.CFRelease(down)
    cf.CFRelease(up)


def emit(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0


def main() -> int:
    dry_run = "--dry-run" in sys.argv[1:]
    if not ax.AXIsProcessTrusted():
        return emit({"ok": False, "reason": "请在系统设置 → 隐私与安全性 → 辅助功能中授予 Antigravity 权限"})

    payload = {}
    if not sys.stdin.isatty():
        try:
            raw = sys.stdin.read().strip()
            if raw:
                payload = json.loads(raw)
        except Exception:
            payload = {}

    pid = find_antigravity_pid()
    if not pid:
        return emit({"ok": False, "reason": "未找到运行中的 Antigravity 客户端进程"})

    app_ref = ax.AXUIElementCreateApplication(pid)
    if not app_ref:
        return emit({"ok": False, "reason": "无法连接客户端辅助功能接口"})

    try:
        set_attr(app_ref, "AXManualAccessibility", K_CF_BOOLEAN_TRUE)
        win_title, msg_el, compacting = locate_composer(
            app_ref,
            str(payload.get("title") or ""),
            str(payload.get("workspaceName") or ""),
        )
        if compacting:
            if msg_el:
                cf.CFRelease(msg_el)
            return emit({"ok": True, "alreadyCompacting": True, "pid": pid, "windowTitle": win_title})

        if not msg_el:
            return emit({"ok": False, "reason": "当前页面未定位到对话输入框"})

        try:
            draft = clean_draft(read_str_attr(msg_el, "AXValue"))
            if draft and draft != "/compact":
                return emit({
                    "ok": False,
                    "reason": "对话输入框中有未发送的草稿内容，请先发送或清空后再点击压缩",
                })

            if dry_run:
                return emit({
                    "ok": True,
                    "dryRun": True,
                    "pid": pid,
                    "windowTitle": win_title,
                    "draft": draft,
                    "readyToCompact": True,
                })

            # Move focus out of the right-hand sidecar iframe into the chat composer
            perform_action(msg_el, "AXPress")
            set_attr(msg_el, "AXFocused", K_CF_BOOLEAN_TRUE)
            time.sleep(0.05)

            if draft != "/compact":
                set_str_attr(msg_el, "AXSelectedText", "/compact")
                time.sleep(0.06)
                if clean_draft(read_str_attr(msg_el, "AXValue")) != "/compact":
                    post_unicode_text(pid, "/compact")
                time.sleep(0.16)

            post_return(pid)
            time.sleep(0.26)

            # If first Return only accepted '/compact' from the '/' autocomplete popup, press Return once more
            rem = clean_draft(read_str_attr(msg_el, "AXValue"))
            if rem == "/compact":
                post_return(pid)
                time.sleep(0.20)

            return emit({"ok": True})
        finally:
            cf.CFRelease(msg_el)
    finally:
        cf.CFRelease(app_ref)


if __name__ == "__main__":
    raise SystemExit(main())
