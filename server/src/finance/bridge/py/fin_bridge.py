#!/usr/bin/env python3
"""
M34 金融 Python 桥（固定脚本 + JSON 协议；由 server 侧 bridge/runner.ts 调用）。

用法:
    python fin_bridge.py <task>
    stdin  <- {"params": {...}}
    stdout -> {"ok": true, "data": ...} | {"ok": false, "code": "...", "message": "...", "detail": "..."}
    stderr -> 日志（调试信息，不污染协议）

任务（TASKS 注册表）:
    capabilities  Python / 包状态（与 Node 侧独立探测冗余校验）
    quote         实时快照（akshare；codes 过滤 / 缺省全市场——筛选底表兜底）
    kline         历史 K 线（日/周/月/分钟 + 复权；engine: baostock 缺省 / akshare 兜底）
    calendar      交易日历（engine: baostock 缺省 / akshare 兜底）
    fundamentals  季频财务（engine: baostock 缺省 / akshare 兜底）
    indicators    ta 技术指标（MA/EMA/MACD/RSI/BOLL/ATR + 自研 KDJ，口径与 Node 兜底库对齐）
    fund_profile  akshare 基金净值走势
    news          akshare 个股新闻（东方财富）
    export_table  tablib 表格导出（csv/json/xlsx）

安全: 仅供 server 固定调用；参数白名单校验；无文件写入（导出内容以文本/Base64 返回）。
反爬: curl_cffi 可用时接管 requests（TLS 指纹模拟 Chrome；FIN_BRIDGE_IMPERSONATE=0 关闭）。
"""

import base64
import calendar as _calendar
import json
import os
import sys
import traceback
from datetime import datetime, timedelta

# 尽早锁定 UTF-8 IO（Node 侧亦会设置 PYTHONIOENCODING 双保险）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


# ---------------------------------------------------------------- 协议基础


