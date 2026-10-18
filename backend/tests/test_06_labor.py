"""人工结算：预览 / 结算 / 发放，全程不重复入成本（FR-7）。

2026-10-16 口径修正：**「已发/还欠」不再由结算单自己记**，而是从该对象名下
应付单上的**冲销记录**算出来（见 `/api/labor/overview`）。
所以本文件的断言改成看 `overview`——那才是与「往来」页一致的数。
"""

from __future__ import annotations

from helpers import add_labor, err_data, money_eq, ok_data


def _overview(api, project: int, partner: str, cost_type: str = "labor") -> dict:
    """取某个对象的欠款汇总（一对象一行）。"""
    data = ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": cost_type}))
    for item in data["items"]:
        if item["partner"] == partner:
            return item
    return {
        "partner": partner,
        "amount_due": 0,
        "paid_amount": 0,
        "unsettled": 0,
        "paid_methods": [],
        "status": "closed",
    }


def test_结算预览按人汇总(api, project):
    add_labor(api, project, "张三", "3", "300", "2026-05-10")  # 900
    add_labor(api, project, "张三", "2", "350", "2026-05-11")  # 700
    add_labor(api, project, "李四", "1", "500", "2026-05-12")  # 500

    preview = ok_data(api.get("/api/labor/preview", params={"project_id": project}))
    assert [item["partner"] for item in preview["items"]] == ["张三", "李四"]
    zhang = preview["items"][0]
    assert str(zhang["total_days"]) in ("5.00", "5.0", "5")
    money_eq(zhang["amount_due"], "1600.00")  # 900 + 700
    money_eq(preview["total_amount"], "2100.00")
    assert preview["note"] == "结算不重复计入成本"

    # 预览不写库
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project}))
    assert settles["total"] == 0

    # 时间段预览
    ranged = ok_data(
        api.get("/api/labor/preview", params={"project_id": project, "start_date": "2026-05-11"})
    )
    money_eq(ranged["total_amount"], "1200.00")

    # 历史姓名建议
    names = ok_data(api.get("/api/labor/workers", params={"project_id": project}))["items"]
    assert names == ["张三", "李四"]


def test_生成结算单不新增成本(api, project):
    before = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    money_eq(before, "2100.00")

    data = ok_data(api.post("/api/labor/settle", json={"project_id": project, "settle_date": "2026-07-01"}))
    assert data["created"] == 2
    assert data["updated"] == 0
    money_eq(data["total_amount"], "2100.00")

    after = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    money_eq(after, "2100.00")  # 结算不重复入成本

    # 结算金额 = 已入成本金额
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
    assert sum(float(item["amount_due"]) for item in settles) == 2100.0
    assert all(item["status"] == "unpaid" for item in settles)


def test_登记发放与状态流转(api, project):
    settles = ok_data(api.get("/api/labor/settles", params={"project_id": project}))["items"]
    zhang = next(item for item in settles if item["worker_name"] == "张三")
    li = next(item for item in settles if item["worker_name"] == "李四")

    # 部分发放：600 / 1600
    ok_data(
        api.post(
            f"/api/labor/settles/{zhang['id']}/pay",
            json={"amount": 600.00, "pay_date": "2026-07-05", "pay_method": "wechat"},
        )
    )
    overview = _overview(api, project, "张三")
    money_eq(overview["amount_due"], "1600.00")
    money_eq(overview["paid_amount"], "600.00")
    money_eq(overview["unsettled"], "1000.00")
    assert overview["status"] == "partial"
    # 付款方式构成里应能看到微信那 600
    assert overview["paid_methods"] == [
        {"pay_method": "wechat", "pay_method_label": "微信", "amount": 600.0}
    ] or overview["paid_methods"][0]["pay_method"] == "wechat"

    # 超过**真实未结额**发放 → 400（上限不再看结算单自己的已发）
    err_data(
        api.post(
            f"/api/labor/settles/{zhang['id']}/pay",
            json={"amount": 1000.01, "pay_date": "2026-07-06", "pay_method": "cash"},
        ),
        400,
    )
    # 补齐 1000
    ok_data(
        api.post(
            f"/api/labor/settles/{zhang['id']}/pay",
            json={"amount": 1000.00, "pay_date": "2026-07-06", "pay_method": "cash"},
        )
    )
    overview = _overview(api, project, "张三")
    money_eq(overview["paid_amount"], "1600.00")
    money_eq(overview["unsettled"], "0.00")
    assert overview["status"] == "closed"

    # 已结清后再发一分钱 → 400（没有未结欠款）
    err_data(
        api.post(
            f"/api/labor/settles/{zhang['id']}/pay",
            json={"amount": 0.01, "pay_date": "2026-07-07", "pay_method": "cash"},
        ),
        400,
    )

    # 结算单只是"本期该结多少"的快照，发过钱也能删（钱在流水与冲销里，不在这张快照上）
    ok_data(api.delete(f"/api/labor/settles/{zhang['id']}"))
    # 删掉快照不影响已经付出去的钱
    overview = _overview(api, project, "张三")
    money_eq(overview["paid_amount"], "1600.00")
    money_eq(overview["unsettled"], "0.00")

    # 未发放的也能删
    ok_data(api.delete(f"/api/labor/settles/{li['id']}"))
    err_data(api.delete(f"/api/labor/settles/{li['id']}"), 404)

    # 发放不影响成本
    overview_metrics = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(overview_metrics["metrics"]["actual_cost"], "2100.00")


def test_重复结算覆盖快照(api, project):
    """重复生成结算单：同一对象只有一张快照，金额按最新预览覆盖。"""
    data = ok_data(api.post("/api/labor/settle", json={"project_id": project}))
    assert data["created"] == 2  # 张三、李四的快照都被删了，重新生成
    assert data["updated"] == 0

    zhang = next(item for item in data["items"] if item["worker_name"] == "张三")
    money_eq(zhang["amount_due"], "1600.00")
    # 快照不带已发金额，「已付」要看 overview
    overview = _overview(api, project, "张三")
    money_eq(overview["paid_amount"], "1600.00")

    # 再次生成应变成 updated
    again = ok_data(api.post("/api/labor/settle", json={"project_id": project}))
    assert again["created"] == 0
    assert again["updated"] == 2


def test_新增工天后金额上升_欠款随之变化(api, project):
    add_labor(api, project, "张三", "1", "400", "2026-05-13")  # +400
    before = ok_data(api.get(f"/api/projects/{project}/overview"))["metrics"]["actual_cost"]
    money_eq(before, "2500.00")

    data = ok_data(api.post("/api/labor/settle", json={"project_id": project}))
    zhang = next(item for item in data["items"] if item["worker_name"] == "张三")
    money_eq(zhang["amount_due"], "2000.00")  # 1600 + 400

    # 已付 1600 < 累计应付 2000 → 还欠 400
    overview = _overview(api, project, "张三")
    money_eq(overview["amount_due"], "2000.00")
    money_eq(overview["paid_amount"], "1600.00")
    money_eq(overview["unsettled"], "400.00")
    assert overview["status"] == "partial"


def test_结算校验(api):
    err_data(api.get("/api/labor/preview", params={"project_id": 999999}), 404)
    err_data(api.post("/api/labor/settle", json={"project_id": 999999}), 404)
    err_data(api.get("/api/labor/settles/999999"), 404)
