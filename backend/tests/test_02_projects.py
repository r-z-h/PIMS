"""项目档案：CRUD / 盈亏 / 删除保护（FR-2）。"""

from __future__ import annotations

from helpers import err_data, money_eq, ok_data


def test_新建项目并返回两个利润(api):
    response = api.post(
        "/api/projects",
        json={
            "name": "某小区5#楼",
            "client_name": "某某置业有限公司",
            "location": "武汉市洪山区",
            "manager": "王工",
            "start_date": "2026-03-01",
            "status": "ongoing",
            "client_budget": "4000000",
            "cost_budget": "3500000",
            "members": "王工、张三,李四",
            "remark": "备注",
        },
    )
    data = ok_data(response)
    assert data["members"] == ["王工", "张三", "李四"]
    assert data["start_date"] == "2026-03-01"
    money_eq(data["expect_profit"], "500000.00")
    money_eq(data["settle_profit"], "4000000.00")
    money_eq(data["actual_cost"], "0.00")
    money_eq(data["budget_left"], "3500000.00")
    assert data["budget_usage_rate"] == 0
    assert '"client_budget":4000000.00' in response.text


def test_同名项目提示但允许(api):
    data = ok_data(
        api.post("/api/projects", json={"name": "某小区5#楼", "client_budget": "100", "cost_budget": "50"})
    )
    assert data["duplicate_name"] is True


def test_预算与名称校验(api):
    err_data(api.post("/api/projects", json={"name": "", "client_budget": "1", "cost_budget": "1"}), 400)
    err_data(api.post("/api/projects", json={"name": "缺预算"}), 400)
    err_data(
        api.post("/api/projects", json={"name": "负数预算", "client_budget": "-1", "cost_budget": "1"}), 400
    )


def test_项目列表_筛选_分页(api):
    data = ok_data(api.get("/api/projects", params={"keyword": "某小区", "page": 1, "page_size": 1}))
    assert data["total"] == 2
    assert len(data["items"]) == 1
    assert data["page_size"] == 1
    assert "expect_profit" in data["items"][0]

    finished = ok_data(api.get("/api/projects", params={"status": "finished"}))
    assert all(item["status"] == "finished" for item in finished["items"])

    err_data(api.get("/api/projects", params={"page_size": 999}), 400)  # 超过 200 上限


def test_项目详情与修改(api):
    project_id = ok_data(api.post("/api/projects", json={"name": "待改项目", "client_budget": "1000", "cost_budget": "800"}))["id"]

    ok_data(api.put(f"/api/projects/{project_id}", json={"status": "finished", "manager": "李工"}))
    detail = ok_data(api.get(f"/api/projects/{project_id}"))
    assert detail["status"] == "finished"
    assert detail["manager"] == "李工"
    assert detail["client_budget"] == 1000
    money_eq(detail["expect_profit"], "200.00")

    # 完工即锁定（2026-10-17）：再改要先用密码解锁
    assert detail["is_locked"] is True
    err_data(api.put(f"/api/projects/{project_id}", json={"client_budget": "2000"}), 409)

    ok_data(api.post(f"/api/projects/{project_id}/unlock", json={"password": "123456"}))
    detail = ok_data(api.get(f"/api/projects/{project_id}"))
    assert detail["is_locked"] is False

    # 只传一个字段不影响其他字段
    ok_data(api.put(f"/api/projects/{project_id}", json={"client_budget": "2000"}))
    detail = ok_data(api.get(f"/api/projects/{project_id}"))
    assert detail["manager"] == "李工"
    money_eq(detail["expect_profit"], "1200.00")

    err_data(api.get("/api/projects/999999"), 404)
    err_data(api.put("/api/projects/999999", json={"manager": "x"}), 404)


