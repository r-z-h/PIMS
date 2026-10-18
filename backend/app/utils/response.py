"""统一响应体与全局异常处理（docs/03-接口设计.md 1.2）。

所有接口一律返回：

    {"code": 0, "message": "ok", "data": ...}

错误使用同一个信封 + 对应 code（400/401/403/404/409/500），
HTTP 状态码与信封 code 保持一致，便于 curl / 前端拦截器判断。

金额渲染：`Decimal` 直接以「数字字面量」输出并保留自身小数位
（金额两位、数量三位），不使用 float，也不会变成带引号的字符串。
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .errors import BizError

logger = logging.getLogger("pims")

MONEY_MARK_OPEN = "\x00M:"
MONEY_MARK_CLOSE = ":M\x00"

# json 会把控制字符转义成 \u0000，这里两种形态都兼容
_MONEY_RE = re.compile(r'"(\x00|\\u0000)M:([-0-9.]+):M(\x00|\\u0000)"')


def _default(obj: Any) -> Any:
    """json 兜底序列化：Decimal 打标记后由 render 还原成数字字面量。"""
    if isinstance(obj, Decimal):
        return f"{MONEY_MARK_OPEN}{format(obj, 'f')}{MONEY_MARK_CLOSE}"
    if isinstance(obj, datetime):
        return obj.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(obj, date):
        return obj.strftime("%Y-%m-%d")
    if isinstance(obj, time):
        return obj.strftime("%H:%M:%S")
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, (set, frozenset, tuple)):
        return list(obj)
    if isinstance(obj, Path):
        return str(obj)
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    raise TypeError(f"无法序列化的类型：{type(obj)!r}")


class EnvelopeJSONResponse(JSONResponse):
    """统一信封响应，金额按 Decimal 原样输出为 JSON 数字。"""

    media_type = "application/json"

    def __init__(self, content: Any = None, status_code: int = 200, headers: dict | None = None,
                 media_type: str | None = None, background: Any = None) -> None:
        super().__init__(
            content=content,
            status_code=status_code,
            headers=headers,
            media_type=media_type or self.media_type,
            background=background,
        )
        # 明确声明 UTF-8，中文 message 与 data 不会被误判编码
        self.headers["content-type"] = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        if content is None:
            return b"null"
        text = json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            default=_default,
        )
        text = _MONEY_RE.sub(r"\2", text)
        return text.encode("utf-8")


def ok(data: Any = None, message: str = "ok") -> EnvelopeJSONResponse:
    """成功响应。"""
    return EnvelopeJSONResponse({"code": 0, "message": message, "data": data})


def fail(code: int, message: str, data: Any = None) -> EnvelopeJSONResponse:
    """失败响应（HTTP 状态码与信封 code 一致）。

    data 用于携带**机器可读**的补充信息，例如项目完工锁会带
    {"reason": "project_locked", "project_id": 3}，前端据此弹密码框。
    """
    return EnvelopeJSONResponse(
        {"code": code, "message": message, "data": data},
        status_code=code,
    )


def page_data(items: list[Any] | None, total: int, page: int, page_size: int) -> dict:
    """列表接口统一数据结构（docs/03-接口设计.md 1.4）。"""
    return {
        "total": int(total),
        "page": int(page),
        "page_size": int(page_size),
        "items": items or [],
    }


def _validation_message(exc: RequestValidationError) -> str:
    """把 Pydantic 校验错误转成中文提示。"""
    errors = exc.errors()
    if not errors:
        return "参数校验失败"
    first = errors[0]
    loc = ".".join(str(part) for part in first.get("loc", ()) if part not in ("body", "query", "path"))
    msg = str(first.get("msg", "参数不合法"))
    msg = msg.replace("Field required", "为必填项").replace("Input should be a valid", "格式不正确：")
    return f"参数校验失败：{loc} {msg}".strip() if loc else f"参数校验失败：{msg}"


def register_exception_handlers(app: FastAPI) -> None:
    """注册全局异常处理器：路由里只管抛业务异常，不手工拼错误字典。"""

    @app.exception_handler(BizError)
    async def _biz_error_handler(request: Request, exc: BizError) -> EnvelopeJSONResponse:
        return fail(exc.code, exc.message, getattr(exc, "data", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_handler(request: Request, exc: RequestValidationError) -> EnvelopeJSONResponse:
        return fail(400, _validation_message(exc))

    @app.exception_handler(StarletteHTTPException)
    async def _http_handler(request: Request, exc: StarletteHTTPException) -> EnvelopeJSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "请求失败"
        return fail(int(exc.status_code), detail)

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception) -> EnvelopeJSONResponse:
        logger.exception("未处理异常 %s %s", request.method, request.url.path, exc_info=exc)
        return fail(500, "服务端异常，请查看后端日志")
