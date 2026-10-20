"""快速查询（2026-10-19 需求）：按勾选执行查询，选一个就只回一个 block。

核心断言：
- 只选一种 → `blocks` 只有一块，且内容与对应页面的数一致（口径同源）
- 全选 → 三块按注册表顺序返回
- 空选 → 400（不能返回空结果让人以为「一切正常」）
- 空数据 → 返回该块 + empty_text，不报错
- 不做时间筛选时累计口径不受影响
"""

from __future__ import annotations

from helpers import add_labor, add_material, add_misc, err_data, money_eq, ok_data, make_project


def _run(api, types, project, **extra):
    body = {"types": types, "project_id": project, **extra}
    return ok_data(api.post("/api/query/run", json=body))


def _block(data, code):
    for block in data["blocks"]:
        if block["type"] == code:
            return block
    raise AssertionError(f"结果里没有 {code} 块：{[b['type'] for b in data['blocks']]}")


def test_查询清单默认全选(api):
    data = ok_data(api.get("/api/query/types"))
    codes = [item["code"] for item in data["items"]]
    assert codes == ["labor_unsettled", "arap_unsettled", "cost_budget"]
    assert data["default"] == codes  # 默认全选
    assert all(item["default_selected"] for item in data["items"])
    assert all(item["needs_project"] for item in data["items"])


def test_只选一个只返回一个块(api):
    """用户「仅查工人未结款」的场景：结果里不能混进别的表。"""
    pid = make_project(api, "快速查询-单选")
    add_labor(api, pid, "张工", "3", "300", "2026-05-10")  # 900
    add_labor(api, pid, "张工", "2", "350", "2026-05-11")  # 700

    data = _run(api, ["labor_unsettled"], pid)
    assert [b["type"] for b in data["blocks"]] == ["labor_unsettled"]
    assert data["selected"] == ["labor_unsettled"]

    block = _block(data, "labor_unsettled")
    assert block["title"] == "工人未结款"
    assert [row["partner"] for row in block["rows"]] == ["张工"]
    money_eq(block["rows"][0]["amount_due"], "1600.00")
    money_eq(block["rows"][0]["unsettled"], "1600.00")
    money_eq(block["summary"]["total_unsettled"], "1600.00")
    assert block["summary"]["worker_count"] == 1
    assert block["columns"][0]["key"] == "partner"


def test_与结算页数字一致(api):
    """快速查询的工人未结款必须与 /api/labor/overview 完全一致（同一口径）。"""
    pid = make_project(api, "快速查询-口径一致")
    add_labor(api, pid, "李工", "4", "250", "2026-06-01")  # 1000

    overview = ok_data(api.get("/api/labor/overview", params={"project_id": pid, "cost_type": "labor"}))
    block = _block(_run(api, ["labor_unsettled"], pid), "labor_unsettled")
    money_eq(block["summary"]["total_due"], overview["total_due"])
    money_eq(block["summary"]["total_paid"], overview["total_paid"])
    money_eq(block["summary"]["total_unsettled"], overview["total_unsettled"])


def test_全选返回三块且顺序稳定(api):
    pid = make_project(api, "快速查询-全选")
    add_labor(api, pid, "王工", "2", "300", "2026-07-01")
    add_material(api, pid, supplier="某某建材")
    add_misc(api, pid, "伙食费", "800", "2026-07-02")

    data = _run(api, ["labor_unsettled", "arap_unsettled", "cost_budget"], pid)
    assert [b["type"] for b in data["blocks"]] == ["labor_unsettled", "arap_unsettled", "cost_budget"]
    for block in data["blocks"]:
        assert block["columns"], f"{block['type']} 缺少列定义"
        assert "summary" in block
        assert "error" not in block

    cost_block = _block(data, "cost_budget")
    labels = [row["type_label"] for row in cost_block["rows"]]
    assert labels[-1] == "合计"
    assert "人工" in labels and "材料" in labels and "杂费" in labels


def test_成本与预算与项目概览一致(api):
    pid = make_project(api, "快速查询-预算口径", cost_budget="1000")
    add_labor(api, pid, "赵工", "1", "400", "2026-08-01")
    add_misc(api, pid, "罚款", "300", "2026-08-02")

    overview = ok_data(api.get(f"/api/projects/{pid}/overview"))
    block = _block(_run(api, ["cost_budget"], pid), "cost_budget")

    money_eq(block["summary"]["actual_cost"], overview["metrics"]["actual_cost"])
    money_eq(block["summary"]["actual_cost"], "700.00")
    money_eq(block["summary"]["cost_budget"], "1000.00")
    money_eq(block["summary"]["budget_left"], "300.00")
    assert block["summary"]["over_budget"] is False


def test_超预算标记(api):
    pid = make_project(api, "快速查询-超预算", cost_budget="100")
    add_misc(api, pid, "其他", "150", "2026-09-01")

    block = _block(_run(api, ["cost_budget"], pid), "cost_budget")
    money_eq(block["summary"]["actual_cost"], "150.00")
    assert block["summary"]["over_budget"] is True
    money_eq(block["summary"]["budget_left"], "-50.00")


def test_空选返回400(api):
    pid = make_project(api, "快速查询-空选")
    err_data(api.post("/api/query/run", json={"types": [], "project_id": pid}), 400)


def test_未知类型返回400(api):
    pid = make_project(api, "快速查询-未知类型")
    err_data(api.post("/api/query/run", json={"types": ["not_exists"], "project_id": pid}), 400)


def test_需要项目但没传项目返回400(api):
    err_data(api.post("/api/query/run", json={"types": ["labor_unsettled"]}), 400)


def test_无数据返回空块而不是报错(api):
    pid = make_project(api, "快速查询-空数据")
    block = _block(_run(api, ["labor_unsettled"], pid), "labor_unsettled")
    assert block["rows"] == []
    assert block["empty_text"]
    money_eq(block["summary"]["total_unsettled"], "0.00")
    assert "error" not in block


def test_重复勾选不重复返回(api):
    pid = make_project(api, "快速查询-去重")
    data = _run(api, ["cost_budget", "cost_budget"], pid)
    assert [b["type"] for b in data["blocks"]] == ["cost_budget"]
