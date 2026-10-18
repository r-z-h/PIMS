"""数据字典：杂费小类 / 材料 / 单位 / 对方。"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models.cost import Cost
from ..models.dict_item import DICT_TYPES, DictItem
from ..models.funds_flow import FundsFlow
from ..models.inventory import Inventory
from ..models.inventory_txn import InventoryTxn
from ..models.material_item import MaterialItem
from ..models.project import Project
from ..utils.changelog import log_change, log_create, log_update, row_to_dict
from ..utils.errors import BadRequest, Conflict, NotFound


def serialize(row: DictItem) -> dict[str, Any]:
    return {
        "id": row.id,
        "dict_type": row.dict_type,
        "name": row.name,
        "sort_no": row.sort_no,
        "enabled": row.enabled,
        "remark": row.remark,
    }


def check_type(dict_type: str) -> str:
    if dict_type not in DICT_TYPES:
        raise BadRequest(f"字典类型不正确：{dict_type}")
    return dict_type


def get_item(db: Session, item_id: int) -> DictItem:
    row = db.get(DictItem, int(item_id))
    if row is None:
        raise NotFound("字典项不存在")
    return row


def list_items(
    db: Session,
    dict_type: str,
    *,
    include_disabled: bool = True,
    keyword: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    check_type(dict_type)
    stmt = select(DictItem).where(DictItem.dict_type == dict_type)
    if not include_disabled:
        stmt = stmt.where(DictItem.enabled == 1)
    if keyword:
        stmt = stmt.where(DictItem.name.like(f"%{keyword.strip()}%"))
    rows = db.execute(stmt.order_by(DictItem.sort_no.asc(), DictItem.id.asc())).scalars().all()
    return [serialize(row) for row in rows], len(rows)


def list_all(db: Session) -> dict[str, list[dict[str, Any]]]:
    """一次性取全部字典（前端缓存用）。"""
    rows = db.execute(
        select(DictItem).order_by(DictItem.dict_type.asc(), DictItem.sort_no.asc(), DictItem.id.asc())
    ).scalars().all()
    result: dict[str, list[dict[str, Any]]] = {key: [] for key in DICT_TYPES}
    for row in rows:
        result.setdefault(row.dict_type, []).append(serialize(row))
    return result


def create_item(db: Session, data: dict[str, Any]) -> dict[str, Any]:
    dict_type = check_type(data["dict_type"])
    name = str(data["name"]).strip()
    if not name:
        raise BadRequest("字典名称必填")

    exists = db.execute(
        select(DictItem).where(DictItem.dict_type == dict_type, DictItem.name == name)
    ).scalar_one_or_none()
    if exists is not None:
        if exists.enabled:
            raise Conflict(f"「{name}」已存在")
        # 之前被停用的同名项直接复活，避免唯一索引冲突
        before = row_to_dict(exists, raw=True)
        exists.enabled = int(data.get("enabled", 1))
        exists.sort_no = int(data.get("sort_no", exists.sort_no))
        db.flush()
        log_update(db, "dict_item", exists, before=before)
        db.commit()
        return serialize(exists)

    sort_no = data.get("sort_no")
    if sort_no in (None, 0):
        max_sort = db.execute(
            select(func.max(DictItem.sort_no)).where(DictItem.dict_type == dict_type)
        ).scalar()
        sort_no = int(max_sort or 0) + 10

    row = DictItem(
        dict_type=dict_type,
        name=name,
        sort_no=int(sort_no),
        enabled=int(data.get("enabled", 1)),
        remark=data.get("remark"),
    )
    db.add(row)
    db.flush()
    log_create(db, "dict_item", row)
    db.commit()
    return serialize(row)


def update_item(db: Session, item_id: int, changes: dict[str, Any]) -> dict[str, Any]:
    row = get_item(db, item_id)
    before = row_to_dict(row, raw=True)

    if changes.get("name"):
        name = str(changes["name"]).strip()
        duplicate = db.execute(
            select(DictItem).where(
                DictItem.dict_type == row.dict_type, DictItem.name == name, DictItem.id != row.id
            )
        ).scalar_one_or_none()
        if duplicate is not None:
            raise Conflict(f"「{name}」已存在")
        row.name = name
    if changes.get("sort_no") is not None:
        row.sort_no = int(changes["sort_no"])
    if changes.get("enabled") is not None:
        row.enabled = int(changes["enabled"])
    if "remark" in changes:
        row.remark = changes["remark"]

    db.flush()
    log_update(db, "dict_item", row, before=before)
    db.commit()
    return serialize(row)


def is_used(db: Session, row: DictItem) -> bool:
    """字典项是否已被业务数据引用。"""
    name = row.name
    if row.dict_type == "misc_category":
        return bool(db.execute(select(Cost.id).where(Cost.category == name).limit(1)).scalar())
    if row.dict_type == "material":
        checks = (
            select(MaterialItem.id).where(MaterialItem.material_name == name).limit(1),
            select(Inventory.id).where(Inventory.material_name == name).limit(1),
            select(InventoryTxn.id).where(InventoryTxn.material_name == name).limit(1),
        )
    elif row.dict_type == "unit":
        checks = (
            select(MaterialItem.id).where(MaterialItem.unit == name).limit(1),
            select(Inventory.id).where(Inventory.unit == name).limit(1),
            select(InventoryTxn.id).where(InventoryTxn.unit == name).limit(1),
        )
    elif row.dict_type == "partner":
        checks = (
            select(Cost.id).where(Cost.partner == name).limit(1),
            select(FundsFlow.id).where(FundsFlow.partner == name).limit(1),
            select(Project.id).where(Project.client_name == name).limit(1),
        )
    else:  # pragma: no cover - 类型已受 check_type 限制
        return False
    return any(db.execute(stmt).scalar() for stmt in checks)


def delete_item(db: Session, item_id: int) -> dict[str, Any]:
    """删除：已使用的名称仅置 enabled=0，不物理删除。"""
    row = get_item(db, item_id)
    if is_used(db, row):
        before = row_to_dict(row, raw=True)
        row.enabled = 0
        db.flush()
        log_update(db, "dict_item", row, before=before)
        db.commit()
        return {"deleted": False, "disabled": True, "id": row.id, "message": "该项已被使用，已停用而非删除"}

    snapshot = row_to_dict(row, raw=True)
    item_id_value = row.id
    db.delete(row)
    db.flush()
    log_change(db, "dict_item", item_id_value, "delete", before=snapshot, after=None)
    db.commit()
    return {"deleted": True, "disabled": False, "id": item_id_value}


def ensure_defaults(db: Session) -> int:
    """写入预置字典（幂等，只补缺失项）。"""
    from ..models.dict_item import DEFAULT_DICT_ITEMS

    created = 0
    for dict_type, names in DEFAULT_DICT_ITEMS.items():
        for index, name in enumerate(names):
            exists = db.execute(
                select(DictItem.id).where(DictItem.dict_type == dict_type, DictItem.name == name)
            ).scalar()
            if exists:
                continue
            db.add(DictItem(dict_type=dict_type, name=name, sort_no=(index + 1) * 10, enabled=1))
            created += 1
    if created:
        db.flush()
    return created


def suggest_partners(db: Session, keyword: str | None = None, limit: int = 20) -> list[str]:
    """用过的对方名称自动进入候选（字典 + 业务数据）。"""
    names: list[str] = []
    stmt = (
        select(FundsFlow.partner)
        .where(FundsFlow.partner.is_not(None), FundsFlow.deleted == 0)
        .group_by(FundsFlow.partner)
        .limit(limit)
    )
    if keyword:
        stmt = stmt.where(FundsFlow.partner.like(f"%{keyword}%"))
    names.extend(str(row) for row in db.execute(stmt).scalars().all())

    stmt2 = (
        select(Cost.partner)
        .where(Cost.partner.is_not(None), Cost.deleted == 0)
        .group_by(Cost.partner)
        .limit(limit)
    )
    if keyword:
        stmt2 = stmt2.where(Cost.partner.like(f"%{keyword}%"))
    names.extend(str(row) for row in db.execute(stmt2).scalars().all())

    dict_names = db.execute(
        select(DictItem.name).where(DictItem.dict_type == "partner").order_by(DictItem.sort_no.asc())
    ).scalars().all()
    names.extend(str(row) for row in dict_names)

    seen: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.append(name)
    return seen[:limit]
