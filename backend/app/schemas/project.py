"""项目出入参（docs/03-接口设计.md 第 4 节）。"""

from __future__ import annotations

from datetime import date

from pydantic import Field, field_validator

from .common import InModel, MoneyAmount, PatchModel, ProjectStatus


def _normalize_members(value: object) -> list[str] | None:
    """成员名单：支持 ["张三","李四"] 或 "张三,李四" / "张三、李四"。"""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.replace("，", ",").replace("、", ",")
        items = [part.strip() for part in text.split(",")]
    elif isinstance(value, (list, tuple)):
        items = [str(part).strip() for part in value]
    else:
        raise ValueError("项目成员名单格式不正确")
    return [item for item in items if item]


class ProjectCreate(InModel):
    name: str = Field(min_length=1, max_length=100)
    client_name: str | None = Field(default=None, max_length=100)
    location: str | None = Field(default=None, max_length=200)
    manager: str | None = Field(default=None, max_length=50)
    start_date: date | None = None
    status: ProjectStatus = "ongoing"
    client_budget: MoneyAmount = Field(ge=0)  # 甲方预算（合同额），必填 ≥ 0
    cost_budget: MoneyAmount = Field(ge=0)  # 我方成本预算，必填 ≥ 0
    members: list[str] | None = None
    remark: str | None = None

    @field_validator("members", mode="before")
    @classmethod
    def _members(cls, value: object) -> list[str] | None:
        return _normalize_members(value)


class ProjectUpdate(PatchModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    client_name: str | None = Field(default=None, max_length=100)
    location: str | None = Field(default=None, max_length=200)
    manager: str | None = Field(default=None, max_length=50)
    start_date: date | None = None
    status: ProjectStatus | None = None
    client_budget: MoneyAmount | None = Field(default=None, ge=0)
    cost_budget: MoneyAmount | None = Field(default=None, ge=0)
    members: list[str] | None = None
    remark: str | None = None

    @field_validator("members", mode="before")
    @classmethod
    def _members(cls, value: object) -> list[str] | None:
        return _normalize_members(value)

class PasswordConfirm(InModel):
    """敏感操作（撤销完工 / 解锁）要验登录密码。"""

    password: str = Field(min_length=1, max_length=64)