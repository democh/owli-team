#!/usr/bin/env python3
"""M34 测试用假桥：按 task 输出预设 JSON（验证 runner 协议与错误码映射，不依赖任何三方包）。"""
import json
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def main():
    task = sys.argv[1] if len(sys.argv) > 1 else ""
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}
    params = payload.get("params", {})

    if task == "echo":
        emit({"ok": True, "data": {"params": params}})
    elif task == "tick":
        time.sleep(0.15)
        emit({"ok": True, "data": {"at": time.time()}})
    elif task == "err_dep":
        emit({"ok": False, "code": "DEP_MISSING", "message": "缺少 Python 包 baostock"})
    elif task == "err_login":
        emit({"ok": False, "code": "LOGIN_FAIL", "message": "baostock 登录失败", "detail": "网络不可达"})
    elif task == "err_unknown_code":
        emit({"ok": False, "code": "SOMETHING_NEW", "message": "未知错误码应归一为 BRIDGE_ERROR"})
    elif task == "garbage":
        sys.stdout.write("this is not json at all")
    elif task == "sleep":
        time.sleep(30)
        emit({"ok": True, "data": {}})
    else:
        emit({"ok": False, "code": "BAD_PARAM", "message": "未知任务: " + task})


if __name__ == "__main__":
    main()
