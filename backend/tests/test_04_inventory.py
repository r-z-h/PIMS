"""库存：入库 / 领用 / 余量 / 项目隔离（FR-6）。"""

from __future__ import annotations

from helpers import add_material, err_data, money_eq, ok_data


def test_采购自动入库且成本同步(api, project):
    data = add_material(api, project, name="水泥", unit="吨", quantity="100", unit_price="400")
    assert data["inventory_txn_id"] > 0

    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    assert len(balances) == 1
    row = balances[0]
    assert row["material_name"] == "水泥"
    assert str(row["in_qty"]) in ("100.000", "100.0", "100")
    assert str(row["balance"]) in ("100.000", "100.0", "100")
    money_eq(row["last_unit_price"], "400.00")
    money_eq(row["balance_amount"], "40000.00")

    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project}))["items"]
    assert len(txns) == 1
    assert txns[0]["txn_type"] == "in"
    assert txns[0]["txn_label"] == "入库"
    assert txns[0]["cost_id"] == data["cost_id"]
    assert txns[0]["supplier"] == "某某建材"


def test_库存必须指定项目(api):
    err_data(api.get("/api/inventory"), 400)


def test_领用只减库存不生成成本(api, project):
    before = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    data = ok_data(
        api.post(
            "/api/inventory/out",
            json={
                "project_id": project,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": 80,
                "biz_date": "2026-05-20",
                "remark": "5#楼三层砌筑",
            },
        )
    )
    assert data["enough"] is True
    assert str(data["balance"]) in ("20.000", "20.0", "20")
    after = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    assert before == after

    # 领用不写 cost
    costs = ok_data(api.get("/api/costs", params={"project_id": project, "type": "material"}))["items"]
    assert len(costs) == 1


def test_余量不足返回enough_false但仍然成功(api, project):
    data = ok_data(
        api.post(
            "/api/inventory/out",
            json={"project_id": project, "material_name": "水泥", "unit": "吨", "quantity": 100, "biz_date": "2026-05-21"},
        )
    )
    assert data["enough"] is False  # 允许先领后补录
    assert str(data["balance"]) in ("-80.000", "-80.0", "-80")


def test_手工补录入库不生成成本(api, project):
    before = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    ok_data(
        api.post(
            "/api/inventory/in",
            json={
                "project_id": project,
                "material_name": "石子",
                "unit": "方",
                "quantity": 30,
                "unit_price": 120,
                "supplier": "某某砂石",
                "biz_date": "2026-05-08",
            },
        )
    )
    after = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    assert before == after
    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project, "material_name": "石子"}))["items"]
    assert txns[0]["cost_id"] is None


def test_修改库存流水同步重算聚合(api, project):
    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project, "material_name": "石子"}))["items"]
    txn_id = txns[0]["id"]

    ok_data(api.put(f"/api/inventory/txns/{txn_id}", json={"quantity": "50", "material_name": "碎石"}))
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    assert any(item["material_name"] == "碎石" and str(item["in_qty"]) in ("50.000", "50.0", "50") for item in balances)
    assert all(item["material_name"] != "石子" for item in balances)

    # 改成另一个单位 → 又是一条独立聚合
    ok_data(api.put(f"/api/inventory/txns/{txn_id}", json={"unit": "吨"}))
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    assert any(item["material_name"] == "碎石" and item["unit"] == "吨" for item in balances)


def test_删除库存流水同步重算聚合(api, project):
    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project, "material_name": "碎石"}))["items"]
    txn_id = txns[0]["id"]
    ok_data(api.delete(f"/api/inventory/txns/{txn_id}"))
    balances = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    row = next((item for item in balances if item["material_name"] == "碎石"), None)
    assert row is None or str(row["in_qty"]) in ("0.000", "0.0", "0")
    err_data(api.delete(f"/api/inventory/txns/{txn_id}"), 404)


def test_项目之间库存干净隔离(api, project):
    other = ok_data(
        api.post("/api/projects", json={"name": "隔离项目", "client_budget": "1000", "cost_budget": "800"})
    )["id"]
    add_material(api, other, name="水泥", unit="吨", quantity="7", unit_price="400")

    mine = ok_data(api.get("/api/inventory", params={"project_id": project}))["items"]
    theirs = ok_data(api.get("/api/inventory", params={"project_id": other}))["items"]
    assert all(item["project_id"] == project for item in mine)
    assert len(theirs) == 1
    assert str(theirs[0]["balance"]) in ("7.000", "7.0", "7")


def test_库存流水筛选(api, project):
    out_txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project, "txn_type": "out"}))["items"]
    assert out_txns and all(item["txn_type"] == "out" for item in out_txns)

    ranged = ok_data(
        api.get("/api/inventory/txns", params={"project_id": project, "start_date": "2026-05-20", "end_date": "2026-05-31"})
    )["items"]
    assert ranged and all("2026-05-20" <= item["biz_date"] <= "2026-05-31" for item in ranged)

    err_data(api.get("/api/inventory/txns", params={"txn_type": "bad"}), 400)
