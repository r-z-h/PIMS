"""五类成本：录入 / 汇总 / 修改 / 删除留痕（FR-5、FR-9.3）。"""

from __future__ import annotations

from helpers import add_advance, add_labor, add_machine, add_material, add_misc, err_data, money_eq, ok_data


def test_五类成本录入与合计(api, project):
    add_labor(api, project, "张三", "5", "300")  # 1500
    add_material(api, project, quantity="100", unit_price="10000")  # 1000000
    add_machine(api, project, "10", "20000")  # 200000
    add_misc(api, project, "伙食费", "100000")  # 100000
    add_advance(api, project, "50000")  # 50000

    overview = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "1351500.00")  # 135.15 万
    money_eq(overview["metrics"]["settle_profit"], "2648500.00")
    money_eq(overview["metrics"]["expect_profit"], "500000.00")
    money_eq(overview["cost_by_type"]["labor"], "1500.00")
    money_eq(overview["cost_by_type"]["material"], "1000000.00")
    money_eq(overview["cost_by_type"]["machine"], "200000.00")
    money_eq(overview["cost_by_type"]["misc"], "100000.00")
    money_eq(overview["cost_by_type"]["advance"], "50000.00")


def test_金额可手改与自动计算(api, project):
    # 工天 2 × 400 = 800，手改金额 1000
    data = ok_data(
        api.post(
            "/api/costs/labor",
            json={
                "project_id": project,
                "worker_name": "李四",
                "biz_date": "2026-05-12",
                "work_days": 2,
                "day_rate": 400,
                "amount": 1000,
            },
        )
    )
    money_eq(data["amount"], "1000.00")

    # 材料 3 吨 × 333.33 = 999.99（自动算）
    material = add_material(api, project, name="砂子", unit="方", quantity="3", unit_price="333.33")
    costs = ok_data(api.get("/api/costs", params={"project_id": project, "type": "material"}))["items"]
    target = next(item for item in costs if item["id"] == material["cost_id"])
    money_eq(target["amount"], "999.99")
    assert str(target["quantity"]) in ("3.000", "3.0", "3")


def test_五类成本列表与筛选(api, project):
    all_items = ok_data(api.get("/api/costs", params={"project_id": project, "page_size": 200}))["items"]
    assert len(all_items) >= 7
    types = {item["type"] for item in all_items}
    assert types == {"labor", "material", "machine", "misc", "advance"}

    labor = ok_data(api.get("/api/costs", params={"project_id": project, "type": "labor"})).get("items")
    assert labor is not None
    filtered = ok_data(api.get("/api/costs", params={"project_id": project, "type": "labor,misc"}))["items"]
    assert {item["type"] for item in filtered} == {"labor", "misc"}

    err_data(api.get("/api/costs", params={"type": "unknown"}), 400)

    # 关键字搜索：姓名
    by_name = ok_data(api.get("/api/costs", params={"project_id": project, "keyword": "张三"}))["items"]
    assert by_name and all(item["type"] == "labor" for item in by_name)

    # 时间段筛选按 biz_date
    ranged = ok_data(
        api.get(
            "/api/costs",
            params={"project_id": project, "start_date": "2026-05-01", "end_date": "2026-05-11"},
        )
    )["items"]
    assert all(item["biz_date"] <= "2026-05-11" for item in ranged)


def test_成本汇总接口(api, project):
    from decimal import Decimal

    data = ok_data(api.get("/api/costs/summary", params={"project_id": project}))
    assert set(data["by_type"].keys()) == {"labor", "material", "machine", "misc", "advance"}
    assert data["count"] >= 7
    expected = sum((Decimal(str(value)) for value in data["by_type"].values()), Decimal("0"))
    money_eq(data["total"], f"{expected:.2f}")
    assert expected >= Decimal("1351500.00")  # 至少包含 A4 场景的 135.15 万
    assert any(item["type"] == "labor" for item in data["by_type_detail"])
    assert any(item["category"] == "伙食费" for item in data["by_category"])
    assert any(item["project_id"] == project for item in data["by_project"])

    ranged = ok_data(
        api.get("/api/costs/summary", params={"project_id": project, "start_date": "2030-01-01"})
    )
    money_eq(ranged["total"], "0.00")


