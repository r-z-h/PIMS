"""认证相关出入参（docs/03-接口设计.md 第 2 节）。"""

from __future__ import annotations

from pydantic import Field, field_validator

from .common import InModel


class LoginIn(InModel):
    password: str = Field(min_length=1, max_length=128)


class SecurityQA(InModel):
    question: str = Field(min_length=1, max_length=200)
    answer: str = Field(min_length=1, max_length=200)


class SecuritySetupIn(InModel):
    """首次设置密保：3 组问题 + 答案。"""

    questions: list[SecurityQA] = Field(min_length=3, max_length=3)

    @field_validator("questions")
    @classmethod
    def _check_three(cls, value: list[SecurityQA]) -> list[SecurityQA]:
        if len(value) != 3:
            raise ValueError("必须设置 3 个密保问题")
        questions = [item.question.strip() for item in value]
        if len(set(questions)) != 3:
            raise ValueError("3 个密保问题不能重复")
        return value


class SecurityVerifyIn(InModel):
    """密保校验：3 个答案，顺序与问题一致。"""

    answers: list[str] = Field(min_length=3, max_length=3)

    @field_validator("answers")
    @classmethod
    def _check_three(cls, value: list[str]) -> list[str]:
        if len(value) != 3:
            raise ValueError("必须回答 3 个密保问题")
        return value


class PasswordChangeIn(InModel):
    """改密：已登录 + 3 个密保答案全对（或等价的密保 ticket）。

    口径依据 docs/00-需求冻结.md FR-1.3「修改密码必须 3 个密保问题全部答对，无其他后门」：
    **不校验旧密码**；`old_password` 仅为兼容旧前端保留（传了也不校验）。
    """

    new_password: str = Field(min_length=4, max_length=128)
    answers: list[str] | None = Field(default=None, min_length=3, max_length=3)
    ticket: str | None = Field(default=None, max_length=200, description="密保校验票据，等价于已通过 verify")
    old_password: str | None = Field(default=None, max_length=128, description="已废弃：不校验")


class PasswordResetIn(InModel):
    """忘记密码：密保票据 + 新密码。"""

    ticket: str = Field(min_length=8, max_length=200)
    new_password: str = Field(min_length=4, max_length=128)
