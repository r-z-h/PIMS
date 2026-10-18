"""轻量迁移的回归测试（2026-10-16 结算泛化引入）。

关键点：`schema.sql` 用 `CREATE TABLE IF NOT EXISTS`，**对旧库加字段不生效**，
而且 schema 里有引用新列的 `CREATE INDEX` —— 如果迁移排在建表脚本之后，
旧库启动会直接报 `no such column: cost_type`。所以这里锁住：
1. 旧结构库能被升级（不报错）
2. 旧数据一条不丢，并正确回填 cost_type / partner
3. 迁移幂等（重复跑无副作用）
"""

from __future__ import annotations

import sqlite3

from sqlalchemy import create_engine

from app.db.migrations import run_migrations

OLD_SETTLE_DDL = """
CREATE TABLE project (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  client_budget NUMERIC(14,2) DEFAULT 0,
  cost_budget NUMERIC(14,2) DEFAULT 0,
  status TEXT DEFAULT 'ongoing',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE labor_settle (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  worker_name TEXT NOT NULL,
  total_days  NUMERIC(8,2) NOT NULL,
  amount_due  NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'unpaid',
  settle_date TEXT, pay_date TEXT, pay_method TEXT, remark TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uk_settle ON labor_settle(project_id, worker_name);
INSERT INTO project (name) VALUES ('旧项目');
INSERT INTO labor_settle (project_id, worker_name, total_days, amount_due, paid_amount) VALUES
  (1, '张三', 10, 3000, 1000),
  (1, '李四', 5, 1500, 0);
"""


def _old_db(tmp_path) -> str:
    db = str(tmp_path / "old.db")
    conn = sqlite3.connect(db)
    conn.executescript(OLD_SETTLE_DDL)
    conn.commit()
    conn.close()
    return db


def test_旧库能升级且数据不丢(tmp_path):
    db = _old_db(tmp_path)
    engine = create_engine(f"sqlite:///{db}")

    applied = run_migrations(engine)
    assert any("cost_type" in step for step in applied), applied
    assert any("partner" in step for step in applied), applied

    conn = sqlite3.connect(db)
    cols = [row[1] for row in conn.execute("PRAGMA table_info(labor_settle)")]
    assert "cost_type" in cols and "partner" in cols

    rows = list(
        conn.execute("select worker_name, cost_type, partner, amount_due, paid_amount from labor_settle order by id")
    )
    assert len(rows) == 2, "数据不能丢"
    # paid_amount 被迁移清零（已付改由应付单的冲销记录计算，不再存结算单里）
    assert rows[0] == ("张三", "labor", "张三", 3000, 0)
    assert rows[1] == ("李四", "labor", "李四", 1500, 0)

    indexes = [row[1] for row in conn.execute("PRAGMA index_list(labor_settle)")]
    assert "uk_settle_type_partner" in indexes
    assert "uk_settle" in indexes, "旧索引要保留，不能破坏老库"
    conn.close()
    engine.dispose()


def test_迁移幂等_重复跑无副作用(tmp_path):
    db = _old_db(tmp_path)
    engine = create_engine(f"sqlite:///{db}")

    first = run_migrations(engine)
    assert first, "第一次应该有动作"
    second = run_migrations(engine)
    assert second == [], f"重复跑不该有动作，实际：{second}"

    conn = sqlite3.connect(db)
    assert conn.execute("select count(*) from labor_settle").fetchone()[0] == 2
    conn.close()
    engine.dispose()


def test_全新库无需迁移(tmp_path):
    """新库由 schema.sql 直接建成带新列的表，迁移应报"无操作"。

    注意：这里**不碰全局引擎**（app.db 的 engine 在测试进程里会被其它用例缓存，
    改 PIMS_DB_PATH 没意义），而是自己建库 + 自己执行 schema.sql。
    """
    from app.db import read_schema_sql

    db = str(tmp_path / "fresh.db")
    engine = create_engine(f"sqlite:///{db}")
    sql = read_schema_sql()
    with engine.begin() as conn:
        raw = getattr(conn.connection, "driver_connection", None) or conn.connection.dbapi_connection
        raw.executescript(sql)
        raw.commit()

    # 新建的表已含新列 → 迁移无事可做
    assert run_migrations(engine) == []

    conn = sqlite3.connect(db)
    cols = [row[1] for row in conn.execute("PRAGMA table_info(labor_settle)")]
    assert "cost_type" in cols and "partner" in cols
    indexes = [row[1] for row in conn.execute("PRAGMA index_list(labor_settle)")]
    assert "uk_settle_type_partner" in indexes
    conn.close()
    engine.dispose()
