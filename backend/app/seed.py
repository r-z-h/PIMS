"""种子数据：字典 + 2 个示例项目（默认不执行）。

用法：
    python -m app.seed              # 写字典 + 示例项目（幂等）
    python -m app.seed --dict-only  # 只写字典
    python -m app.main --seed       # 启动服务前先写种子数据
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config, db as database
from .models.project import Project
from .services import dict_service, project_service

# docs/02-数据库设计.md 第 5 节
SAMPLE_PROJECTS: list[dict] = [
    {
        "name": "示例·某小区5#楼",
        "client_name": "某某置业有限公司",
        "location": "武汉市洪山区",
        "manager": "王工",
        "start_date": "2026-03-01",
        "status": "ongoing",
        "client_budget": "4000000.00",
        "cost_budget": "3500000.00",
        "members": ["王工", "张三", "李四"],
        "remark": "用于验证「预计利润 50 万」",
    },
    {
        "name": "示例·市政道路改造",
        "client_name": "某某市政公司",
        "location": "武汉市江夏区",
        "manager": "李工",
        "start_date": "2026-04-01",
        "status": "ongoing",
        "client_budget": "1200000.00",
        "cost_budget": "1050000.00",
        "members": ["李工", "赵五"],
        "remark": "用于验证多项目并列显示",
    },
]


def run_seed(session: Session, with_projects: bool = True) -> dict[str, object]:
    """写入字典与示例项目（幂等：已存在则跳过）。"""
    dict_created = dict_service.ensure_defaults(session)
    session.commit()

    project_created: list[str] = []
    project_skipped: list[str] = []
    if with_projects:
        existing = {
            name for name in session.execute(select(Project.name).where(Project.deleted == 0)).scalars().all()
        }
        for item in SAMPLE_PROJECTS:
            if item["name"] in existing:
                project_skipped.append(item["name"])
                continue
            project_service.create_project(session, dict(item))
            project_created.append(item["name"])

    return {
        "dict_created": dict_created,
        "project_created": project_created,
        "project_skipped": project_skipped,
        "db_path": str(config.settings.db_path),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PIMS 种子数据")
    parser.add_argument("--dict-only", action="store_true", help="只写字典，不写示例项目")
    args = parser.parse_args(argv)

    database.configure_engine()
    database.init_db()
    with database.session_scope() as session:
        result = run_seed(session, with_projects=not args.dict_only)

    print("种子数据写入完成：")
    print(f"  数据库：{result['db_path']}")
    print(f"  新增字典项：{result['dict_created']} 条")
    print(f"  新增示例项目：{result['project_created'] or '无'}")
    if result["project_skipped"]:
        print(f"  已存在跳过：{result['project_skipped']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
