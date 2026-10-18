"""轻量迁移：给已存在的旧库补字段/补数据。

`schema.sql` 用的是 `CREATE TABLE IF NOT EXISTS`，**对已存在的表加字段不会生效**，
所以老库升级必须在这里显式 ALTER。整个过程**幂等**，每次启动跑一遍也没关系。

原则：
- 只做「加字段 / 补数据 / 加索引」，**不删字段、不删数据**
- 每一步先查 `PRAGMA table_info` / `sqlite_master`，已经有了就跳过
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

# 未填对方时的占位分组名（与 services 里的常量保持一致）
PARTNER_NONE_LABEL = "（未填对方）"


def _columns(engine: Engine, table: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    return {str(row[1]) for row in rows}


def _indexes(engine: Engine, table: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text(f"PRAGMA index_list({table})")).fetchall()
    return {str(row[1]) for row in rows}


def _table_exists(engine: Engine, table: str) -> bool:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name=:name"),
            {"name": table},
        ).fetchone()
    return row is not None


def _migrate_settle_multi_type(engine: Engine) -> list[str]:
    """labor_settle 支持五类结算（2026-10-16 需求）。

    旧表只有 `worker_name`；补上：
    - `cost_type`：旧数据一律回填 `labor`
    - `partner`  ：旧数据回填 `worker_name`（人工的汇总依据就是姓名）
    - 唯一索引 `uk_settle_type_partner`（同项目 + 同类别 + 同对象只有一张结算单）
    """
    applied: list[str] = []
    if not _table_exists(engine, "labor_settle"):
        return applied

    cols = _columns(engine, "labor_settle")
    with engine.begin() as conn:
        if "cost_type" not in cols:
            conn.execute(
                text("ALTER TABLE labor_settle ADD COLUMN cost_type TEXT NOT NULL DEFAULT 'labor'")
            )
            applied.append("labor_settle.cost_type 已添加")
        if "partner" not in cols:
            conn.execute(text("ALTER TABLE labor_settle ADD COLUMN partner TEXT"))
            applied.append("labor_settle.partner 已添加")
        # 回填：只动还没填过的行（幂等）
        updated = conn.execute(
            text(
                "UPDATE labor_settle SET cost_type='labor' "
                "WHERE cost_type IS NULL OR cost_type=''"
            )
        ).rowcount
        if updated:
            applied.append(f"labor_settle.cost_type 回填 {updated} 行")
        backfilled = conn.execute(
            text(
                "UPDATE labor_settle SET partner=worker_name "
                "WHERE partner IS NULL OR partner=''"
            )
        ).rowcount
        if backfilled:
            applied.append(f"labor_settle.partner 回填 {backfilled} 行")

    if "uk_settle_type_partner" not in _indexes(engine, "labor_settle"):
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uk_settle_type_partner "
                    "ON labor_settle(project_id, cost_type, partner)"
                )
            )
        applied.append("索引 uk_settle_type_partner 已创建")

    return applied


def _drop_settle_paid_amount(engine: Engine) -> list[str]:
    """结算单不再存「已发」（2026-10-16 用户实测发现的口径问题）。

    原设计里 `labor_settle.paid_amount` 是**结算页自己维护**的已发金额，
    但钱可以从 4 个入口进来（收/付款页、冲销弹窗、登记已付、结算发放），
    前三个**不会回写结算单** → 出现「应付单已冲 500、结算页却显示已发 0」，
    更糟的是发放时的上限按这个错数算，会**多付**。

    现在「已付/还欠」一律由**应付单上的冲销记录**现场算出（`labor_service.settlement_overview`），
    所以这个字段作废：
    - 表结构上保留该列（SQLite 删列麻烦且没收益），**代码不再写也不再读**
    - 把存量值**清零**，避免以后有人误读到一个"看起来像真的"的旧数字
    """
    applied: list[str] = []
    if not _table_exists(engine, "labor_settle"):
        return applied
    cols = _columns(engine, "labor_settle")
    if "paid_amount" not in cols:
        return applied
    with engine.begin() as conn:
        cleared = conn.execute(
            text("UPDATE labor_settle SET paid_amount = 0, status = 'unpaid' WHERE paid_amount <> 0")
        ).rowcount
    if cleared:
        applied.append(f"labor_settle.paid_amount 清零 {cleared} 行（已付改由冲销记录计算）")
    return applied


def _add_project_unlocked_at(engine: Engine) -> list[str]:
    """项目完工锁：新增 `project.unlocked_at`（2026-10-17 需求）。

    - `NULL`   = 已锁定（完工后默认就是锁定）
    - 有值     = 已用密码解锁，值记录**解锁时间**
    - 在建项目不看这个字段（本来就不锁）

    为什么放数据库而不是内存：用户明确要求「**重启后仍保持解锁**，直到手动锁定」。
    """
    applied: list[str] = []
    if not _table_exists(engine, "project"):
        return applied
    if "unlocked_at" not in _columns(engine, "project"):
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE project ADD COLUMN unlocked_at TEXT"))
        applied.append("project.unlocked_at 已新增（完工锁状态）")
    return applied


# 注册表：以后加迁移往这里追加即可（顺序执行，各自幂等）
MIGRATIONS = (_migrate_settle_multi_type, _drop_settle_paid_amount, _add_project_unlocked_at)


def run_migrations(engine: Engine) -> list[str]:
    """执行全部轻量迁移，返回本次实际做了什么（空列表表示无需迁移）。"""
    applied: list[str] = []
    for migrate in MIGRATIONS:
        applied.extend(migrate(engine))
    return applied