def test_修改成本同步明细与库存(api, project):
    material = add_material(api, project, name="钢筋", unit="吨", quantity="10", unit_price="4000")
    cost_id = material["cost_id"]

    updated = ok_data(api.put(f"/api/costs/{cost_id}", json={"quantity": "12", "unit_price": "4000"}))
    money_eq(updated["amount"], "48000.00")
    assert str(updated["quantity"]) in ("12.000", "12.0", "12")

    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    steel = next(item for item in balances if item["material_name"] == "钢筋")
    assert str(steel["in_qty"]) in ("12.000", "12.0", "12")

    # 换材料名 → 库存聚合跟着搬
    ok_data(api.put(f"/api/costs/{cost_id}", json={"material_name": "螺纹钢", "unit": "吨"}))
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    assert any(item["material_name"] == "螺纹钢" for item in balances)
    assert all(item["material_name"] != "钢筋" for item in balances)

    # 修改留痕（1 条 create + 2 条 update）
    logs = ok_data(api.get(f"/api/costs/{cost_id}/logs"))["items"]
    assert [item["action"] for item in logs] == ["create", "update", "update"]
    assert logs[0]["after"]["amount"] == "40000.00"
    assert logs[-1]["before"]["amount"] == "48000.00"
    assert logs[-1]["operator"] == "boss"


def test_修改人工成本(api, project):
    cost_id = add_labor(api, project, "王五", "1", "300")
    updated = ok_data(api.put(f"/api/costs/{cost_id}", json={"work_days": "3", "day_rate": "350"}))
    money_eq(updated["amount"], "1050.00")
    assert updated["worker_name"] == "王五"

    # 手改金额优先
    updated = ok_data(api.put(f"/api/costs/{cost_id}", json={"amount": "2000"}))
    money_eq(updated["amount"], "2000.00")

    # 只改姓名不影响金额
    updated = ok_data(api.put(f"/api/costs/{cost_id}", json={"worker_name": "王五五"}))
    assert updated["worker_name"] == "王五五"
    money_eq(updated["amount"], "2000.00")


def test_删除材料成本回冲库存(api, project):
    material = add_material(api, project, name="模板", unit="件", quantity="50", unit_price="100")
    cost_id = material["cost_id"]
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    assert next(item for item in balances if item["material_name"] == "模板")["in_qty"] in (50, 50.0)

    ok_data(api.delete(f"/api/costs/{cost_id}"))
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    board = next((item for item in balances if item["material_name"] == "模板"), None)
    assert board is None or str(board["in_qty"]) in ("0.000", "0.0", "0")

    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project, "material_name": "模板"}))["items"]
    assert txns == []
    # 软删除后仍可通过 include_deleted 看到
    txns = ok_data(
        api.get(
            "/api/inventory/txns",
            params={"project_id": project, "material_name": "模板", "include_deleted": True},
        )
    )["items"]
    assert txns and txns[0]["deleted"] == 1


def test_成本校验(api, project):
    err_data(
        api.post(
            "/api/costs/misc",
            json={"project_id": project, "category": "罚款", "amount": 0, "biz_date": "2026-05-01"},
        ),
        400,
    )
    err_data(
        api.post(
            "/api/costs/labor",
            json={"project_id": project, "worker_name": "张三", "biz_date": "2026-05-01", "work_days": 1, "day_rate": -1},
        ),
        400,
    )
    err_data(
        api.post(
            "/api/costs/machine",
            json={
                "project_id": project,
                "machine_name": "挖机",
                "measure": "day",
                "quantity": 1,
                "unit_price": 100,
                "biz_date": "2026-05-01",
            },
        ),
        400,
    )
    err_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": 999999,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": 1,
                "unit_price": 1,
                "biz_date": "2026-05-01",
            },
        ),
        404,
    )
    err_data(
        api.post(
            "/api/costs/misc",
            json={"project_id": project, "amount": 100, "biz_date": "2026-05-01"},
        ),
        400,
    )
