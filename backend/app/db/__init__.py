"""数据库引擎、会话、建表与初始化。

> 说明：docs/01-开发手册.md 的结构里同时出现 `app/db.py` 与 `app/db/schema.sql`，
> 二者在文件系统上不能共存（同名模块与包），这里把 `db.py` 实现为 `app/db/__init__.py`，
> 对外仍然是 `from app.db import get_db / engine`，`schema.sql` 位置保持不变。

约定（docs/01-开发手册.md 1.2）：
- 数据库文件 `backend/data/pims.db`，目录不存在自动创建
- 每个连接都执行 `PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`
- 启动时执行 `schema.sql`（CREATE TABLE IF NOT EXISTS）并写入 `sys_setting` 初始值
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker

from .. import config
from ..models.sys_setting import (
    KEY_PASSWORD_HASH,
    KEY_PWD_INITIALIZED,
    KEY_SCHEMA_VERSION,
    KEY_SECURITY_READY,
    SysSetting,
)
from ..utils.security import hash_secret
from .migrations import run_migrations

logger = logging.getLogger("pims.db")

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def _set_sqlite_pragma(dbapi_connection, connection_record) -> None:  # noqa: ANN001
    """每个连接都开外键约束与 WAL。"""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
    finally:
        cursor.close()


def configure_engine(db_path: str | Path | None = None, echo: bool = False) -> Engine:
    """创建（或重建）引擎；数据库目录不存在时自动创建。"""
    global _engine, _session_factory

    if _engine is not None:
        _engine.dispose()

    path = Path(db_path) if db_path is not None else config.settings.db_path
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Windows 盘符路径用正斜杠，SQLAlchemy 的 sqlite URL 才认得
    url = f"sqlite+pysqlite:///{path.as_posix()}"
    _engine = create_engine(
        url,
        echo=echo,
        future=True,
        connect_args={"check_same_thread": False, "timeout": 15},
    )
    event.listen(_engine, "connect", _set_sqlite_pragma)
    _session_factory = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    logger.debug("SQLite 引擎就绪：%s", path)
    return _engine


def get_engine() -> Engine:
    if _engine is None:
        configure_engine()
    assert _engine is not None
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    if _session_factory is None:
        configure_engine()
    assert _session_factory is not None
    return _session_factory


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：一个请求一个会话。"""
    session = get_session_factory()()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """脚本 / 后台任务用的会话上下文。"""
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def read_schema_sql() -> str:
    return config.settings.schema_sql_path.read_text(encoding="utf-8")


def run_schema(engine: Engine | None = None) -> None:
    """执行 schema.sql（多语句，走 DBAPI 的 executescript）。"""
    target = engine or get_engine()
    sql = read_schema_sql()
    with target.begin() as conn:
        raw = getattr(conn.connection, "driver_connection", None) or conn.connection.dbapi_connection
        raw.executescript(sql)
        raw.commit()


# 初始 sys_setting：初始密码 123456 + 三个标记位（docs/02-数据库设计.md 第 5 节）
def default_settings() -> dict[str, str]:
    return {
        KEY_PASSWORD_HASH: hash_secret("123456"),
        KEY_PWD_INITIALIZED: "0",
        KEY_SECURITY_READY: "0",
        KEY_SCHEMA_VERSION: str(config.settings.schema_version),
    }


def ensure_default_settings(engine: Engine | None = None) -> None:
    """只补缺失的键，绝不覆盖已有值（否则每次启动都会重置密码）。"""
    target = engine or get_engine()
    with Session(target) as session:
        existing = {row.key for row in session.execute(select(SysSetting)).scalars().all()}
        changed = False
        for key, value in default_settings().items():
            if key not in existing:
                session.add(SysSetting(key=key, value=value))
                changed = True
        if changed:
            session.commit()


def init_db(engine: Engine | None = None) -> Engine:
    """建表 + 轻量迁移 + 写 sys_setting 初始值 + 预置字典（幂等）。

    字典（杂费小类 / 单位 / 材料）属于「预置值」（docs/00-需求冻结.md 第 7 节、
    docs/02-数据库设计.md 第 5 节），首次启动即写入；示例项目只在 `--seed` 时写入。
    """
    target = engine or get_engine()
    # 老库升级**必须排在建表脚本之前**：
    # schema.sql 里有引用新列的 CREATE INDEX，若旧表还没这些列，executescript 会直接报
    # "no such column"。迁移幂等，前后各跑一次没有副作用。
    pre_applied = run_migrations(target)
    run_schema(target)
    post_applied = run_migrations(target)
    applied = pre_applied + [step for step in post_applied if step not in pre_applied]
    if applied:
        logger.info("数据库迁移：%s", "；".join(applied))
    ensure_default_settings(target)

    # 函数内延迟导入，避免 db 与 services 的模块级循环依赖
    from ..services import dict_service

    with Session(target) as session:
        if dict_service.ensure_defaults(session):
            session.commit()
    return target