def test_项目概览包含五类构成与往来(api):
    project_id = ok_data(
        api.post("/api/projects", json={"name": "概览项目", "client_budget": "1000000", "cost_budget": "800000"})
    )["id"]
    ok_data(
        api.post(
            "/api/costs/labor",
            json={"project_id": project_id, "worker_name": "张三", "biz_date": "2026-05-12", "work_days": 5, "day_rate": 300},
        )
    )
    ok_data(
        api.post(
            "/api/costs/misc",
            json={"project_id": project_id, "category": "伙食费", "amount": 5000, "biz_date": "2026-05-13"},
        )
    )
    ok_data(
        api.post(
            "/api/funds",
            json={
                "project_id": project_id,
                "direction": "in",
                "biz_type": "progress",
                "amount": 200000,
                "biz_date": "2026-06-01",
            },
        )
    )
    ok_data(
        api.post(
            "/api/arap",
            json={
                "project_id": project_id,
                "type": "payable",
                "biz_type": "material",
                "amount": 70000,
                "biz_date": "2026-06-02",
            },
        )
    )

    overview = ok_data(api.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "6500.00")
    money_eq(overview["metrics"]["expect_profit"], "200000.00")
    money_eq(overview["metrics"]["settle_profit"], "993500.00")
    money_eq(overview["metrics"]["budget_left"], "793500.00")
    assert set(overview["cost_by_type"].keys()) == {"labor", "material", "machine", "misc", "advance"}
    money_eq(overview["cost_by_type"]["misc"], "5000.00")
    money_eq(overview["funds"]["total_in"], "200000.00")
    money_eq(overview["funds"]["total_out"], "0.00")
    # 应付未结：手工新增的 70000 + 两笔成本自动生成的应付单（人工 5×300=1500、杂费 5000）
    money_eq(overview["ar_ap"]["payable_unsettled"], "76500.00")
    money_eq(overview["ar_ap"]["receivable_unsettled"], "0.00")
    assert overview["cost_by_category"][0]["category"] == "伙食费"
    assert overview["inventory"]["items"] == []


def test_删除项目_有数据需force(api):
    project_id = ok_data(api.post("/api/projects", json={"name": "有数据的项目", "client_budget": "100", "cost_budget": "80"}))["id"]
    ok_data(
        api.post(
            "/api/costs/misc",
            json={"project_id": project_id, "category": "罚款", "amount": 100, "biz_date": "2026-05-01"},
        )
    )

    payload = err_data(api.delete(f"/api/projects/{project_id}"), 409)
    assert "force=true" in payload["message"]

    result = ok_data(api.delete(f"/api/projects/{project_id}", params={"force": True}))
    assert result["deleted"] is True
    assert result["forced"] is True
    err_data(api.get(f"/api/projects/{project_id}"), 404)

    # 项目隐藏后，其成本也从列表里隐藏
    costs = ok_data(api.get("/api/costs", params={"page_size": 200}))["items"]
    assert all(item["project_id"] != project_id for item in costs)
    with_deleted = ok_data(api.get("/api/costs", params={"include_deleted": True, "page_size": 200}))["items"]
    assert any(item["project_id"] == project_id for item in with_deleted)


def test_删除空项目不需要force(api):
    project_id = ok_data(api.post("/api/projects", json={"name": "空项目", "client_budget": "0", "cost_budget": "0"}))["id"]
    result = ok_data(api.delete(f"/api/projects/{project_id}"))
    assert result["deleted"] is True and result["forced"] is False

def test_项目详情同时返回嵌套与扁平结构(api):
    """**契约测试**（2026-10-17 发现真实故障后补）。

    背景：``GET /api/projects/{id}`` 曾经只返回**扁平**结构，
    而前端「项目详情」页按**嵌套**（``overview.project``）取数 —— 结果整页显示 ``-`` / ``0.00``。
    当时没被发现，是因为 Playwright 跑在 mock 上，而 mock 返回的是嵌套结构（两边不一致）。

    这里锁住：两种结构都必须有，谁也不能再漂。
    """
    project_id = ok_data(
        api.post("/api/projects", json={"name": "契约项目", "client_budget": "100000", "cost_budget": "80000"})
    )["id"]

    detail = ok_data(api.get(f"/api/projects/{project_id}"))

    # ① 嵌套（前端页面用）
    assert "project" in detail and isinstance(detail["project"], dict), list(detail.keys())
    assert detail["project"]["id"] == project_id
    assert detail["project"]["name"] == "契约项目"
    assert "metrics" in detail and isinstance(detail["metrics"], dict)
    assert "actual_cost" in detail["metrics"]
    for key in ("cost_by_type", "funds", "ar_ap"):
        assert key in detail, f"缺少 {key}，项目详情页会取不到数"

    # ② 扁平（早期调用方用）
    assert detail["id"] == project_id
    assert detail["status"] == "ongoing"
    assert "is_locked" in detail
    money_eq(detail["expect_profit"], "20000.00")
