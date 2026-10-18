"""系统维护：数据库备份与业务数据重置。"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import config
from ..models.password_reset_log import ACTION_REINIT, PasswordResetLog
from ..utils.changelog import log_change
from ..utils.errors import BadRequest

# 清空顺序：先子表后父表（外键 ON）
BUSINESS_TABLES = [
    "ar_ap_offset",
    "ar_ap",
    "material_item",
    "inventory_txn",
    "labor_work",
    "machine_item",
    "advance_item",
    "cost",
    "inventory",
    "labor_settle",
    "funds_flow",
    "project",
    "change_log",
]


def db_info() -> dict[str, Any]:
    path = config.settings.db_path
    exists = path.exists()
    return {
        "db_path": str(path),
        "exists": exists,
        "size_bytes": path.stat().st_size if exists else 0,
        "backup_dir": str(config.settings.backup_dir),
        "schema_version": config.settings.schema_version,
    }


def backup(tag: str | None = None) -> dict[str, Any]:
    """用 SQLite 在线备份 API 复制数据库文件（含 WAL 中未落盘的数据）。"""
    source = config.settings.db_path
    if not source.exists():
        raise BadRequest("数据库文件不存在，无法备份")

    stamp = tag or datetime.now().strftime("%Y%m%d-%H%M%S")
    target_dir = config.settings.backup_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"pims-{stamp}.db"

    src_conn = sqlite3.connect(str(source))
    dst_conn = sqlite3.connect(str(target))
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    removed = prune_backups()
    return {
        "backup_path": str(target),
        "size_bytes": target.stat().st_size,
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "removed": removed,
        "keep": config.settings.backup_keep,
    }


def list_backups() -> list[dict[str, Any]]:
    directory = config.settings.backup_dir
    if not directory.exists():
        return []
    files = sorted(directory.glob("pims-*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
    return [
        {
            "path": str(item),
            "name": item.name,
            "size_bytes": item.stat().st_size,
            "modified_at": datetime.fromtimestamp(item.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        }
        for item in files
    ]


def prune_backups() -> list[str]:
    """只保留最近 N 份备份。"""
    keep = max(1, config.settings.backup_keep)
    directory = config.settings.backup_dir
    if not directory.exists():
        return []
    files = sorted(directory.glob("pims-*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
    removed: list[str] = []
    for item in files[keep:]:
        try:
            item.unlink()
            removed.append(item.name)
        except OSError:  # pragma: no cover - 文件被占用时忽略
            continue
    return removed


def auto_backup() -> dict[str, Any] | None:
    """启动时每天自动备份一次（docs/02-数据库设计.md 第 6 节）。"""
    if not config.settings.auto_backup:
        return None
    source = config.settings.db_path
    if not source.exists() or source.stat().st_size == 0:
        return None
    today = datetime.now().strftime("%Y%m%d")
    target = config.settings.backup_dir / f"pims-{today}.db"
    if target.exists():
        return None
    return backup(tag=today)


def table_counts(db: Session) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in ("project", "cost", "funds_flow", "ar_ap", "inventory_txn", "labor_settle"):
        counts[table] = int(db.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0)
    return counts


def reset_business_data(db: Session, keep_dict: bool = True) -> dict[str, Any]:
    """清空业务数据（保留密码与密保）。"""
    before_counts = table_counts(db)
    for table in BUSINESS_TABLES:
        db.execute(text(f"DELETE FROM {table}"))
    try:
        db.execute(text("DELETE FROM sqlite_sequence"))
    except Exception:  # pragma: no cover - sqlite_sequence 可能不存在
        pass

    if not keep_dict:
        db.execute(text("DELETE FROM dict_item"))
    elif "dict_item" not in BUSINESS_TABLES:
        from . import dict_service

        dict_service.ensure_defaults(db)

    db.add(
        PasswordResetLog(
            action=ACTION_REINIT,
            result="success",
            detail="清空业务数据（保留密码与密保）",
            created_at=datetime.now(),
        )
    )
    log_change(
        db,
        "system",
        0,
        "delete",
        before=None,
        after={"action": "reset", "cleared": before_counts, "keep_dict": keep_dict},
    )
    db.commit()
    return {"reset": True, "cleared": before_counts, "keep_dict": keep_dict}
