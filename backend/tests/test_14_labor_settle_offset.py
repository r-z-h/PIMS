"""T6：结算页「登记发放」要接上账 —— 生成付款流水 + 自动冲销该工人的应付单。

用户 2026-10-16 确认（方案①「打通」）：
结算页与往来页必须是**同一本账** —— 结算页发了多少，往来页就少欠多少。
此前 `labor_service.pay()` 不碰 `arap` / `offset` / `funds`，导致同一笔工资
既显示"已发"又显示"未收付"。
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


def _labor_cost(api, project: int, *, worker: str, days: str, rate: str, biz_date: str) -> int:
    """录一笔人工（会同时自动生成一张人工费应付单）。"""
    return ok_data(
        api.post(
            "/api/costs/labor",
            json={
                "project_id": project,
                "worker_name": worker,
                "work_days": days,
                "day_rate": rate,
                "biz_date": biz_date,
            },
        )
    )["cost_id"]


def _settle_and_pay(api, project: int, *, worker: str, amount: str, pay_date: str = "2026-07-05"):
    """生成结算单并登记发放，返回（结算单 id, 发放返回体）。"""
    ok_data(api.post("/api/labor/settle", json={"project_id": project, "settle_date": "2026-07-01"}))
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
    row = next(s for s in settles if s["worker_name"] == worker)
    paid = ok_data(
        api.post(
            f"/api/labor/settles/{row['id']}/pay",
            json={"amount": amount, "pay_date": pay_date, "pay_method": "wechat"},
        )
    )
    return int(row["id"]), paid


def test_登记发放会生成付款流水并冲销应付单(api):
    project = _project(api, "结算联动-结清")
    _labor_cost(api, project, worker="张三", days="5", rate="300", biz_date="2026-05-01")

    # 录成本时已自动生成一张 1500 的应付单
    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    assert len(payables) == 1
    arap_id = payables[0]["id"]
    money_eq(payables[0]["unsettled"], "1500.00")

    _, paid = _settle_and_pay(api, project, worker="张三", amount="1500")

    # ① 生成了付款流水
    flow_id = paid.get("funds_flow_id")
    assert flow_id, f"登记发放必须生成付款流水：{paid}"
    flow = ok_data(api.get(f"/api/funds/{flow_id}"))
    assert flow["direction"] == "out"
    assert flow["biz_type"] == "labor"
    assert flow["partner"] == "张三"
    money_eq(flow["amount"], "1500.00")
    assert flow["biz_date"] == "2026-07-05"

    # ② 应付单被冲销并结清（往来页与结算页同一本账）
    arap = ok_data(api.get(f"/api/arap/{arap_id}"))
    money_eq(arap["settled_amount"], "1500.00")
    money_eq(arap["unsettled"], "0.00")
    assert arap["status"] == "closed"

    # ③ 结算页的「欠款总览」也要立刻反映出来（与应付单同一本账）
    ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    row = next(item for item in ov["items"] if item["partner"] == "张三")
    money_eq(row["amount_due"], "1500.00")
    money_eq(row["paid_amount"], "1500.00")
    money_eq(row["unsettled"], "0.00")
    assert row["status"] == "closed"
    # 付款方式构成
    assert row["paid_methods"][0]["pay_method"] == "wechat"


def test_登记发放只发一半时应付单转为部分(api):
    project = _project(api, "结算联动-部分")
    _labor_cost(api, project, worker="李四", days="10", rate="300", biz_date="2026-05-02")

    _, paid = _settle_and_pay(api, project, worker="李四", amount="1000")

    flow = ok_data(api.get(f"/api/funds/{paid['funds_flow_id']}"))
    money_eq(flow["offset_amount"], "1000.00")

    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    assert len(payables) == 1
    money_eq(payables[0]["settled_amount"], "1000.00")
    money_eq(payables[0]["unsettled"], "2000.00")
    assert payables[0]["status"] == "partial"


def test_多笔工天_发放按日期最早优先逐张冲销(api):
    project = _project(api, "结算联动-多张单")
    early = _labor_cost(api, project, worker="王五", days="2", rate="300", biz_date="2026-05-01")  # 600
    late = _labor_cost(api, project, worker="王五", days="3", rate="300", biz_date="2026-05-20")  # 900

    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    by_cost = {p["cost_id"]: p for p in payables}
    early_arap, late_arap = by_cost[early]["id"], by_cost[late]["id"]

    # 发 800：先冲最早的 600，余 200 冲下一张
    _, paid = _settle_and_pay(api, project, worker="王五", amount="800")

    early_row = ok_data(api.get(f"/api/arap/{early_arap}"))
    late_row = ok_data(api.get(f"/api/arap/{late_arap}"))
    money_eq(early_row["settled_amount"], "600.00")
    assert early_row["status"] == "closed", "日期最早的那张应先被冲满"
    money_eq(late_row["settled_amount"], "200.00")
    money_eq(late_row["unsettled"], "700.00")
    assert late_row["status"] == "partial"
    assert paid["offset"]["applied"] is True
    assert len(paid["offset"]["offset_ids"]) == 2


def test_没有应付单可冲时_流水照常保留并给出提示(api):
    """人工成本的应付单被手工删掉后发放，不能让"钱已发出去"这件事丢失。"""
    project = _project(api, "结算联动-无可冲单")
    cost_id = _labor_cost(api, project, worker="赵六", days="4", rate="300", biz_date="2026-05-03")

    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    arap_id = next(p["id"] for p in payables if p["cost_id"] == cost_id)
    ok_data(api.delete(f"/api/arap/{arap_id}"))

    _, paid = _settle_and_pay(api, project, worker="赵六", amount="1200")

    # 流水仍然生成（钱确实发出去了）
    flow = ok_data(api.get(f"/api/funds/{paid['funds_flow_id']}"))
    money_eq(flow["amount"], "1200.00")
    money_eq(flow["offset_amount"], "0.00")
    money_eq(flow["unoffset_amount"], "1200.00")  # 留作可冲余额
    assert paid["offset"]["applied"] is False
    assert "未找到" in (paid.get("offset_hint") or "")


def test_结算发放不影响利润(api):
    """铁律：结算只汇总与发放，**绝不新增成本**；付款/冲销都不参与利润计算。"""
    project = _project(api, "结算联动-利润")
    _labor_cost(api, project, worker="孙七", days="5", rate="300", biz_date="2026-05-04")

    before = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]
    money_eq(before["actual_cost"], "1500.00")
    money_eq(before["settle_profit"], "998500.00")

    _settle_and_pay(api, project, worker="孙七", amount="1500")

    after = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]
    money_eq(after["actual_cost"], "1500.00"), "发放不能重复计入成本"
    money_eq(after["settle_profit"], "998500.00")
    # 结算不重复计入成本，但资金口径要能看到这笔钱出去了
    funds = ok_data(api.get(f"/api/projects/{project}/overview"))["funds"]
    money_eq(funds["total_out"], "1500.00")


def test_撤销冲销后结算单状态不变但欠款回来(api):
    """撤销冲销只回滚欠款口径，不回滚"已经发出去的钱"（结算单仍是已发）。"""
    project = _project(api, "结算联动-撤销")
    _labor_cost(api, project, worker="周八", days="5", rate="300", biz_date="2026-05-05")

    _, paid = _settle_and_pay(api, project, worker="周八", amount="1500")
    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    arap_id = payables[0]["id"]
    assert payables[0]["status"] == "closed"

    for offset_id in paid["offset"]["offset_ids"]:
        ok_data(api.delete(f"/api/arap/offset/{offset_id}"))

    back = ok_data(api.get(f"/api/arap/{arap_id}"))
    assert back["status"] == "open", "撤销冲销后欠款要回来"
    money_eq(back["unsettled"], "1500.00")

    # 结算页的欠款总览也应跟着回到"还欠 1500"（同一本账）
    ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    row = next(item for item in ov["items"] if item["partner"] == "周八")
    money_eq(row["paid_amount"], "0.00")
    money_eq(row["unsettled"], "1500.00")
    assert row["status"] == "open"
    # 快照本身还在（本期该结多少不因撤销冲销而变）
    settle = next(
        s
        for s in ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
        if s["id"] == paid["id"]
    )
    money_eq(settle["amount_due"], "1500.00")
