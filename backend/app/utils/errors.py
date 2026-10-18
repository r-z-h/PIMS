"""统一业务异常。

统一响应体 code 取值（docs/03-接口设计.md 1.2）：
0 成功 / 400 参数校验失败 / 401 未登录 / 403 密保或权限 / 404 对象不存在 /
409 业务冲突 / 500 服务端异常。
"""

from __future__ import annotations


class BizError(Exception):
    """业务异常：由全局异常处理器转成统一信封。

    data 可携带机器可读的补充信息（前端据此做自动处理，
    例如项目完工锁返回 {"reason": "project_locked", "project_id": 3} 时弹密码框）。
    """

    def __init__(self, code: int = 400, message: str = "参数错误", data: dict | None = None) -> None:
        super().__init__(message)
        self.code = int(code)
        self.message = message
        self.data = data


class BadRequest(BizError):
    def __init__(self, message: str = "参数错误") -> None:
        super().__init__(400, message)


class Unauthorized(BizError):
    def __init__(self, message: str = "未登录或会话已过期") -> None:
        super().__init__(401, message)


class Forbidden(BizError):
    def __init__(self, message: str = "无权限操作") -> None:
        super().__init__(403, message)


class NotFound(BizError):
    def __init__(self, message: str = "对象不存在") -> None:
        super().__init__(404, message)


class Conflict(BizError):
    def __init__(self, message: str = "业务冲突", data: dict | None = None) -> None:
        super().__init__(409, message, data)


class ProjectLocked(Conflict):
    """项目已完工并锁定：前端据此弹「输入密码解锁」。"""

    def __init__(self, message: str, project_id: int) -> None:
        super().__init__(message, data={"reason": "project_locked", "project_id": int(project_id)})


# 密保校验失败的统一口径：绝不透露是哪一题错（docs/00-需求冻结.md FR-1.3）
SECURITY_ANSWER_WRONG = "密保答案不正确"