class BridgeError(Exception):
    """带错误码的桥异常（code 与 Node 侧 BridgeErrorCode 对齐）。"""

    def __init__(self, code: str, message: str, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()


def ok(data) -> dict:
    return {"ok": True, "data": data}


def fail(code: str, message: str, detail: str = "") -> dict:
    return {"ok": False, "code": code, "message": message, "detail": (detail or "")[-2000:]}


def log(message: str) -> None:
    print(f"[fin_bridge] {message}", file=sys.stderr)


# ---------------------------------------------------------------- 反爬增强（curl_cffi TLS 指纹）


_IMPERSONATE_TRIED = False
_IMPERSONATE_ON = False


def install_impersonate() -> bool:
    """
    用 curl_cffi 接管标准 requests（impersonate=chrome：TLS/JA3 指纹模拟真实浏览器）。
    任何失败静默回退原生 requests（akshare 等库内部 `import requests` 后属性访问即命中）。

    接管策略（兼容 akshare）：
    - 模块级 get / post / head 直接换 curl_cffi 实现；
    - `requests.Session` 换为 requests 原生 Session 的**子类**（保留 mount / headers / cookies
      等外观），仅把 `request()` 委派给 curl_cffi —— 直接替换为 creq.Session 会缺 `mount`
      导致 akshare 的 request_with_retry（mount 适配器）抛 AttributeError；
    - curl_cffi 异常归一为 `requests.RequestException`，保住 akshare 自带重试语义。
    """
    if os.environ.get("FIN_BRIDGE_IMPERSONATE", "1") == "0":
        return False
    try:
        from curl_cffi import requests as creq  # type: ignore
        import requests as std  # type: ignore
    except Exception:
        return False
    try:
        def _wrap(fn):
            def wrapped(*args, **kwargs):
                kwargs.setdefault("impersonate", "chrome")
                kwargs.setdefault("timeout", 20)
                return fn(*args, **kwargs)

            return wrapped

        # requests kwargs 白名单（curl_cffi 不认识 hooks / cert 之外的自定义键）
        pass_keys = frozenset(
            ("params", "data", "json", "headers", "cookies", "auth", "timeout", "allow_redirects", "proxies", "verify", "stream")
        )

        class _ImpersonateSession(std.Session):
            """requests.Session 兼容外观；实际请求经 curl_cffi（Chrome TLS 指纹）。"""

            def request(self, method, url, **kwargs):  # type: ignore[override]
                forward = {key: value for key, value in kwargs.items() if key in pass_keys}
                forward.setdefault("timeout", 20)
                headers = dict(self.headers)
                extra = forward.pop("headers", None)
                if extra:
                    headers.update(extra)
                if self.cookies:
                    forward.setdefault("cookies", self.cookies.get_dict())
                try:
                    return creq.request(method, url, impersonate="chrome", headers=headers, **forward)
                except Exception as exc:  # 归一异常类型：akshare 只重试 requests.RequestException
                    raise std.RequestException(f"curl_cffi 请求失败（{type(exc).__name__}）：{exc}") from exc

        std.get = _wrap(creq.get)
        std.post = _wrap(creq.post)
        std.head = _wrap(creq.head)
        std.Session = _ImpersonateSession  # type: ignore[misc]
        log("curl_cffi impersonate（chrome）已接管 requests（Session 子类兼容 mount）")
        return True
    except Exception as exc:  # pragma: no cover - 兼容性兜底
        log(f"curl_cffi 接管失败，回退原生 requests: {exc}")
        return False


def ensure_impersonate() -> bool:
    """幂等地安装反爬接管（首次网络任务前调用）。"""
    global _IMPERSONATE_TRIED, _IMPERSONATE_ON
    if not _IMPERSONATE_TRIED:
        _IMPERSONATE_TRIED = True
        _IMPERSONATE_ON = install_impersonate()
    return _IMPERSONATE_ON


# ---------------------------------------------------------------- 包与参数助手


def require(name: str, what: str):
    try:
        return __import__(name)
    except Exception as exc:
        raise BridgeError("DEP_MISSING", f"缺少 Python 包 {name}（用于{what}）", f"pip install {name}; {exc}")


def param_str(params: dict, key: str, default: str = "") -> str:
    value = params.get(key)
    if value is None:
        return default
    if not isinstance(value, str):
        raise BridgeError("BAD_PARAM", f"参数 {key} 必须是字符串")
    return value.strip()


def param_int(params: dict, key: str, default: int) -> int:
    value = params.get(key)
    if value is None:
        return default
    try:
        return int(value)
    except Exception:
        raise BridgeError("BAD_PARAM", f"参数 {key} 必须是整数")


def _num(value):
    """宽松数值转换（None / '' / '--' / NaN → None；返回 float）。"""
    if value is None or value == "" or value == "--":
        return None
    try:
        result = float(value)
    except Exception:
        return None
    if result != result:  # NaN
        return None
    return result


def _or0(value) -> float:
    number = _num(value)
    return number if number is not None else 0.0


def _clean_value(value):
    """JSON 安全清洗（numpy 数值 / date → 原生类型；NaN → None）。"""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    number = _num(value)
    if number is not None:
        return number
    return str(value)


def _clean_row(row: dict) -> dict:
    return {str(key): _clean_value(value) for key, value in row.items()}


def _cn_ms(date_str, time_str: str = "") -> int:
    """'yyyy-MM-dd'（或 date 对象）＋ 可选 'HH:MM:SS' → 北京时间毫秒时间戳。"""
    text = str(date_str or "").strip()
    if " " in text:
        text, extra = text.split(" ", 1)
        if not time_str:
            time_str = extra
    digits = text.replace("-", "").replace("/", "")
    if len(digits) < 8:
        raise BridgeError("SOURCE_ERROR", f"无法解析日期：{date_str}")
    hh = mm = ss = 0
    clock = str(time_str or "").replace(":", "").strip()
    if len(clock) >= 6:
        hh, mm, ss = int(clock[0:2]), int(clock[2:4]), int(clock[4:6])
    utc = _calendar.timegm((int(digits[0:4]), int(digits[4:6]), int(digits[6:8]), hh, mm, ss))
    return (utc - 8 * 3600) * 1000


# ---------------------------------------------------------------- baostock 任务


FREQ_MAP = {"day": "d", "week": "w", "month": "m", "min5": "5", "min15": "15", "min30": "30", "min60": "60"}
ADJ_MAP = {"qfq": "2", "hfq": "1", "none": "3"}

# 分钟线频度：仅这些周期允许包含 time 字段（服务端校验，日/周/月线传 time 会报
# 「xx线指标参数传入错误:time」整链降级）
_MINUTE_FREQS = ("5", "15", "30", "60")
# 默认取数窗口（天；按周期给足，覆盖网关 limit 上限 500 根后由 Node 侧切片）：
# 日线 ~730 交易日 / 周线 ~520 周 / 月线 ~360 月
_BS_WINDOW_DAYS = {"d": 365 * 3, "w": 365 * 10, "m": 365 * 30}


def bs_kline_fields(frequency: str) -> str:
    """baostock K 线字段白名单：time 仅分钟线可用（日/周/月线含 time → 10004012 报错）。"""
    if frequency in _MINUTE_FREQS:
        return "date,time,code,open,high,low,close,volume,amount"
    return "date,code,open,high,low,close,volume,amount"


def normalize_code(raw: str) -> str:
    """sh600519 / 600519.SH / sh.600519 / 600519 → sh.600519（baostock 格式）"""
    s = (raw or "").strip().lower()
    if "." in s:
        parts = s.split(".")
        if len(parts) == 2:
            a, b = parts
            if a.isdigit():
                return f"{b}.{a}"
            return f"{a}.{b}"
    s = s.replace(".", "")
    for prefix in ("sh", "sz", "bj"):
        if s.startswith(prefix):
            return f"{prefix}.{s[len(prefix):]}"
    if s.isdigit() and len(s) == 6:
        if s[0] in ("6", "9"):
            return f"sh.{s}"
        if s[0] in ("4", "8"):
            return f"bj.{s}"
        return f"sz.{s}"
    return s


def parse_bs_timestamp(date_str: str, time_str: str = "") -> int:
    """baostock date('yyyy-MM-dd') + time('yyyyMMddHHmmssSSS') → 北京时间毫秒时间戳。"""
    ds = (date_str or "").replace("-", "")
    if len(ds) < 8:
        raise BridgeError("SOURCE_ERROR", f"无法解析 baostock 日期：{date_str}")
    y, m, d = int(ds[0:4]), int(ds[4:6]), int(ds[6:8])
    hh = mm = ss = 0
    if time_str and len(time_str) >= 14:
        hh, mm, ss = int(time_str[8:10]), int(time_str[10:12]), int(time_str[12:14])
    utc = _calendar.timegm((y, m, d, hh, mm, ss))
    return (utc - 8 * 3600) * 1000


def bs_login(bs) -> None:
    result = bs.login()
    if getattr(result, "error_code", "1") != "0":
        raise BridgeError("LOGIN_FAIL", f"baostock 登录失败：{getattr(result, 'error_msg', '未知错误')}")


def bs_rows(rs) -> list:
    rows = []
    while rs.error_code == "0" and rs.next():
        rows.append(dict(zip(rs.fields, rs.get_row_data())))
    if rs.error_code != "0":
        raise BridgeError("SOURCE_ERROR", f"baostock 查询失败：{rs.error_msg}")
    return rows


def task_kline(params: dict) -> dict:
    engine = (param_str(params, "engine", "baostock") or "baostock").lower()
    if engine == "akshare":
        return _kline_akshare(params)
    if engine != "baostock":
        raise BridgeError("BAD_PARAM", f"不支持的引擎：{engine}（支持 baostock / akshare）")
    return _kline_baostock(params)


def _kline_baostock(params: dict) -> dict:
    bs = require("baostock", "K 线（baostock）")
    code = normalize_code(param_str(params, "code"))
    if not code:
        raise BridgeError("BAD_PARAM", "kline 需要 code 参数")
    period = param_str(params, "period", "day") or "day"
    adjust = param_str(params, "adjust", "qfq") or "qfq"
    frequency = FREQ_MAP.get(period)
    adjustflag = ADJ_MAP.get(adjust)
    if frequency is None:
        raise BridgeError("BAD_PARAM", f"不支持的周期：{period}（支持 {', '.join(FREQ_MAP)}）")
    if adjustflag is None:
        raise BridgeError("BAD_PARAM", f"不支持的复权：{adjust}（支持 {', '.join(ADJ_MAP)}）")
    end = param_str(params, "end") or datetime.now().strftime("%Y-%m-%d")
    start = param_str(params, "start")
    if not start:
        days = _BS_WINDOW_DAYS.get(frequency, 30)
        start = (datetime.strptime(end, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")

    bs_login(bs)
    try:
        rs = bs.query_history_k_data_plus(
            code,
            bs_kline_fields(frequency),
            start_date=start,
            end_date=end,
            frequency=frequency,
            adjustflag=adjustflag,
        )
        bars = []
        for row in bs_rows(rs):
            if not row.get("close"):
                continue
            bars.append(
                {
                    "timestamp": parse_bs_timestamp(row.get("date", ""), row.get("time", "")),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["volume"]) / 100.0 if row.get("volume") else 0.0,
                    "turnover": float(row["amount"]) if row.get("amount") else 0.0,
                }
            )
    finally:
        bs.logout()
    return {
        "code": code,
        "period": period,
        "adjust": adjust,
        "start": start,
        "end": end,
        "bars": bars,
        "engine": "baostock",
    }


_AK_PERIOD = {"day": "daily", "week": "weekly", "month": "monthly"}
_AK_ADJUST = {"qfq": "qfq", "hfq": "hfq", "none": ""}
# akshare 日/周/月默认窗口（天；与 _BS_WINDOW_DAYS 同口径，覆盖 limit 500 根）
_AK_WINDOW_DAYS = {"daily": 365 * 3, "weekly": 365 * 10, "monthly": 365 * 30}


def _kline_akshare(params: dict) -> dict:
    ensure_impersonate()
    ak = require("akshare", "K 线（akshare 兜底）")
    code = param_str(params, "code")
    digits = code.split(".")[-1][-6:]
    if not (digits.isdigit() and len(digits) == 6):
        raise BridgeError("BAD_PARAM", f"K 线代码应为 6 位数字：{code or '(空)'}")
    period = param_str(params, "period", "day") or "day"
    adjust = param_str(params, "adjust", "qfq") or "qfq"
    adj = _AK_ADJUST.get(adjust)
    if adj is None:
        raise BridgeError("BAD_PARAM", f"不支持的复权：{adjust}（支持 {', '.join(_AK_ADJUST)}）")
    end = param_str(params, "end") or datetime.now().strftime("%Y-%m-%d")
    start = param_str(params, "start")
    bars = []
    try:
        if period in _AK_PERIOD:
            if not start:
                days = _AK_WINDOW_DAYS.get(_AK_PERIOD[period], 365 * 3)
                start = (datetime.strptime(end, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")
            frame = ak.stock_zh_a_hist(
                symbol=digits,
                period=_AK_PERIOD[period],
                start_date=start.replace("-", ""),
                end_date=end.replace("-", ""),
                adjust=adj,
            )
            for row in frame.to_dict("records"):
                close = _num(row.get("收盘"))
                if close is None:
                    continue
                bars.append(
                    {
                        "timestamp": _cn_ms(row.get("日期")),
                        "open": _or0(row.get("开盘")),
                        "high": _or0(row.get("最高")),
                        "low": _or0(row.get("最低")),
                        "close": close,
                        "volume": _or0(row.get("成交量")),
                        "turnover": _or0(row.get("成交额")),
                    }
                )
        elif period in FREQ_MAP and period.startswith("min"):
            if not start:
                start = (datetime.strptime(end, "%Y-%m-%d") - timedelta(days=30)).strftime("%Y-%m-%d")
            frame = ak.stock_zh_a_hist_min_em(
                symbol=digits,
                period=FREQ_MAP[period],
                adjust=adj,
                start_date=f"{start} 09:00:00",
                end_date=f"{end} 15:00:00",
            )
            for row in frame.to_dict("records"):
                close = _num(row.get("收盘"))
                if close is None:
                    continue
                bars.append(
                    {
                        "timestamp": _cn_ms(row.get("时间")),
                        "open": _or0(row.get("开盘")),
                        "high": _or0(row.get("最高")),
                        "low": _or0(row.get("最低")),
                        "close": close,
                        "volume": _or0(row.get("成交量")),
                        "turnover": _or0(row.get("成交额")),
                    }
                )
        else:
            raise BridgeError("BAD_PARAM", f"不支持的周期：{period}（支持 {', '.join(FREQ_MAP)}）")
    except BridgeError:
        raise
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取 K 线失败：{exc}")
    return {
        "code": code,
        "period": period,
        "adjust": adjust,
        "start": start,
        "end": end,
        "bars": bars,
        "engine": "akshare",
    }


def task_calendar(params: dict) -> dict:
    engine = (param_str(params, "engine", "baostock") or "baostock").lower()
    year = param_int(params, "year", datetime.now().year)
    start = param_str(params, "start") or f"{year}-01-01"
    end = param_str(params, "end") or f"{year}-12-31"
    if engine == "akshare":
        return _calendar_akshare(start, end)
    if engine != "baostock":
        raise BridgeError("BAD_PARAM", f"不支持的引擎：{engine}（支持 baostock / akshare）")
    bs = require("baostock", "交易日历（baostock）")
    bs_login(bs)
    try:
        rs = bs.query_trade_dates(start_date=start, end_date=end)
        rows = bs_rows(rs)
    finally:
        bs.logout()
    days = [r.get("calendar_date") for r in rows if r.get("is_trading_day") == "1"]
    return {"start": start, "end": end, "days": days, "engine": "baostock"}


def _calendar_akshare(start: str, end: str) -> dict:
    ensure_impersonate()
    ak = require("akshare", "交易日历（akshare 兜底）")
    try:
        frame = ak.tool_trade_date_hist_sina()
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取交易日历失败：{exc}")
    days = []
    for row in frame.to_dict("records"):
        text = str(row.get("trade_date"))[:10]
        if len(text) == 10 and start <= text <= end:
            days.append(text)
    return {"start": start, "end": end, "days": days, "engine": "akshare"}


def task_fundamentals(params: dict) -> dict:
    engine = (param_str(params, "engine", "baostock") or "baostock").lower()
    code_raw = param_str(params, "code")
    if not code_raw:
        raise BridgeError("BAD_PARAM", "fundamentals 需要 code 参数")
    if engine == "akshare":
        return _fundamentals_akshare(code_raw)
    if engine != "baostock":
        raise BridgeError("BAD_PARAM", f"不支持的引擎：{engine}（支持 baostock / akshare）")
    bs = require("baostock", "季频财务（baostock）")
    code = normalize_code(code_raw)
    year = param_int(params, "year", datetime.now().year)
    quarter = param_int(params, "quarter", (datetime.now().month - 1) // 3 + 1)
    if quarter not in (1, 2, 3, 4):
        raise BridgeError("BAD_PARAM", f"季度应为 1-4：{quarter}")
    bs_login(bs)
    try:
        rs = bs.query_profit_data(code=code, year=year, quarter=quarter)
        rows = bs_rows(rs)
    finally:
        bs.logout()
    return {"code": code, "year": year, "quarter": quarter, "rows": rows, "engine": "baostock"}


def _fundamentals_akshare(code_raw: str) -> dict:
    ensure_impersonate()
    ak = require("akshare", "财务数据（akshare 兜底）")
    digits = str(code_raw).split(".")[-1][-6:]
    if not (digits.isdigit() and len(digits) == 6):
        raise BridgeError("BAD_PARAM", f"财务代码应为 6 位数字：{code_raw}")
    try:
        frame = ak.stock_financial_abstract(symbol=digits)
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取财务数据失败：{exc}")
    rows = [_clean_row(row) for row in frame.to_dict("records")[:60]]
    return {"code": digits, "rows": rows, "engine": "akshare"}


# ---------------------------------------------------------------- 技术指标任务（ta + 自研 KDJ）


def _kdj_points(points: list, close: list, high: list, low: list, p: dict) -> None:
    """KDJ(9,3,3)：RSV 的 SMA(3,1) 递归（与中国软件口径一致）。"""
    n = int(p.get("n") or 9)
    k_prev = d_prev = None
    for i in range(len(close)):
        k = d = j = None
        if i >= n - 1:
            hh = max(high[i - n + 1 : i + 1])
            ll = min(low[i - n + 1 : i + 1])
            rsv = 50.0 if hh == ll else (close[i] - ll) / (hh - ll) * 100.0
            k_prev = rsv if k_prev is None else (rsv + 2.0 * k_prev) / 3.0
            d_prev = k_prev if d_prev is None else (k_prev + 2.0 * d_prev) / 3.0
            k, d, j = k_prev, d_prev, 3.0 * k_prev - 2.0 * d_prev
        points[i]["values"].update({"K": k, "D": d, "J": j})


def task_indicators(params: dict) -> dict:
    pd = require("pandas", "技术指标计算（pandas）")
    require("ta", "技术指标计算（ta）")
    from ta.momentum import RSIIndicator
    from ta.trend import EMAIndicator, MACD, SMAIndicator
    from ta.volatility import AverageTrueRange, BollingerBands

    name = param_str(params, "name", "MA").upper()
    raw_params = params.get("params") or {}
    if not isinstance(raw_params, dict):
        raise BridgeError("BAD_PARAM", "params 必须是对象")
    bars = params.get("bars") or []
    if not isinstance(bars, list) or not bars:
        raise BridgeError("BAD_PARAM", "indicators 需要非空 bars 数组")

    frame = pd.DataFrame(bars)
    for column in ("timestamp", "high", "low", "close"):
        if column not in frame.columns:
            raise BridgeError("BAD_PARAM", f"bars 缺少字段 {column}")
    close = frame["close"].astype(float)
    high = frame["high"].astype(float)
    low = frame["low"].astype(float)
    points = [{"timestamp": int(t), "values": {}} for t in frame["timestamp"]]

    def put(key: str, series) -> None:
        for i, value in enumerate(series):
            points[i]["values"][key] = None if pd.isna(value) else float(value)

    if name == "MA":
        for window in (5, 10, 20, 60):
            if len(close) >= window:
                put(f"MA{window}", SMAIndicator(close=close, window=window).sma_indicator())
    elif name == "EMA":
        window = int(raw_params.get("period") or 12)
        put(f"EMA{window}", EMAIndicator(close=close, window=window).ema_indicator())
    elif name == "MACD":
        fast = int(raw_params.get("fast") or 12)
        slow = int(raw_params.get("slow") or 26)
        signal = int(raw_params.get("signal") or 9)
        macd = MACD(close=close, window_slow=slow, window_fast=fast, window_sign=signal)
        dif, dea = macd.macd_diff(), macd.macd_signal()
        put("DIF", dif)
        put("DEA", dea)
        # 中国软件口径：柱 = (DIF − DEA) × 2（ta 原生为不乘 2 的差值）
        points_bars = (dif - dea) * 2
        for i, value in enumerate(points_bars):
            points[i]["values"]["MACD"] = None if pd.isna(value) else float(value)
    elif name == "RSI":
        window = int(raw_params.get("period") or 14)
        put(f"RSI{window}", RSIIndicator(close=close, window=window).rsi())
    elif name == "BOLL":
        window = int(raw_params.get("period") or 20)
        mult = float(raw_params.get("mult") or 2)
        boll = BollingerBands(close=close, window=window, window_dev=mult)
        put("MID", boll.bollinger_mavg())
        put("UPPER", boll.bollinger_hband())
        put("LOWER", boll.bollinger_lband())
    elif name == "ATR":
        window = int(raw_params.get("period") or 14)
        put(f"ATR{window}", AverageTrueRange(high=high, low=low, close=close, window=window).average_true_range())
    elif name == "KDJ":
        _kdj_points(points, close.tolist(), high.tolist(), low.tolist(), raw_params)
    else:
        raise BridgeError("BAD_PARAM", f"不支持的指标：{name}")

    return {"name": name, "params": raw_params, "points": points, "signals": []}


# ---------------------------------------------------------------- akshare 任务


def task_quote(params: dict) -> dict:
    """实时快照（akshare 全市场 → codes 过滤；codes 缺省/空 = 全市场，筛选底表兜底）。"""
    ensure_impersonate()
    ak = require("akshare", "实时快照（akshare）")
    codes = params.get("codes") or []
    if not isinstance(codes, list):
        raise BridgeError("BAD_PARAM", "codes 必须是数组")
    wanted = set()
    for item in codes:
        digits = str(item).split(".")[-1][-6:]
        if digits.isdigit() and len(digits) == 6:
            wanted.add(digits)
    try:
        frame = ak.stock_zh_a_spot_em()
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取快照失败：{exc}")
    items = []
    for row in frame.to_dict("records"):
        code = str(row.get("代码") or "").zfill(6)
        if wanted and code not in wanted:
            continue
        price = _num(row.get("最新价"))
        if price is None:
            continue
        items.append(
            {
                "code": code,
                "name": str(row.get("名称") or ""),
                "price": price,
                "changePct": _or0(row.get("涨跌幅")),
                "change": _or0(row.get("涨跌额")),
                "open": _or0(row.get("今开")),
                "prevClose": _or0(row.get("昨收")),
                "high": _or0(row.get("最高")),
                "low": _or0(row.get("最低")),
                "volume": _or0(row.get("成交量")),
                "turnover": _or0(row.get("成交额")),
                "turnoverRate": _num(row.get("换手率")),
                "pe": _num(row.get("市盈率-动态")),
                "pb": _num(row.get("市净率")),
                "marketCap": _num(row.get("总市值")),
                "floatMarketCap": _num(row.get("流通市值")),
            }
        )
    if wanted and not items:
        raise BridgeError("SOURCE_ERROR", f"akshare 快照未匹配到代码：{', '.join(sorted(wanted))}")
    return {"items": items}


def task_fund_profile(params: dict) -> dict:
    ensure_impersonate()
    ak = require("akshare", "基金数据（akshare）")
    code = param_str(params, "code")
    if not (code.isdigit() and len(code) == 6):
        raise BridgeError("BAD_PARAM", f"基金代码应为 6 位数字：{code or '(空)'}")
    try:
        frame = ak.fund_open_fund_info_em(symbol=code, indicator="单位净值走势")
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取基金净值失败：{exc}")
    points = []
    for row in frame.to_dict("records"):
        nav = _num(row.get("单位净值"))
        if nav is None:
            continue
        points.append(
            {
                "date": str(row.get("净值日期"))[:10],
                "nav": nav,
                "changePct": _num(row.get("日增长率")),
            }
        )
    return {"code": code, "points": points, "engine": "akshare"}


def task_news(params: dict) -> dict:
    ensure_impersonate()
    ak = require("akshare", "个股新闻（akshare）")
    code = param_str(params, "code")
    if not code:
        raise BridgeError("BAD_PARAM", "news 需要 code 参数")
    limit = max(1, min(param_int(params, "limit", 20), 100))
    try:
        frame = ak.stock_news_em(symbol=code)
    except Exception as exc:
        raise BridgeError("SOURCE_ERROR", f"akshare 获取个股新闻失败：{exc}")
    items = []
    for row in frame.to_dict("records")[:limit]:
        items.append(
            {
                "title": str(row.get("新闻标题") or ""),
                "url": str(row.get("新闻链接") or ""),
                "source": str(row.get("文章来源") or "东方财富"),
                "publishedAt": str(row.get("发布时间") or ""),
                "summary": str(row.get("新闻内容") or "")[:200],
            }
        )
    return {"code": code, "items": items}


# ---------------------------------------------------------------- tablib 导出任务


def task_export_table(params: dict) -> dict:
    tablib = require("tablib", "表格导出（tablib）")
    fmt = param_str(params, "format", "csv").lower()
    headers = [str(h) for h in (params.get("headers") or [])]
    rows = params.get("rows") or []
    if not isinstance(rows, list):
        raise BridgeError("BAD_PARAM", "rows 必须是二维数组")
    data = tablib.Dataset(*[list(r) for r in rows], headers=headers or None)
    if fmt == "csv":
        return {"format": "csv", "encoding": "utf8", "content": data.export("csv")}
    if fmt == "json":
        return {"format": "json", "encoding": "utf8", "content": data.export("json")}
    if fmt == "xlsx":
        require("openpyxl", "XLSX 导出（openpyxl）")
        payload = data.export("xlsx")
        return {"format": "xlsx", "encoding": "base64", "content": base64.b64encode(payload).decode("ascii")}
    raise BridgeError("BAD_PARAM", f"不支持的导出格式：{fmt}（支持 csv / json / xlsx）")


# ---------------------------------------------------------------- 环境状态任务


def task_capabilities(_params: dict) -> dict:
    import importlib.util as iu
    try:
        import importlib.metadata as md
    except Exception:
        md = None

    def version(name: str):
        if md is None:
            return None
        try:
            return md.version(name)
        except Exception:
            return None

    def installed(name: str) -> bool:
        try:
            return iu.find_spec(name) is not None
        except Exception:
            return False

    names = ["baostock", "akshare", "pandas", "ta", "tablib", "openpyxl", "curl_cffi"]
    packages = {n: {"installed": installed(n), "version": version(n)} for n in names}
    missing = [n for n in ("baostock", "akshare", "pandas", "ta", "tablib") if not packages[n]["installed"]]
    level = "absent" if len(missing) == 5 else ("partial" if missing else "ready")
    return {
        "level": level,
        "python": sys.executable,
        "version": ".".join(map(str, sys.version_info[:3])),
        "packages": packages,
        "missing": missing,
        "impersonate": bool(packages["curl_cffi"]["installed"]) and os.environ.get("FIN_BRIDGE_IMPERSONATE", "1") != "0",
    }


# ---------------------------------------------------------------- 入口


TASKS = {
    "capabilities": task_capabilities,
    "quote": task_quote,
    "kline": task_kline,
    "calendar": task_calendar,
    "fundamentals": task_fundamentals,
    "indicators": task_indicators,
    "fund_profile": task_fund_profile,
    "news": task_news,
    "export_table": task_export_table,
}


def main() -> None:
    task = sys.argv[1] if len(sys.argv) > 1 else ""
    raw = sys.stdin.read()
    params = {}
    if raw.strip():
        try:
            payload = json.loads(raw)
            params = payload.get("params") or {} if isinstance(payload, dict) else {}
        except Exception as exc:
            emit(fail("BAD_PARAM", f"stdin 不是合法 JSON：{exc}"))
            return
    if not isinstance(params, dict):
        emit(fail("BAD_PARAM", "params 必须是对象"))
        return
    handler = TASKS.get(task)
    if handler is None:
        emit(fail("BAD_PARAM", f"未知任务：{task or '(空)'}；支持：{', '.join(sorted(TASKS))}"))
        return
    try:
        emit(ok(handler(params)))
    except BridgeError as exc:
        emit(fail(exc.code, exc.message, exc.detail))
    except Exception as exc:  # pragma: no cover - 兜底防裸栈泄漏到 stdout
        emit(fail("SOURCE_ERROR", f"{type(exc).__name__}: {exc}", traceback.format_exc()))


if __name__ == "__main__":
    main()
