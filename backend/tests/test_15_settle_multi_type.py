"""结算从「人工」泛化到五类成本（2026-10-16 需求）。

口径：五类的结算机制相同，只是**汇总依据不同**——
人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人。
每类都能：预览 → 保存结算单 → 登记发放 → 生成对应业务类型的付款流水 + 冲销该对象的应付单。
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


def _labor_cost_only(api, project: int, *, worker: str, days: str, rate: str, biz_date: str) -> int:
    """只录一笔人工（会同时自动生成一张人工费应付单），返回 cost_id。"""
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


def test_结算类别接口列出五类与汇总依据(api):
    items = ok_data(api.get("/api/labor/types"))["items"]
    mapping = {item["cost_type"]: item for item in items}
    assert set(mapping) == {"labor", "material", "machine", "misc", "advance"}
    assert mapping["labor"]["group_label"] == "按工人姓名"
    assert mapping["material"]["group_label"] == "按供应商"
    assert mapping["machine"]["group_label"] == "按出租方"
    assert mapping["misc"]["group_label"] == "按杂费小类"
    assert mapping["advance"]["group_label"] == "按垫付人"


def test_材料结算按供应商汇总(api):
    project = _project(api, "五类结算-材料")
    ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": project,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": "10",
                "unit_price": "400",
                "supplier": "某某建材",
                "biz_date": "2026-05-10",
            },
        )
    )
    ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": project,
                "material_name": "砂子",
                "unit": "车",
                "quantity": "2",
                "unit_price": "500",
                "supplier": "某某建材",
                "biz_date": "2026-05-11",
            },
        )
    )
    # 没填供应商的一笔 → 应归入「（未填对方）」且也能结算
    ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": project,
                "material_name": "石子",
                "unit": "车",
                "quantity": "1",
                "unit_price": "300",
                "biz_date": "2026-05-12",
            },
        )
    )

    preview = ok_data(
        api.get("/api/labor/preview", params={"project_id": project, "cost_type": "material"})
    )
    assert preview["cost_type"] == "material"
    assert preview["group_label"] == "按供应商"
    by_partner = {item["partner"]: item for item in preview["items"]}
    assert set(by_partner) == {"某某建材", "（未填对方）"}
    money_eq(by_partner["某某建材"]["amount_due"], "5000.00")  # 10×400 + 2×500
    money_eq(by_partner["（未填对方）"]["amount_due"], "300.00")
    money_eq(preview["total_amount"], "5300.00")

    # 保存结算单 → 两张（供应商 + 未填对方）
    saved = ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "material"}))
    assert saved["cost_type"] == "material"
    assert saved["created"] == 2

    rows = ok_data(api.get("/api/labor/settles", params={"project_id": project, "cost_type": "material"}))["items"]
    assert {row["partner"] for row in rows} == {"某某建材", "（未填对方）"}
    assert all(row["cost_type"] == "material" for row in rows)


def test_机械结算按出租方汇总(api):
    project = _project(api, "五类结算-机械")
    ok_data(
        api.post(
            "/api/costs/machine",
            json={
                "project_id": project,
                "machine_name": "挖机",
                "measure": "shift",
                "quantity": "3",
                "unit_price": "2000",
                "lessor": "李老板",
                "biz_date": "2026-05-11",
            },
        )
    )
    preview = ok_data(api.get("/api/labor/preview", params={"project_id": project, "cost_type": "machine"}))
    money_eq(preview["total_amount"], "6000.00")
    assert preview["items"][0]["partner"] == "李老板"
    assert "工天" not in preview["group_label"]


def test_杂费结算按小类汇总(api):
    project = _project(api, "五类结算-杂费")
    for category, amount in (("伙食费", "800"), ("伙食费", "200"), ("转运费", "500")):
        ok_data(
            api.post(
                "/api/costs/misc",
                json={"project_id": project, "category": category, "amount": amount, "biz_date": "2026-05-13"},
            )
        )
    preview = ok_data(api.get("/api/labor/preview", params={"project_id": project, "cost_type": "misc"}))
    by_partner = {item["partner"]: item["amount_due"] for item in preview["items"]}
    assert by_partner == {"伙食费": 1000.0, "转运费": 500.0} or (
        float(by_partner["伙食费"]) == 1000.0 and float(by_partner["转运费"]) == 500.0
    )
    money_eq(preview["total_amount"], "1500.00")


def test_垫付结算按垫付人汇总(api):
    project = _project(api, "五类结算-垫付")
    ok_data(
        api.post(
            "/api/costs/advance",
            json={
                "project_id": project,
                "payer": "王老板",
                "purpose": "临时买料",
                "amount": "5000",
                "biz_date": "2026-05-15",
            },
        )
    )
    preview = ok_data(api.get("/api/labor/preview", params={"project_id": project, "cost_type": "advance"}))
    assert preview["items"][0]["partner"] == "王老板"
    money_eq(preview["total_amount"], "5000.00")


def test_材料发放生成材料款流水并冲销应付单(api):
    """发放要接上账：材料结算发钱 → 生成 material 流水 → 冲销材料款应付单。"""
    project = _project(api, "五类结算-材料发放")
    ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": project,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": "10",
                "unit_price": "400",
                "supplier": "某某建材",
                "biz_date": "2026-05-10",
            },
        )
    )
    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "material"}))
    rows = ok_data(api.get("/api/labor/settles", params={"project_id": project, "cost_type": "material"}))["items"]
    settle_id = rows[0]["id"]

    paid = ok_data(
        api.post(
            f"/api/labor/settles/{settle_id}/pay",
            json={"amount": "4000", "pay_date": "2026-05-20", "pay_method": "transfer"},
        )
    )
    assert paid["cost_type"] == "material"

    # ① 流水业务类型是「材料款」而不是人工费
    flow = ok_data(api.get(f"/api/funds/{paid['funds_flow_id']}"))
    assert flow["direction"] == "out"
    assert flow["biz_type"] == "material"
    assert flow["partner"] == "某某建材"
    money_eq(flow["amount"], "4000.00")

    # ② 冲销了材料款应付单
    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    assert len(payables) == 1
    assert payables[0]["biz_type"] == "material"
    money_eq(payables[0]["settled_amount"], "4000.00")
    money_eq(payables[0]["unsettled"], "0.00")
    assert payables[0]["status"] == "closed"

    # ③ 成本没有被重复计入
    overview = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "4000.00")


def test_五类结算互不串台(api):
    """同一项目下人工与材料各自结算，不应互相影响。"""
    project = _project(api, "五类结算-隔离")
    ok_data(
        api.post(
            "/api/costs/labor",
            json={"project_id": project, "worker_name": "张三", "work_days": "2", "day_rate": "300", "biz_date": "2026-05-01"},
        )
    )
    ok_data(
        api.post(
            "/api/costs/material",
            json={
                "project_id": project,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": "1",
                "unit_price": "400",
                "supplier": "某某建材",
                "biz_date": "2026-05-02",
            },
        )
    )
    labor = ok_data(api.get("/api/labor/preview", params={"project_id": project, "cost_type": "labor"}))
    material = ok_data(api.get("/api/labor/preview", params={"project_id": project, "cost_type": "material"}))
    assert [item["partner"] for item in labor["items"]] == ["张三"]
    money_eq(labor["total_amount"], "600.00")
    assert [item["partner"] for item in material["items"]] == ["某某建材"]
    money_eq(material["total_amount"], "400.00")

    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "labor"}))
    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "material"}))
    all_rows = ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
    assert {row["cost_type"] for row in all_rows} == {"labor", "material"}

    # 按类别过滤只返回该类
    only_labor = ok_data(api.get("/api/labor/settles", params={"project_id": project, "cost_type": "labor"}))["items"]
    assert len(only_labor) == 1 and only_labor[0]["cost_type"] == "labor"


def test_欠款总览_从别的入口付的钱也要算进已付(api):
    """**用户实测发现的 bug 的回归测试**（2026-10-16）。

    场景：沈八有 4500 人工成本 → 自动生成 4500 应付单；
    用户从「收/付款」页付了 500 并冲销了那张应付单
    ——**这条路径不会回写结算单**，所以旧实现里结算页仍显示「已发 0、未发 4500」，
    而应付单已经是 4000 未结；更糟的是发放上限按错的数算，会多付。

    现在「已付/还欠」一律由应付单上的冲销记录算，所以必须立刻反映成 500 / 4000。
    """
    from helpers import add_funds

    project = _project(api, "总览-跨入口付款")
    _labor_cost_only(api, project, worker="沈八", days="15", rate="300", biz_date="2026-10-01")  # 4500

    # 从「收/付款」页付 500（这是**不碰结算单**的路径）
    flow_id = add_funds(api, project, direction="out", amount="500", biz_type="labor", biz_date="2026-10-16")
    payables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "payable"}))["items"]
    arap_id = payables[0]["id"]
    money_eq(payables[0]["unsettled"], "4500.00")

    # 手工冲销那 500（模拟收/付款页保存后的预冲窗口）
    ok_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": arap_id, "amount": "500"}],
                "offset_date": "2026-10-16",
            },
        )
    )
    money_eq(ok_data(api.get(f"/api/arap/{arap_id}"))["unsettled"], "4000.00")

    # 结算页的欠款总览必须与应付单一致（旧实现这里是 0 / 4500）
    ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    row = next(item for item in ov["items"] if item["partner"] == "沈八")
    money_eq(row["amount_due"], "4500.00")
    money_eq(row["paid_amount"], "500.00")
    money_eq(row["unsettled"], "4000.00")
    assert row["status"] == "partial"
    assert row["paid_methods"][0]["amount"] == 500.0

    # 发放上限也必须是 4000（不是 4500）——这是"多付"风险的回归测试
    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "labor"}))
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project, "cost_type": "labor"}))["items"]
    settle_id = settles[0]["id"]

    from helpers import err_data

    err_data(
        api.post(
            f"/api/labor/settles/{settle_id}/pay",
            json={"amount": "4500", "pay_date": "2026-10-17", "pay_method": "cash"},
        ),
        400,
    )
    # 4000 正好可以发完
    ok_data(
        api.post(
            f"/api/labor/settles/{settle_id}/pay",
            json={"amount": "4000", "pay_date": "2026-10-17", "pay_method": "cash"},
        )
    )
    ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    row = next(item for item in ov["items"] if item["partner"] == "沈八")
    money_eq(row["paid_amount"], "4500.00")
    money_eq(row["unsettled"], "0.00")
    assert row["status"] == "closed"


def test_欠款总览_默认不隐藏已结清但状态可辨(api):
    """总览返回所有对象（含已结清），由界面决定默认过滤——后端不擅自丢数据。"""
    project = _project(api, "总览-含已结清")
    _labor_cost_only(api, project, worker="张三", days="2", rate="300", biz_date="2026-05-01")  # 600
    _labor_cost_only(api, project, worker="李四", days="1", rate="300", biz_date="2026-05-02")  # 300

    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "labor"}))
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project, "cost_type": "labor"}))["items"]
    zhang = next(s for s in settles if s["partner"] == "张三")
    ok_data(
        api.post(
            f"/api/labor/settles/{zhang['id']}/pay",
            json={"amount": "600", "pay_date": "2026-05-10", "pay_method": "cash"},
        )
    )

    ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    by_partner = {item["partner"]: item for item in ov["items"]}
    assert by_partner["张三"]["status"] == "closed"
    assert by_partner["李四"]["status"] == "open"
    money_eq(ov["total_unsettled"], "300.00")  # 只累加未结的


def test_欠款总览_时间段只用来决定显示哪些对象(api):
    """选了时间段：只显示该区间内有成本的对象，但金额仍是**累计**的。"""
    project = _project(api, "总览-时间段")
    _labor_cost_only(api, project, worker="早期工人", days="2", rate="300", biz_date="2026-03-01")  # 600
    _labor_cost_only(api, project, worker="近期工人", days="3", rate="300", biz_date="2026-06-01")  # 900

    # 只选 6 月：只显示近期工人，但它的金额是按全部成本累计（这里恰好只有一笔）
    ov = ok_data(
        api.get(
            "/api/labor/overview",
            params={"project_id": project, "cost_type": "labor", "start_date": "2026-06-01"},
        )
    )
    assert [item["partner"] for item in ov["items"]] == ["近期工人"]
    money_eq(ov["items"][0]["amount_due"], "900.00")
    # 本期该结只有在区间内的那 900
    money_eq(ov["items"][0]["period_amount"], "900.00")

    # 不选时间段：两个都显示
    all_ov = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    assert {item["partner"] for item in all_ov["items"]} == {"早期工人", "近期工人"}
    money_eq(all_ov["total_due"], "1500.00")


def test_不传类别默认人工_保持旧行为(api):
    """旧调用（不带 cost_type）仍然按人工走，兼容性不能破。"""
    project = _project(api, "五类结算-兼容")
    ok_data(
        api.post(
            "/api/costs/labor",
            json={"project_id": project, "worker_name": "李四", "work_days": "3", "day_rate": "300", "biz_date": "2026-05-01"},
        )
    )
    preview = ok_data(api.get("/api/labor/preview", params={"project_id": project}))
    assert preview["cost_type"] == "labor"
    assert preview["items"][0]["partner"] == "李四"
    money_eq(preview["total_amount"], "900.00")

    saved = ok_data(api.post("/api/labor/settle", json={"project_id": project}))
    assert saved["cost_type"] == "labor"
    rows = ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
    assert rows[0]["cost_type"] == "labor"
    assert rows[0]["worker_name"] == "李四"
    assert rows[0]["partner"] == "李四"
