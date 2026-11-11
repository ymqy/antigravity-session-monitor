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
COMPACT_DRAFTS = {"/compact", "compact"}
SEND_BUTTON_LABELS = {"send message", "send", "submit", "发送", "发送消息"}

K_CF_STRING_ENCODING_UTF8 = 0x08000100
K_CG_EVENT_SOURCE_STATE_PRIVATE = -1
K_CG_EVENT_FLAG_MASK_COMMAND = 0x100000

KEYCODE_A = 0
KEYCODE_RETURN = 36
KEYCODE_DELETE = 51

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

cg.CGEventSourceCreate.argtypes = [ctypes.c_int32]
cg.CGEventSourceCreate.restype = ctypes.c_void_p
cg.CGEventCreateKeyboardEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool]
cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
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
    s = (raw or "").replace("\ufffc", "").strip()
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
            txt = f"{read_str_attr(el, 'AXValue')} {read_str_attr(el, 'AXTitle')} {read_str_attr(el, 'AXDescription')}".strip()
            if txt.startswith("Compacting") or "Compacting ·" in txt or "Compacting conversation" in txt:
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


def locate_composer(app_ref: int, title_hint: str, ws_hint: str) -> tuple[int | None, str, int | None, bool]:
    """Locate window and Message input across windows, retrying briefly if Electron AX tree is waking up."""
    for attempt in range(4):
        wins = ordered_windows(app_ref, title_hint, ws_hint)
        chosen_win: int | None = None
        try:
            for w in wins:
                win_title = read_str_attr(w, "AXTitle")
                msg_el, compacting = scan_window(w)
                if compacting or msg_el is not None:
                    chosen_win = int(cf.CFRetain(w))
                    return chosen_win, win_title, msg_el, compacting
        finally:
            for w in wins:
                cf.CFRelease(w)
        if attempt < 3:
            time.sleep(0.12)
    return None, "", None, False


def find_send_button(msg_el: int) -> int | None:
    """Find the Chat Composer's Send button (`AXDescription == 'Send message'`) near `msg_el`."""
    root = int(cf.CFRetain(msg_el))
    for _ in range(6):
        parent = copy_attr(root, "AXParent")
        if not parent:
            break
        cf.CFRelease(root)
        root = parent

    found: int | None = None

    def walk(el: int, depth: int = 0) -> None:
        nonlocal found
        if not el or depth > 9 or found is not None:
            return
        if read_str_attr(el, "AXRole") == "AXButton":
            desc = read_str_attr(el, "AXDescription").strip().lower()
            title = read_str_attr(el, "AXTitle").strip().lower()
            if desc in SEND_BUTTON_LABELS or title in SEND_BUTTON_LABELS:
                found = int(cf.CFRetain(el))
                return
        children_ref = copy_attr(el, "AXChildren")
        if children_ref:
            try:
                if cf.CFGetTypeID(children_ref) == ARR_ID:
                    cnt = min(cf.CFArrayGetCount(children_ref), 60)
                    for i in range(cnt):
                        walk(cf.CFArrayGetValueAtIndex(children_ref, i), depth + 1)
                        if found is not None:
                            break
            finally:
                cf.CFRelease(children_ref)

    try:
        walk(root, 0)
    finally:
        cf.CFRelease(root)
    return found


def focus_composer(msg_el: int) -> None:
    perform_action(msg_el, "AXPress")
    set_attr(msg_el, "AXFocused", K_CF_BOOLEAN_TRUE)
    time.sleep(0.04)


