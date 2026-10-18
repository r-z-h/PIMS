"""成本 ↔ 应付单自动联动（2026-10-15 需求，逐条对应确认过的口径）。

覆盖：
1. 录五类成本 → 同一事务自动生成应付单（金额＝全额、类型/对方/日期、cost_id 关联）
2. 登记已付 → 生成付款流水 + 自动冲销，应付单状态转 部分/已结清
3. 不填已付 → 应付单全额挂账（open）
4. 已付超过未结 → 400
5. 成本改金额 → 应付单实时跟着改
6. 已被冲销后再改成本金额 → 400，提示先撤销冲销
7. 成本删除 → 应付单保留，并回传提示
8. 撤销冲销后可以再改成本金额
"""

from __future__ import annotations

from helpers import err_data, ok_data


def _project(api, name: str) -> int:
    data = ok_data(
        api.post(
            "/api/projects",
            json={"name": name, "client_budget": 1_000_000, "cost_budget": 800_000},
        )
    )
    return int(data["id"])


def _payables(api, project_id: int) -> list[dict]:
    data = ok_data(api.get("/api/arap", params={"type": "payable", "project_id": project_id}))
    return data["items"]


def test_录成本自动生成应付单_五类都覆盖(api):
    pid = _project(api, "联动-五类")

    cases = [
        ("/api/costs/labor", {"worker_name": "张三", "work_days": 5, "day_rate": 300, "biz_date": "2026-05-01"}, "labor", "张三", 1500),
        ("/api/costs/material", {"material_name": "水泥", "unit": "吨", "quantity": 10, "unit_price": 400, "supplier": "某建材", "biz_date": "2026-05-02"}, "material", "某建材", 4000),
        ("/api/costs/machine", {"machine_name": "挖机", "measure": "shift", "quantity": 2, "unit_price": 2000, "lessor": "李老板", "biz_date": "2026-05-03"}, "machine", "李老板", 4000),
        ("/api/costs/misc", {"category": "伙食费", "amount": 500, "biz_date": "2026-05-04"}, "misc", None, 500),
        ("/api/costs/advance", {"payer": "老板", "purpose": "临时买料", "amount": 8000, "biz_date": "2026-05-05"}, "advance_pay", "老板", 8000),
    ]

    total = 0
    for path, payload, biz_type, partner, amount in cases:
        body = {"project_id": pid, **payload}
        created = ok_data(api.post(path, json=body))
        cost_id = int(created["cost_id"])
        total += amount

        # 1) 应付单自动生成，且字段对得上
        summary = ok_data(api.get(f"/api/costs/{cost_id}/payable"))
        assert summary["has_payable"] is True, f"{path} 没有生成应付单"
        arap = summary["arap"]
        assert arap["biz_type"] == biz_type, f"{path} 类型应为 {biz_type}，实际 {arap['biz_type']}"
        assert float(arap["amount"]) == amount
        assert float(arap["settled_amount"]) == 0
        assert arap["status"] == "open"
        if partner is not None:
            assert arap["partner"] == partner, f"{path} 对方应为 {partner}，实际 {arap['partner']}"

        # 2) 成本详情能通过 cost_id 反查回应付单（关联关系成立）
        assert arap["cost_id"] == cost_id

    rows = _payables(api, pid)
    assert len(rows) == 5, f"应有 5 张应付单，实际 {len(rows)}"
    assert sum(float(r["amount"]) for r in rows) == total


def test_登记已付_生成付款流水并自动冲销(api):
    pid = _project(api, "联动-已付")
    created = ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": pid, "material_name": "钢筋", "unit": "吨",
                "quantity": 1, "unit_price": 10000, "supplier": "某钢厂", "biz_date": "2026-05-06",
            },
        )
    )
    cost_id = int(created["cost_id"])

    # 1 万里先付 3000
    result = ok_data(
        api.post(
            f"/api/costs/{cost_id}/pay",
            json={"paid_amount": 3000, "pay_method": "transfer", "pay_date": "2026-05-07", "remark": "首付"},
        )
    )
    assert result["recorded"] is True
    assert float(result["paid_amount"]) == 3000
    assert result["offset_ids"], "应产生冲销记录"
    assert result["arap"]["status"] == "partial"
    assert float(result["arap"]["settled_amount"]) == 3000

    # 付款流水也真的生成了
    flows = ok_data(api.get("/api/funds", params={"project_id": pid, "direction": "out"}))
    assert len(flows["items"]) == 1
    flow = flows["items"][0]
    assert float(flow["amount"]) == 3000
    assert flow["pay_method"] == "transfer"
    assert flow["biz_date"] == "2026-05-07"
    assert float(flow["offset_amount"]) == 3000

    # 应付单未结 = 7000
    summary = ok_data(api.get(f"/api/costs/{cost_id}/payable"))
    assert float(summary["unsettled"]) == 7000
    assert float(summary["paid_total"]) == 3000
    assert len(summary["offsets"]) == 1


