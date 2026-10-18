"""数据字典路由 /api/dict。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..schemas.dict_item import DictCreate, DictUpdate
from ..services import dict_service
from ..utils.response import EnvelopeJSONResponse, ok, page_data
from .deps import make_router

router = make_router("/api/dict", "dict")


@router.get("/all", summary="全部字典")
def list_all(db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(dict_service.list_all(db))


@router.get("/suggest/partner", summary="对方候选（用过的名称）")
def suggest_partner(
    keyword: str | None = Query(None),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    return ok({"items": dict_service.suggest_partners(db, keyword)})


@router.get("/{dict_type}", summary="字典列表")
def list_items(
    dict_type: str,
    include_disabled: bool = Query(True),
    keyword: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
) -> EnvelopeJSONResponse:
    items, total = dict_service.list_items(
        db, dict_type, include_disabled=include_disabled, keyword=keyword
    )
    return ok(page_data(items, total, page, page_size))


@router.post("", summary="新增字典项")
def create_item(payload: DictCreate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(dict_service.create_item(db, payload.model_dump()))


@router.put("/{item_id}", summary="修改字典项")
def update_item(item_id: int, payload: DictUpdate, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(dict_service.update_item(db, item_id, payload.changes()))


@router.delete("/{item_id}", summary="删除字典项（已使用则停用）")
def delete_item(item_id: int, db: Session = Depends(get_db)) -> EnvelopeJSONResponse:
    return ok(dict_service.delete_item(db, item_id))
