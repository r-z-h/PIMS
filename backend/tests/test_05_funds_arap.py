"""资金流水 + 应收应付 + 冲销（FR-3、FR-4）。"""

from __future__ import annotations

from helpers import add_funds, add_receivable, err_data, money_eq, ok_data


def test_资金流水CRUD与类型校验(api, project):
    response = api.post(
        "/api/funds",
        json={
            "project_id": project,
            "direction": "in",
            "biz_type": "progress",
            "amount": 300000.00,
            "biz_date": "2026-06-20",
            "partner": "某某置业有限公司",
            "pay_method": "transfer",
            "remark": "第二次进度款",
        },
    )
    data = ok_data(response)
    assert data["direction_label"] == "收"
    assert data["biz_type_label"] == "进度款"
    assert data["pay_method_label"] == "转账"
    assert '"amount":300000.00' in response.text
    flow_id = data["id"]

    # 收入类型不接受支出类型
    err_data(
        api.post(
            "/api/funds",
            json={
                "project_id": project,
                "direction": "in",
                "biz_type": "material",
                "amount": 100,
                "biz_date": "2026-06-20",
            },
        ),
        400,
    )
    # 支出类型不接受收入类型
    err_data(
        api.post(
            "/api/funds",
            json={
                "project_id": project,
                "direction": "out",
                "biz_type": "progress",
                "amount": 100,
                "biz_date": "2026-06-20",
            },
        ),
        400,
    )
    err_data(
        api.post(
            "/api/funds",
            json={
                "project_id": project,
                "direction": "out",
                "biz_type": "other",
                "amount": 0,
                "biz_date": "2026-06-20",
            },
        ),
        400,
    )

    ok_data(api.put(f"/api/funds/{flow_id}", json={"amount": 350000, "pay_method": "cash"}))
    detail = ok_data(api.get(f"/api/funds/{flow_id}"))
    money_eq(detail["amount"], "350000.00")
    assert detail["pay_method"] == "cash"
    assert detail["offsets"] == []
    money_eq(detail["unoffset_amount"], "350000.00")

    # 资金流水不影响利润
    overview = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "0.00")
    money_eq(overview["metrics"]["settle_profit"], "4000000.00")
    money_eq(overview["funds"]["total_in"], "350000.00")


def test_资金流水汇总(api, project):
    add_funds(api, project, direction="out", amount="120000", biz_type="material", biz_date="2026-06-21")
    data = ok_data(api.get("/api/funds/summary", params={"project_id": project}))
    money_eq(data["total_in"], "350000.00")
    money_eq(data["total_out"], "120000.00")
    money_eq(data["net"], "230000.00")
    assert data["count_in"] == 1 and data["count_out"] == 1
    assert any(item["biz_type"] == "material" for item in data["by_type"])


def test_资金流水汇总可按收付方向过滤(api, project):
    """界面顶部切换"只看收款 / 只看付款"时，合计必须与列表口径一致（T2）。

    注意：本文件内 `api` fixture 共享同一份数据，执行到这里时
    已有 test_资金流水汇总 留下的一笔 120000.00 付款，因此基线是 out=120000。
    """
    only_out = ok_data(api.get("/api/funds/summary", params={"project_id": project, "direction": "out"}))
    money_eq(only_out["total_out"], "120000.00")
    money_eq(only_out["total_in"], "0.00")  # 只看付款时，收款合计必须归零，否则数字对不上
    money_eq(only_out["net"], "-120000.00")
    assert only_out["count_in"] == 0 and only_out["count_out"] == 1
    assert all(item["direction"] == "out" for item in only_out["by_type"])

    only_in = ok_data(api.get("/api/funds/summary", params={"project_id": project, "direction": "in"}))
    money_eq(only_in["total_in"], "350000.00")
    money_eq(only_in["total_out"], "0.00")
    assert only_in["count_in"] == 1 and only_in["count_out"] == 0
    assert all(item["direction"] == "in" for item in only_in["by_type"])

    # 不传 direction 时行为不变（两者都统计）
    both = ok_data(api.get("/api/funds/summary", params={"project_id": project}))
    money_eq(both["total_in"], "350000.00")
    money_eq(both["total_out"], "120000.00")

    # 再付一笔后，只看付款的合计要跟着涨，而收款仍为 0
    add_funds(api, project, direction="out", amount="8000", biz_type="misc", biz_date="2026-06-22")
    after = ok_data(api.get("/api/funds/summary", params={"project_id": project, "direction": "out"}))
    money_eq(after["total_out"], "128000.00")
    money_eq(after["total_in"], "0.00")
    assert after["count_out"] == 2


def test_应收应付单据与状态(api, project):
    arap_id = add_receivable(api, project, amount="500000")
    detail = ok_data(api.get(f"/api/arap/{arap_id}"))
    assert detail["status"] == "open"
    assert detail["status_label"] == "未收付"
    money_eq(detail["unsettled"], "500000.00")

    # 应收只允许 进度款 / 结算款
    err_data(
        api.post(
            "/api/arap",
            json={
                "project_id": project,
                "type": "receivable",
                "biz_type": "material",
                "amount": 100,
                "biz_date": "2026-06-01",
            },
        ),
        400,
    )
    # 应付允许材料款
    payable = ok_data(
        api.post(
            "/api/arap",
            json={
                "project_id": project,
                "type": "payable",
                "biz_type": "material",
                "amount": 700000,
                "biz_date": "2026-06-02",
                "partner": "某某建材",
            },
        )
    )
    assert payable["type_label"] == "应付"

    summary = ok_data(api.get("/api/arap/summary", params={"project_id": project}))
    money_eq(summary["receivable_unsettled"], "500000.00")
    money_eq(summary["payable_unsettled"], "700000.00")
    assert summary["open_count"] == 2

    # 列表筛选
    receivables = ok_data(api.get("/api/arap", params={"project_id": project, "type": "receivable"}))["items"]
    assert len(receivables) == 1
    unsettled_only = ok_data(api.get("/api/arap", params={"project_id": project, "only_unsettled": True}))["items"]
    assert len(unsettled_only) == 2