def test_不填已付_全额挂账(api):
    pid = _project(api, "联动-未付")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "罚款", "amount": 800, "biz_date": "2026-05-08"})
    )
    cost_id = int(created["cost_id"])

    result = ok_data(api.post(f"/api/costs/{cost_id}/pay", json={}))
    assert result["recorded"] is False
    assert result["arap"]["status"] == "open"
    assert float(result["arap"]["unsettled"]) == 800

    # 没有产生付款流水
    flows = ok_data(api.get("/api/funds", params={"project_id": pid, "direction": "out"}))
    assert flows["items"] == []


def test_已付超过未结_400(api):
    pid = _project(api, "联动-超额")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "罚款", "amount": 100, "biz_date": "2026-05-09"})
    )
    cost_id = int(created["cost_id"])
    payload = err_data(api.post(f"/api/costs/{cost_id}/pay", json={"paid_amount": 500}), 400)
    assert "超过" in payload["message"]


def test_改成本金额_应付单实时同步(api):
    pid = _project(api, "联动-改额")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "转运费", "amount": 1000, "biz_date": "2026-05-10"})
    )
    cost_id = int(created["cost_id"])

    ok_data(api.put(f"/api/costs/{cost_id}", json={"amount": 2500}))
    summary = ok_data(api.get(f"/api/costs/{cost_id}/payable"))
    assert float(summary["arap"]["amount"]) == 2500
    assert float(summary["unsettled"]) == 2500


def test_已冲销后再改金额_被拒绝_撤销后可改(api):
    pid = _project(api, "联动-拒绝")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "招待费", "amount": 2000, "biz_date": "2026-05-11"})
    )
    cost_id = int(created["cost_id"])

    paid = ok_data(api.post(f"/api/costs/{cost_id}/pay", json={"paid_amount": 500}))
    offset_id = int(paid["offset_ids"][0])

    # 已有冲销 → 拒绝改金额，并提示先撤销
    payload = err_data(api.put(f"/api/costs/{cost_id}", json={"amount": 3000}), 400)
    assert "冲销" in payload["message"]
    assert "撤销" in payload["message"]

    # 撤销冲销后可以改
    ok_data(api.delete(f"/api/arap/offset/{offset_id}"))
    ok_data(api.put(f"/api/costs/{cost_id}", json={"amount": 3000}))
    summary = ok_data(api.get(f"/api/costs/{cost_id}/payable"))
    assert float(summary["arap"]["amount"]) == 3000
    assert summary["arap"]["status"] == "open"


def test_只改备注不改金额_即使有冲销也允许(api):
    pid = _project(api, "联动-只改备注")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "临时工", "amount": 600, "biz_date": "2026-05-12"})
    )
    cost_id = int(created["cost_id"])
    ok_data(api.post(f"/api/costs/{cost_id}/pay", json={"paid_amount": 600}))

    ok_data(api.put(f"/api/costs/{cost_id}", json={"remark": "补一句备注"}))
    summary = ok_data(api.get(f"/api/costs/{cost_id}/payable"))
    assert summary["arap"]["status"] == "closed"
    assert float(summary["arap"]["amount"]) == 600


def test_删除成本_应付单保留并提示(api):
    pid = _project(api, "联动-删除")
    created = ok_data(
        api.post("/api/costs/misc", json={"project_id": pid, "category": "其他", "amount": 700, "biz_date": "2026-05-13"})
    )
    cost_id = int(created["cost_id"])

    result = ok_data(api.delete(f"/api/costs/{cost_id}"))
    assert result["deleted"] is True
    assert result["payable"]["kept"] is True, "应付单应保留"
    assert float(result["payable"]["payable_amount"]) == 700
    assert "保留" in result["payable"]["message"]

    # 应付单确实还在（列表里能查到，状态 open）
    rows = _payables(api, pid)
    assert len(rows) == 1
    assert rows[0]["status"] == "open"
    assert float(rows[0]["amount"]) == 700


def test_手工新增的应付单不会被误认为自动生成(api):
    pid = _project(api, "联动-手工")
    manual = ok_data(
        api.post(
            "/api/arap",
            json={
                "project_id": pid, "type": "payable", "biz_type": "other",
                "amount": 1234, "biz_date": "2026-05-14", "partner": "某人",
            },
        )
    )
    assert manual["cost_id"] in (None, 0) or not manual.get("cost_id")
    rows = _payables(api, pid)
    assert len(rows) == 1
    assert float(rows[0]["amount"]) == 1234