def post_unicode_text(pid: int, text: str) -> None:
    src = cg.CGEventSourceCreate(K_CG_EVENT_SOURCE_STATE_PRIVATE)
    try:
        for ch in text:
            u16 = ch.encode("utf-16-le")
            units = (ctypes.c_uint16 * (len(u16) // 2)).from_buffer_copy(u16)
            down = cg.CGEventCreateKeyboardEvent(src, 0, True)
            up = cg.CGEventCreateKeyboardEvent(src, 0, False)
            cg.CGEventSetFlags(down, 0)
            cg.CGEventSetFlags(up, 0)
            cg.CGEventKeyboardSetUnicodeString(down, len(units), units)
            cg.CGEventKeyboardSetUnicodeString(up, len(units), units)
            cg.CGEventPostToPid(pid, down)
            cg.CGEventPostToPid(pid, up)
            cf.CFRelease(down)
            cf.CFRelease(up)
            time.sleep(0.008)
    finally:
        if src:
            cf.CFRelease(src)


def post_key(pid: int, keycode: int, flags: int = 0) -> None:
    src = cg.CGEventSourceCreate(K_CG_EVENT_SOURCE_STATE_PRIVATE)
    try:
        down = cg.CGEventCreateKeyboardEvent(src, keycode, True)
        up = cg.CGEventCreateKeyboardEvent(src, keycode, False)
        cg.CGEventSetFlags(down, flags)
        cg.CGEventSetFlags(up, flags)
        cg.CGEventPostToPid(pid, down)
        cg.CGEventPostToPid(pid, up)
        cf.CFRelease(down)
        cf.CFRelease(up)
    finally:
        if src:
            cf.CFRelease(src)


def post_return(pid: int) -> None:
    post_key(pid, KEYCODE_RETURN, 0)


def clear_composer_input(pid: int, msg_el: int) -> None:
    """Roll back any unsubmitted `/compact` text/chip so the user's input box stays clean."""
    focus_composer(msg_el)
    post_key(pid, KEYCODE_A, K_CG_EVENT_FLAG_MASK_COMMAND)
    time.sleep(0.03)
    post_key(pid, KEYCODE_DELETE, 0)
    time.sleep(0.03)
    post_key(pid, KEYCODE_DELETE, 0)
    time.sleep(0.04)
    set_str_attr(msg_el, "AXValue", "")


def check_composer_state(win_ref: int, fallback_msg_el: int) -> tuple[bool, str, int]:
    """Return `(compacting, clean_remaining_draft, retained_msg_el)`."""
    fresh_msg, compacting = scan_window(win_ref)
    active_msg = fresh_msg if fresh_msg is not None else int(cf.CFRetain(fallback_msg_el))
    rem = clean_draft(read_str_attr(active_msg, "AXValue"))
    return compacting, rem, active_msg


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
        win_ref, win_title, msg_el, compacting = locate_composer(
            app_ref,
            str(payload.get("title") or ""),
            str(payload.get("workspaceName") or ""),
        )
        try:
            if compacting:
                return emit({"ok": True, "alreadyCompacting": True, "pid": pid, "windowTitle": win_title})

            if not win_ref or not msg_el:
                return emit({"ok": False, "reason": "当前页面未定位到对话输入框"})

            draft = clean_draft(read_str_attr(msg_el, "AXValue"))
            if draft and draft not in COMPACT_DRAFTS:
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

            # Step 1: Focus composer and enter `/compact` if not already staged as `/compact` or `compact` chip
            focus_composer(msg_el)
            if draft not in COMPACT_DRAFTS:
                post_unicode_text(pid, "/compact")
                time.sleep(0.18)

            # Step 2: First Return (accepts `/compact` chip from `/` autocomplete menu -> AXValue becomes `'compact '`,
            # or submits immediately if already a chip / no popup)
            if draft != "compact":
                post_return(pid)
                time.sleep(0.20)

            # Step 3: When first Return accepted the autocomplete item into `'compact '` (`clean_draft == 'compact'`),
            # re-focus the composer and press Return once more to actually execute compaction.
            comp_now, rem, cur_msg = check_composer_state(win_ref, msg_el)
            try:
                if not comp_now and rem in COMPACT_DRAFTS:
                    focus_composer(cur_msg)
                    post_return(pid)
                    time.sleep(0.22)
            finally:
                cf.CFRelease(cur_msg)

            # Step 4: Fallback — if `/compact` chip is still unsubmitted, press composer's `Send message` AXButton directly
            comp_now, rem, cur_msg = check_composer_state(win_ref, msg_el)
            try:
                if not comp_now and rem in COMPACT_DRAFTS:
                    send_btn = find_send_button(cur_msg)
                    if send_btn:
                        try:
                            perform_action(send_btn, "AXPress")
                            time.sleep(0.24)
                        finally:
                            cf.CFRelease(send_btn)
            finally:
                cf.CFRelease(cur_msg)

            # Step 5: Verify submission actually cleared the input or started `"Compacting"`
            for _ in range(4):
                comp_now, rem, cur_msg = check_composer_state(win_ref, msg_el)
                cf.CFRelease(cur_msg)
                if comp_now or rem not in COMPACT_DRAFTS:
                    return emit({"ok": True, "compacting": comp_now})
                time.sleep(0.12)

            # Step 6: Never leave `/compact` stranded in the input box if composer refused submission
            _, _, cleanup_msg = check_composer_state(win_ref, msg_el)
            try:
                clear_composer_input(pid, cleanup_msg)
            finally:
                cf.CFRelease(cleanup_msg)
            return emit({
                "ok": False,
                "reason": "当前会话暂无法执行 /compact（请确认本轮回复已停止后再点击压缩）",
            })
        finally:
            if msg_el:
                cf.CFRelease(msg_el)
            if win_ref:
                cf.CFRelease(win_ref)
    finally:
        cf.CFRelease(app_ref)


if __name__ == "__main__":
    raise SystemExit(main())
