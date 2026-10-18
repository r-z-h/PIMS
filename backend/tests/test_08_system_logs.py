"""字典、变更日志、系统维护（备份 / 重置）与种子数据。"""

from __future__ import annotations

from pathlib import Path

from helpers import add_misc, err_data, ok_data


def test_健康检查与接口文档(client):
    data = ok_data(client.get("/api/health"))
    assert data["status"] == "ok"
    assert data["schema_version"] == 1

    docs = client.get("/docs")
    assert docs.status_code == 200
    assert "swagger" in docs.text.lower()

    openapi = client.get("/openapi.json")
    assert openapi.status_code == 200
    schema = openapi.json()
    assert schema["info"]["title"]
    paths = schema["paths"]
    for path in (
        "/api/auth/login",
        "/api/auth/security/verify",
        "/api/projects",
        "/api/projects/{project_id}/overview",
        "/api/funds",
        "/api/funds/summary",
        "/api/costs",
        "/api/costs/labor",
        "/api/costs/material",
        "/api/costs/machine",
        "/api/costs/misc",
        "/api/costs/advance",
        "/api/costs/summary",
        "/api/costs/{cost_id}/logs",
        "/api/arap",
        "/api/arap/pending",
        "/api/arap/offset",
        "/api/arap/summary",
        "/api/inventory",
        "/api/inventory/txns",
        "/api/inventory/in",
        "/api/inventory/out",
        "/api/labor/preview",
        "/api/labor/settle",
        "/api/labor/settles",
        "/api/dashboard/projects",
        "/api/dashboard/recent",
        "/api/dashboard/cost-trend",
        "/api/export/excel",
        "/api/logs",
        "/api/dict/{dict_type}",
        "/api/system/backup",
        "/api/system/reset",
    ):
        assert path in paths, f"缺少接口 {path}"


def test_字典预置与CRUD(api):
    units = ok_data(api.get("/api/dict/unit"))["items"]
    names = [item["name"] for item in units]
    for expected in ("吨", "车", "方", "袋", "米", "根", "件", "个", "套", "桶"):
        assert expected in names

    categories = [item["name"] for item in ok_data(api.get("/api/dict/misc_category"))["items"]]
    assert categories == ["伙食费", "转运费", "招待费", "罚款", "临时工", "其他"]

    materials = [item["name"] for item in ok_data(api.get("/api/dict/material"))["items"]]
    assert "水泥" in materials and "钢筋" in materials

    all_dict = ok_data(api.get("/api/dict/all"))
    assert set(all_dict.keys()) == {"misc_category", "material", "unit", "partner"}

    err_data(api.get("/api/dict/bad_type"), 400)

    created = ok_data(api.post("/api/dict", json={"dict_type": "misc_category", "name": "临时用电"}))
    assert created["sort_no"] > 0
    err_data(api.post("/api/dict", json={"dict_type": "misc_category", "name": "临时用电"}), 409)

    updated = ok_data(api.put(f"/api/dict/{created['id']}", json={"name": "临时水电", "enabled": 0}))
    assert updated["name"] == "临时水电" and updated["enabled"] == 0

    # 未被使用 → 物理删除
    result = ok_data(api.delete(f"/api/dict/{created['id']}"))
    assert result["deleted"] is True
    names_after = [item["name"] for item in ok_data(api.get("/api/dict/misc_category"))["items"]]
    assert "临时水电" not in names_after


def test_已使用的字典项只停用不删除(api, project):
    add_misc(api, project, "罚款", "200")
    item = next(item for item in ok_data(api.get("/api/dict/misc_category"))["items"] if item["name"] == "罚款")
    result = ok_data(api.delete(f"/api/dict/{item['id']}"))
    assert result["deleted"] is False and result["disabled"] is True

    categories = ok_data(api.get("/api/dict/misc_category"))["items"]
    row = next(row for row in categories if row["name"] == "罚款")
    assert row["enabled"] == 0
    assert row["id"] == item["id"]  # 记录还在

    enabled_only = ok_data(api.get("/api/dict/misc_category", params={"include_disabled": False}))["items"]
    assert all(item["name"] != "罚款" for item in enabled_only)


