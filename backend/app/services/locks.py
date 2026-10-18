"""项目完工锁：写操作的统一闸门（2026-10-17 需求）。

**为什么单独一个模块**：`project_service` 里已经 import 了 `auth_service`，
如果各个业务 service 反过来 import `project_service`，容易绕成循环依赖。
这里只依赖「模型 + 错误类型」，任何 service 都可以安全引用。

口径（用户确认）：
- 项目**完工**后默认**锁定**：所有写操作（成本/流水/往来/冲销/结算发放/库存/项目档案/删项目）先要解锁
- 解锁 = 输**登录密码**；解锁后一直有效，**直到手动「重新锁定」**（重启也保持解锁）
- 在建项目完全不看这些
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models.project import STATUS_FINISHED, Project
from ..utils.errors import NotFound, ProjectLocked


def is_locked(project: Project) -> bool:
    """完工且**未解锁** → 锁定。"""
    return project.status == STATUS_FINISHED and not project.unlocked_at


def get_project_or_404(db: Session, project_id: int) -> Project:
    """取项目（不看软删除标记，锁定判断只关心存在性）。"""
    project = db.get(Project, int(project_id))
    if project is None or project.deleted:
        raise NotFound("项目不存在")
    return project


def ensure_mutable(db: Session, project_id: int) -> Project:
    """**所有写操作的统一闸门**：已完工未解锁 → 409，前端据此弹密码框。

    这条校验必须落在后端：前端藏按钮只是提示，接口仍可能被直接调用。
    """
    project = get_project_or_404(db, project_id)
    if is_locked(project):
        raise ProjectLocked(
            f"项目「{project.name}」已完工并锁定，不能修改。"
            f"如确需改动，请先输入密码解锁。",
            project.id,
        )
    return project
