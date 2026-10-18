"""T3：关联成本摘要 —— 接口层验证。"""

from __future__ import annotations

from helpers import money_eq, ok_data


def _add_material(api, project: int, **overrides) -> int:
    payload = {
        "project_id": project,
        "material_name": "水泥",
        "unit": "吨",
        "quantity": "100",
        "unit_price": "400",
        "biz_date": "2026-05-10",
    }
    payload.update(overrides)
    return ok_data(api.post("/api/costs/material", json=payload))["cost_id"]


def test_库存流水带关联成本摘要(api, project):
    """库存流水的「关联成本」列要能显示成 `#id（材料 · 水泥 40,000.00）`。"""
    cost_id = _add_material(api, project)

    txns = ok_data(api.get("/api/inventory/txns", params={"project_id": project}))["items"]
    inbound = [t for t in txns if t["txn_type"] == "in"]
    assert inbound, "材料采购应生成一条入库流水"
    row = inbound[0]
    assert row["cost_id"] == cost_id

    brief = row.get("cost")
    assert brief is not None, "入库流水必须带上关联成本摘要"
    assert brief["type"] == "material"
    assert brief["type_label"] == "材料"
    assert brief["subject"] == "水泥"
    money_eq(brief["amount"], "40000.00")
    assert brief["biz_date"] == row["biz_date"]
    assert row["cost_label"] == "材料 · 水泥 40000.00"

    # 领用流水没有关联成本，保持 null（前端显示 "-"，不要变成报错）
    ok_data(
        api.post(
            "/api/inventory/out",
            json={
                "project_id": project,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": "10",
                "biz_date": "2026-05-20",
            },
        )
    )
    txns2 = ok_data(api.get("/api/inventory/txns", params={"project_id": project}))["items"]
    outbound = [t for t in txns2 if t["txn_type"] == "out"]
    assert outbound
    assert outbound[0]["cost_id"] is None
    assert outbound[0].get("cost") is None


def test_成本摘要接口(api, project):
    """GET /api/costs/{id}/brief —— 不加载明细表，只给类别/对象/金额/日期。"""
    cost_id = _add_material(api, project, material_name="石子", unit="车", quantity="10", unit_price="500")

    brief = ok_data(api.get(f"/api/costs/{cost_id}/brief"))
    assert brief["id"] == cost_id
    assert brief["type_label"] == "材料"
    assert brief["subject"] == "石子"
    money_eq(brief["amount"], "5000.00")
    assert brief["label"] == "材料 · 石子 5000.00"

    # 杂费没有 partner，用「小类」当对象名
    misc = ok_data(
        api.post(
            "/api/costs/misc",
            json={"project_id": project, "category": "伙食费", "amount": "800", "biz_date": "2026-05-13"},
        )
    )
    misc_brief = ok_data(api.get(f"/api/costs/{misc['cost_id']}/brief"))
    assert misc_brief["subject"] == "伙食费"
    assert misc_brief["label"] == "杂费 · 伙食费 800.00"

    # 不存在的成本 → 404
    missing = api.get("/api/costs/999999/brief")
    assert missing.status_code == 404


def test_删掉的成本仍能取到摘要(api, project):
    """库存流水可能指向已被删除的成本，此时摘要仍要能取到（前端显示删除标记），不能 500。"""
    cost_id = _add_material(api, project, material_name="模板", unit="个", quantity="10", unit_price="30")
    ok_data(api.delete(f"/api/costs/{cost_id}"))

    brief = ok_data(api.get(f"/api/costs/{cost_id}/brief"))
    assert brief["id"] == cost_id
    assert brief["deleted"] == 1
