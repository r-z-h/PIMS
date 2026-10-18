"""清空业务数据（保留字典与项目档案本身）。

用途：需要从干净状态重新录入数据时使用（2026-10-16 用过一次）。

⚠️ **执行前请自己先备份**：这个脚本会 `DELETE` + `VACUUM`，**不可撤销**。
   最省事的备份就是把 `backend/data/pims.db` 复制一份出去。
   （当时用过的还原点目录已删除，脚本不再依赖它。）

清掉：成本及其四类明细、往来单与冲销、资金流水、库存流水与余量、
      结算单、变更日志。
保留：项目档案（含甲方预算/成本预算）、数据字典、sys_setting（含密码/密保）。
"""

from __future__ import annotations

import os
import sys

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 业务表（按依赖顺序：先删引用别人的，再删被引用的）
BUSINESS_TABLES = [
    "ar_ap_offset",
    "ar_ap",
    "funds_flow",
    "labor_settle",
    "inventory",
    "inventory_txn",
    "labor_work",
    "material_item",
    "machine_item",
    "advance_item",
    "cost",
    "change_log",
]


def main() -> int:
    db_path = os.environ.get("PIMS_DB_PATH") or os.path.join(_PROJECT_ROOT, "backend", "data", "pims.db")
    print(f"目标数据库：{db_path}")
    if not os.path.exists(db_path):
        print("  数据库不存在，无需清理")
        return 1

    import sqlite3

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    print("\n=== 清理前 ===")
    for table in ["project", "cost", "ar_ap", "funds_flow", "labor_settle", "inventory_txn"]:
        n = cur.execute(f"select count(*) from {table}").fetchone()[0]
        print(f"  {table:16} {n}")

    print("\n=== 开始清理 ===")
    for table in BUSINESS_TABLES:
        try:
            n = cur.execute(f"select count(*) from {table}").fetchone()[0]
            cur.execute(f"delete from {table}")
            print(f"  {table:16} 已清空 {n} 行")
        except sqlite3.OperationalError as exc:
            print(f"  {table:16} 跳过（{exc}）")

    # 结算单自增序号重置由 sqlite_sequence 自动处理；这里顺手清掉历史序列
    try:
        cur.execute("delete from sqlite_sequence")
    except sqlite3.OperationalError:
        pass

    conn.commit()
    # VACUUM 需要在没有活动事务时执行，顺便把文件压回去
    cur.execute("VACUUM")
    conn.commit()

    print("\n=== 清理后 ===")
    for table in ["project", "cost", "ar_ap", "funds_flow", "labor_settle", "inventory_txn"]:
        n = cur.execute(f"select count(*) from {table}").fetchone()[0]
        print(f"  {table:16} {n}")
    projects = [row[0] for row in cur.execute("select name from project where deleted=0")]
    print(f"\n  保留的项目：{projects}")
    conn.close()
    print("\n完成。密码等登录信息未动（如需重置，删掉 sys_setting 里的相关键或用忘记密码流程）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