def test_手工冲销多张单据与校验(api, project):
    # 两张应收单 + 一笔 30 万收款
    first = add_receivable(api, project, amount="200000", biz_date="2026-06-03")
    second = add_receivable(api, project, amount="100000", biz_date="2026-06-04")
    flow_id = add_funds(api, project, direction="in", amount="300000", biz_date="2026-06-30")

    # 单据与流水不属于同一项目 → 400
    other = ok_data(api.post("/api/projects", json={"name": "别的项目", "client_budget": "1", "cost_budget": "1"}))["id"]
    other_arap = add_receivable(api, other, amount="1000")
    err_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": other_arap, "amount": 1000}],
                "offset_date": "2026-06-30",
            },
        ),
        400,
    )
    # 应收单不能用付款流水冲
    out_flow = add_funds(api, project, direction="out", amount="5000", biz_type="material", biz_date="2026-06-30")
    err_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": out_flow,
                "offsets": [{"ar_ap_id": first, "amount": 1000}],
                "offset_date": "2026-06-30",
            },
        ),
        400,
    )
    # 合计超过流水金额 → 400
    err_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [
                    {"ar_ap_id": first, "amount": 200000},
                    {"ar_ap_id": second, "amount": 150000},
                ],
                "offset_date": "2026-06-30",
            },
        ),
        400,
    )

    result = ok_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [
                    {"ar_ap_id": first, "amount": 200000},
                    {"ar_ap_id": second, "amount": 100000},
                ],
                "offset_date": "2026-06-30",
            },
        )
    )
    assert len(result["offset_ids"]) == 2
    money_eq(result["flow_offset_remaining"], "0.00")

    first_detail = ok_data(api.get(f"/api/arap/{first}"))
    assert first_detail["status"] == "closed"
    money_eq(first_detail["unsettled"], "0.00")
    second_detail = ok_data(api.get(f"/api/arap/{second}"))
    assert second_detail["status"] == "closed"

    # 已结清的单据不再出现在待冲销列表
    pending = ok_data(api.get("/api/arap/pending", params={"project_id": project, "type": "receivable"}))
    assert all(item["id"] not in (first, second) for item in pending["items"])

    # 流水额度已用完 → 再冲 1 分钱也不行
    tiny = add_receivable(api, project, amount="10000", biz_date="2026-07-05")
    err_data(
        api.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": tiny, "amount": 1}],
                "offset_date": "2026-06-30",
            },
        ),
        400,
    )

    # 撤销其中一条 → 状态回到 open
    undo = ok_data(api.delete(f"/api/arap/offset/{result['offset_ids'][0]}"))
    assert undo["status"] == "open"
    money_eq(undo["unsettled"], "200000.00")
    money_eq(undo["flow_offset_remaining"], "200000.00")


def test_单据修改与删除保护(api, project):
    arap_id = add_receivable(api, project, amount="50000", biz_date="2026-07-01")
    flow_id = add_funds(api, project, direction="in", amount="20000", biz_date="2026-07-02")
    ok_data(
        api.post(
            "/api/arap/offset",
            json={"funds_flow_id": flow_id, "offsets": [{"ar_ap_id": arap_id, "amount": 20000}], "offset_date": "2026-07-02"},
        )
    )
    detail = ok_data(api.get(f"/api/arap/{arap_id}"))
    assert detail["status"] == "partial"
    money_eq(detail["unsettled"], "30000.00")

    # 金额不能小于已冲销额
    err_data(api.put(f"/api/arap/{arap_id}", json={"amount": 10000}), 400)
    ok_data(api.put(f"/api/arap/{arap_id}", json={"amount": 60000, "partner": "新对方"}))
    assert ok_data(api.get(f"/api/arap/{arap_id}"))["partner"] == "新对方"

    # 有冲销记录不能删
    err_data(api.delete(f"/api/arap/{arap_id}"), 409)
    # 有冲销记录的资金流水也不能删，且金额不能小于已冲销额
    err_data(api.delete(f"/api/funds/{flow_id}"), 409)
    err_data(api.put(f"/api/funds/{flow_id}", json={"amount": 1000}), 400)


def test_删除无冲销的流水与单据(api, project):
    flow_id = add_funds(api, project, direction="out", amount="999", biz_type="misc", biz_date="2026-07-10")
    ok_data(api.delete(f"/api/funds/{flow_id}"))
    err_data(api.get(f"/api/funds/{flow_id}"), 404)

    arap_id = add_receivable(api, project, amount="888", biz_date="2026-07-11")
    ok_data(api.delete(f"/api/arap/{arap_id}"))
    err_data(api.get(f"/api/arap/{arap_id}"), 404)


def test_资金流水不影响利润总表(api, project):
    row = ok_data(api.get("/api/dashboard/projects"))["items"]
    me = next(item for item in row if item["project_id"] == project)
    money_eq(me["actual_cost"], "0.00")
    money_eq(me["settle_profit"], "4000000.00")
    assert float(me["received"]) > 0
