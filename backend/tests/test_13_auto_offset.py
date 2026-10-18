"""T4：付款后默认自动冲销 —— 自动冲销计划 / 应用 / 撤销口径。

用户 2026-10-16 确认的规则：
1. 保存付款后先弹「预冲窗口」列出打算冲哪几张单，点确认才真冲
2. 保留手动通道（可自己指定）；结果可事后「撤销并重选」
3. 规则可预期：同项目、同业务类型、日期最早优先；
   不够冲一张 → 部分；还有余额 → 继续冲下一张；冲完仍有余款 → 留在流水上作为可冲余额
4. 找不到可冲单据 → 正常保存流水 + 提示「本次未找到可冲销的…」
"""

from __future__ import annotations

from helpers import money_eq, ok_data


def _project(api, name: str) -> int:
    return ok_data(
        api.post(
            "/api/projects",
            json={"name": name, "client_budget": 1_000_000, "cost_budget": 800_000},
        )
    )["id"]


def _payable(api, project: int, *, amount: str, biz_type: str = "material", biz_date: str) -> int:
    return ok_data(
        api.post(
            "/api/arap",
            json={
                "project_id": project,
                "type": "payable",
                "biz_type": biz_type,
                "amount": amount,
                "biz_date": biz_date,
            },
        )
    )["id"]


def _payment(api, project: int, *, amount: str, biz_type: str = "material", biz_date: str = "2026-06-01") -> int:
    return ok_data(
        api.post(
            "/api/funds",
            json={
                "project_id": project,
                "direction": "out",
                "biz_type": biz_type,
                "amount": amount,
                "biz_date": biz_date,
            },
        )
    )["id"]


def test_自动冲销计划_日期最早优先且逐张冲(api):
    project = _project(api, "自动冲销-顺序")
    early = _payable(api, project, amount="1000", biz_date="2026-05-01")
    late = _payable(api, project, amount="1000", biz_date="2026-05-20")
    flow = _payment(api, project, amount="1500")

    plan = ok_data(api.get("/api/arap/auto-offset/plan", params={"funds_flow_id": flow}))
    assert plan["has_candidate"] is True
    assert [item["ar_ap_id"] for item in plan["plan"]] == [early, late], "应按日期最早优先"
    money_eq(plan["plan"][0]["amount_to_offset"], "1000.00")  # 先冲满最早那张
    money_eq(plan["plan"][1]["amount_to_offset"], "500.00")  # 余下 500 冲下一张（形成部分）
    money_eq(plan["plan_total"], "1500.00")
    money_eq(plan["remaining"], "0.00")

    # 只算不写：两张单此时仍未被冲销
    assert ok_data(api.get(f"/api/arap/{early}"))["settled_amount"] in (0, "0.00") or float(
        ok_data(api.get(f"/api/arap/{early}"))["settled_amount"]
    ) == 0


def test_自动冲销_金额不够时留可冲余额(api):
    project = _project(api, "自动冲销-留余额")
    _payable(api, project, amount="300", biz_date="2026-05-01")
    flow = _payment(api, project, amount="1000")  # 只要 300，剩 700

    plan = ok_data(api.get("/api/arap/auto-offset/plan", params={"funds_flow_id": flow}))
    money_eq(plan["plan_total"], "300.00")
    money_eq(plan["remaining"], "700.00"), "冲完仍有余款要留在流水上，不报错、不丢弃"
    assert "剩余" in plan["message"]

    applied = ok_data(api.post("/api/arap/auto-offset/apply", params={"funds_flow_id": flow}))
    assert applied["applied"] is True
    detail = ok_data(api.get(f"/api/funds/{flow}"))
    money_eq(detail["offset_amount"], "300.00")
    money_eq(detail["unoffset_amount"], "700.00")  # 可冲余额留在流水上


def test_自动冲销_找不到可冲单据时给提示不报错(api):
    project = _project(api, "自动冲销-无单据")
    flow = _payment(api, project, amount="500")

    plan = ok_data(api.get("/api/arap/auto-offset/plan", params={"funds_flow_id": flow}))
    assert plan["has_candidate"] is False
    assert plan["plan"] == []
    assert "未找到可冲销" in plan["message"]

    # 正常保存流水（apply 不报错，只是什么都没冲）
    applied = ok_data(api.post("/api/arap/auto-offset/apply", params={"funds_flow_id": flow}))
    assert applied["applied"] is False
    detail = ok_data(api.get(f"/api/funds/{flow}"))
    money_eq(detail["offset_amount"], "0.00")
    money_eq(detail["unoffset_amount"], "500.00")


def test_自动冲销_只冲同项目同类型的未结单据(api):
    project_a = _project(api, "自动冲销-项目A")
    project_b = _project(api, "自动冲销-项目B")
    mine = _payable(api, project_a, amount="800", biz_date="2026-05-02")
    _payable(api, project_b, amount="800", biz_date="2026-05-01")  # 别的项目、日期更早，不该被冲
    # 应收单也不能被付款流水冲
    ok_data(
        api.post(
            "/api/arap",
            json={
                "project_id": project_a,
                "type": "receivable",
                "biz_type": "progress",
                "amount": "800",
                "biz_date": "2026-04-01",
            },
        )
    )
    flow = _payment(api, project_a, amount="800")

    plan = ok_data(api.get("/api/arap/auto-offset/plan", params={"funds_flow_id": flow}))
    assert [item["ar_ap_id"] for item in plan["plan"]] == [mine]


def test_自动冲销结果可撤销并重选(api):
    """结果窗里的「撤销并重选」：撤销本次自动冲销 → 单据回到未结 → 可重新手工指定。"""
    project = _project(api, "自动冲销-撤销")
    arap = _payable(api, project, amount="600", biz_date="2026-05-03")
    flow = _payment(api, project, amount="600")

    applied = ok_data(api.post("/api/arap/auto-offset/apply", params={"funds_flow_id": flow}))
    assert applied["applied"] is True
    assert ok_data(api.get(f"/api/arap/{arap}"))["status"] == "closed"

    # 撤销本次自动冲销
    for offset_id in applied["offset_ids"]:
        ok_data(api.delete(f"/api/arap/offset/{offset_id}"))
    back = ok_data(api.get(f"/api/arap/{arap}"))
    assert back["status"] == "open"
    money_eq(back["settled_amount"], "0.00")
    money_eq(ok_data(api.get(f"/api/funds/{flow}"))["unoffset_amount"], "600.00")

    # 手工通道仍可用：自己指定冲 200
    manual = ok_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow,
                "offsets": [{"ar_ap_id": arap, "amount": "200"}],
                "offset_date": "2026-06-01",
            },
        )
    )
    money_eq(manual["offset_amount"], "200.00")
    assert ok_data(api.get(f"/api/arap/{arap}"))["status"] == "partial"


def test_自动冲销_已部分冲过的流水只按剩余额度算(api):
    project = _project(api, "自动冲销-剩余额度")
    first = _payable(api, project, amount="1000", biz_date="2026-05-01")
    second = _payable(api, project, amount="1000", biz_date="2026-05-02")
    flow = _payment(api, project, amount="1500")
    # 先手工冲掉 1000
    ok_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow,
                "offsets": [{"ar_ap_id": first, "amount": "1000"}],
                "offset_date": "2026-06-01",
            },
        )
    )
    plan = ok_data(api.get("/api/arap/auto-offset/plan", params={"funds_flow_id": flow}))
    money_eq(plan["available"], "500.00")  # 只剩 500 可冲
    assert [item["ar_ap_id"] for item in plan["plan"]] == [second]
    money_eq(plan["plan_total"], "500.00")
