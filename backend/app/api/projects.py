"""项目路由 /api/projects。"""

from __future__ import annotations

from datetime import date

from fastapi import Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.project import PasswordConfirm, ProjectCreate, ProjectUpdate
from ..services import project_service
from ..utils.money import ZERO
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import CommonQuery, make_router

router = make_router("/api/projects", "projects")


@router.get("", summary="项目列表")
def list_projects(
    status: str | None = Query(None),
    start_date: date | None = Query(None, description="日期筛选：区间开始"),
    end_date: date | None = Query(None, description="日期筛选：区间结束"),
    date_field: str | None = Query(
        None,
        description="日期按什么筛：start_date=开工日期落在区间内；activity=区间内有业务数据",
        pattern="^(start_date|activity)$",
    ),
    q: CommonQuery = Depends(),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """项目列表。

    **支持「名字 + 日期」组合筛选**（2026-10-17 用户需求）：
    - `keyword`：项目名称 / 甲方 / 负责人 / 地点 / 备注 模糊搜
    - `start_date` + `end_date` + `date_field`：
      - `start_date` → 开工日期落在区间内
      - `activity`  → 该区间内有成本/收付款/往来/入库/结算的项目
    """
    items, total = project_service.list_projects(
        db,
        status=status,
        keyword=q.keyword,
        start=start_date,
        end=end_date,
        date_field=date_field,
        page=q.page,
        page_size=q.page_size,
        include_deleted=q.include_deleted,
    )
    return ok(page_data(items, total, q.page, q.page_size))


@router.post("", summary="新建项目")
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(project_service.create_project(db, payload.model_dump()))


@router.get("/{project_id}", summary="项目详情（含概览指标）")
def get_project(
    project_id: int,
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    """项目详情。

    **同时返回两种结构**，原因是历史包袱（2026-10-17 发现并修）：

    - **嵌套**：`{project: {...}, metrics: {...}, cost_by_type, funds, ar_ap, ...}`
      —— 前端「项目详情」页按这个结构取数（`overview.project`），原来少这层，
      页面就整片显示 `-` / `0.00`（真实后端坏、mock 却是对的，所以自动化测试没抓到）
    - **扁平**：`{id, name, status, is_locked, client_budget, ...}`
      —— 早期接口就是扁平返回，已有后端用例与脚本依赖它

    两种都有，谁也不破坏。数据一律来自 `project_service.overview()`，不重复算。
    """
    project = project_service.get_project(db, project_id)
    data = project_service.overview(db, project_id, start_date, end_date)
    # 扁平字段覆盖在上层，兼容老调用（`project` / `metrics` 这些键不会被覆盖掉）
    data.update(project_service.serialize(project))
    actual = project_service.actual_cost_by_project(db).get(project.id, ZERO)
    data.update(project_service.compute_metrics(project.client_budget, project.cost_budget, actual))
    return ok(data)


@router.put("/{project_id}", summary="修改项目")
def update_project(
    project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)
) -> EnvelopeJSONResponse:
    return ok(project_service.update_project(db, project_id, payload.changes()))


@router.delete("/{project_id}", summary="删除项目（软删除）")
def delete_project(
    project_id: int,
    force: bool = Query(False, description="项目下有数据时是否强制删除"),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(project_service.delete_project(db, project_id, force=force))


@router.post("/{project_id}/finish", summary="项目完工（完工后所有写操作需先解锁）")
def finish_project(project_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(project_service.finish_project(db, project_id))


@router.post("/{project_id}/reopen", summary="撤销完工（改回在建，需登录密码）")
def reopen_project(
    project_id: int, payload: PasswordConfirm, db: Session = Depends(get_db)
) -> EnvelopeJSONResponse:
    return ok(project_service.reopen_project(db, project_id, payload.password))


@router.post("/{project_id}/unlock", summary="解锁已完工项目（需登录密码；一直有效直到手动锁定）")
def unlock_project(
    project_id: int, payload: PasswordConfirm, db: Session = Depends(get_db)
) -> EnvelopeJSONResponse:
    return ok(project_service.unlock_project(db, project_id, payload.password))


@router.post("/{project_id}/lock", summary="重新锁定（不需要密码）")
def lock_project(project_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(project_service.lock_project(db, project_id))


@router.get("/{project_id}/overview", summary="单项目概览")
def overview(
    project_id: int,
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok(project_service.overview(db, project_id, start_date, end_date))
