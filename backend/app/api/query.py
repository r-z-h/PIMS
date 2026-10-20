"""快速查询路由 /api/query（2026-10-19 需求）。

- `GET  /api/query/types`：可选查询清单（前端渲染勾选框，默认全选）
- `POST /api/query/run`  ：按勾选执行，返回 blocks 数组（选一个就只回一个）

**只读**：不写库、不新增业务口径，全部复用现有 service。
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.query import QuickQueryRun
from ..services import query_service
from ..utils.response import EnvelopeJSONResponse, ok
from .deps import make_router

router = make_router("/api/query", "query")


@router.get("/types", summary="可查询的内容清单（默认全选）")
def types() -> EnvelopeJSONResponse:
    items = query_service.list_types()
    return ok({"items": items, "default": query_service.DEFAULT_TYPES, "total": len(items)})


@router.post("/run", summary="执行查询（types 选一个就只返回一个结果块）")
def run(payload: QuickQueryRun, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    """`types` 为空 → 400；失败的单个查询以 `error` 返回，不影响其他块。"""
    return ok(
        query_service.run(
            db,
            payload.types,
            project_id=payload.project_id,
            start=payload.start_date,
            end=payload.end_date,
        )
    )