def test_对方候选(api, project):
    add_misc(api, project, "招待费", "300")
    items = ok_data(api.get("/api/dict/suggest/partner"))["items"]
    assert isinstance(items, list)


def test_变更日志查询(api, project):
    logs = ok_data(api.get("/api/logs", params={"page_size": 5}))
    assert logs["total"] >= 1
    assert len(logs["items"]) <= 5
    assert set(logs["items"][0].keys()) >= {"table_name", "record_id", "action", "before", "after", "created_at"}

    project_logs = ok_data(api.get("/api/logs", params={"table_name": "project", "record_id": project}))["items"]
    assert [item["action"] for item in project_logs] == ["create"]
    assert project_logs[0]["after"]["name"].startswith("测试项目-")

    history = ok_data(api.get(f"/api/logs/project/{project}"))["items"]
    assert len(history) == 1

    create_logs = ok_data(api.get("/api/logs", params={"action": "create", "table_name": "cost"}))["items"]
    assert all(item["action"] == "create" for item in create_logs)

    err_data(api.get("/api/logs", params={"action": "bad"}), 400)


def test_数据库备份(api, db_file: Path):
    info = ok_data(api.get("/api/system/info"))
    assert info["db_path"] == str(db_file)
    assert info["exists"] is True
    assert info["size_bytes"] > 0

    result = ok_data(api.post("/api/system/backup"))
    backup_path = Path(result["backup_path"])
    assert backup_path.exists()
    assert backup_path.stat().st_size > 0
    assert backup_path.parent.name == "backup"

    backups = ok_data(api.get("/api/system/backups"))["items"]
    assert any(item["path"] == str(backup_path) for item in backups)


def test_种子数据幂等(api, db_file: Path):
    from app.db import session_scope
    from app.seed import run_seed

    with session_scope() as session:
        first = run_seed(session)
    assert first["project_created"] == ["示例·某小区5#楼", "示例·市政道路改造"]
    with session_scope() as session:
        second = run_seed(session)
    assert second["project_created"] == []
    assert second["dict_created"] == 0
    assert set(second["project_skipped"]) == {"示例·某小区5#楼", "示例·市政道路改造"}

    data = ok_data(api.get("/api/dashboard/projects"))
    sample = next(item for item in data["items"] if item["name"] == "示例·某小区5#楼")
    assert sample["client_budget"] == 4000000
    assert sample["expect_profit"] == 500000
    sample2 = next(item for item in data["items"] if item["name"] == "示例·市政道路改造")
    assert sample2["client_budget"] == 1200000
    assert sample2["expect_profit"] == 150000


def test_重置业务数据保留密码与字典(api, project):
    add_misc(api, project, "伙食费", "100")

    # 必须二次确认
    err_data(api.post("/api/system/reset", json={}), 400)
    err_data(api.post("/api/system/reset", json={"confirm": "yes"}), 400)

    result = ok_data(api.post("/api/system/reset", json={"confirm": "RESET"}))
    assert result["reset"] is True
    assert result["cleared"]["project"] >= 1

    # 业务数据清空
    assert ok_data(api.get("/api/projects"))["total"] == 0
    assert ok_data(api.get("/api/costs"))["total"] == 0
    assert ok_data(api.get("/api/funds"))["total"] == 0
    assert ok_data(api.get("/api/arap"))["total"] == 0

    # 字典保留
    assert len(ok_data(api.get("/api/dict/unit"))["items"]) >= 10

    # 密码与密保保留：会话仍然有效，登录也还能用默认密码
    assert ok_data(api.get("/api/auth/status"))["logged_in"] is True
    ok_data(api.post("/api/auth/logout"))
    ok_data(api.post("/api/auth/login", json={"password": "123456"}))
