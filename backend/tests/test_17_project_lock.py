"""项目完工锁（2026-10-17 需求）。

口径（用户确认）：
- 完工后**所有写操作**都要先解锁：成本/流水/往来/冲销/结算发放/库存/项目档案/删项目
- 解锁 = 输**登录密码**；解锁后一直有效，**直到手动「重新锁定」**（重启也保持）
- 「撤销完工」要密码；「重新锁定」不要密码（加锁是安全方向）
- **只读操作不受影响**（完工项目照样能看、能预览、能导表）
"""

from __future__ import annotations

from helpers import err_data, money_eq, ok_data

PWD = "123456"


def _project(api, name: str) -> int:
    return ok_data(
        api.post("/api/projects", json={"name": name, "client_budget": "100000", "cost_budget": "80000"})
    )["id"]


def _labor_cost(api, project: int, worker: str = "张三", days: str = "2", rate: str = "300") -> int:
    return ok_data(
        api.post(
            "/api/costs/labor",
            json={
                "project_id": project,
                "worker_name": worker,
                "work_days": days,
                "day_rate": rate,
                "biz_date": "2026-05-10",
            },
        )
    )["cost_id"]


def test_完工后所有写操作被拦_只读不受影响(api):
    project = _project(api, "完工锁-全量")
    cost_id = _labor_cost(api, project, "张三")  # 600

    # 在建时一切正常
    ok_data(api.get("/api/labor/preview", params={"project_id": project}))

    ok_data(api.post(f"/api/projects/{project}/finish"))
    detail = ok_data(api.get(f"/api/projects/{project}"))
    assert detail["status"] == "finished"
    assert detail["is_finished"] is True
    assert detail["is_locked"] is True, "完工后默认应处于锁定"
    assert detail["unlocked_at"] is None

    # ---- 只读：全部照常 ----
    ok_data(api.get(f"/api/projects/{project}"))
    ok_data(api.get(f"/api/projects/{project}/overview"))
    ok_data(api.get("/api/costs", params={"project_id": project}))
    ok_data(api.get("/api/funds", params={"project_id": project}))
    ok_data(api.get("/api/arap", params={"project_id": project}))
    ok_data(api.get("/api/labor/preview", params={"project_id": project}))
    ok_data(api.get("/api/labor/overview", params={"project_id": project, "cost_type": "labor"}))
    ok_data(api.get("/api/inventory", params={"project_id": project}))

    # ---- 写操作：逐条都必须 409 ----
    err_data(
        api.post(
            "/api/costs/labor",
            json={"project_id": project, "worker_name": "李四", "work_days": "1", "day_rate": "300", "biz_date": "2026-05-11"},
        ),
        409,
    )
    err_data(api.put(f"/api/costs/{cost_id}", json={"remark": "改备注"}), 409)
    err_data(api.delete(f"/api/costs/{cost_id}"), 409)
    err_data(
        api.post(
            "/api/funds",
            json={"project_id": project, "direction": "out", "biz_type": "labor", "amount": "100", "biz_date": "2026-05-12"},
        ),
        409,
    )
    err_data(
        api.post(
            "/api/arap",
            json={"project_id": project, "type": "payable", "biz_type": "misc", "amount": "100", "biz_date": "2026-05-12"},
        ),
        409,
    )
    err_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "labor"}), 409)
    err_data(
        api.post(
            "/api/labor/pay",
            json={"project_id": project, "cost_type": "labor", "partner": "张三", "amount": "100", "pay_date": "2026-05-13"},
        ),
        409,
    )
    err_data(
        api.post(
            "/api/inventory/out",
            json={"project_id": project, "material_name": "水泥", "unit": "吨", "quantity": "1", "biz_date": "2026-05-13"},
        ),
        409,
    )
    err_data(api.put(f"/api/projects/{project}", json={"remark": "改备注"}), 409)
    err_data(api.delete(f"/api/projects/{project}"), 409)


def test_解锁后可改_重新锁定后再被拦(api):
    project = _project(api, "完工锁-解锁")
    _labor_cost(api, project, "张三")
    ok_data(api.post(f"/api/projects/{project}/finish"))

    # 错误密码 → 400，且仍锁定
    err_data(api.post(f"/api/projects/{project}/unlock", json={"password": "wrong"}), 400)
    assert ok_data(api.get(f"/api/projects/{project}"))["is_locked"] is True

    # 正确密码 → 解锁
    unlocked = ok_data(api.post(f"/api/projects/{project}/unlock", json={"password": PWD}))
    assert unlocked["is_locked"] is False
    assert unlocked["unlocked_at"], "应记录解锁时间"

    # 解锁后可以写
    cost_id = _labor_cost(api, project, "李四", days="3")  # 900
    ok_data(api.put(f"/api/costs/{cost_id}", json={"remark": "解锁后改的"}))

    # 解锁是"一直有效"：再连改几笔都不需要再输密码
    _labor_cost(api, project, "王五", days="1")
    ok_data(api.post("/api/labor/settle", json={"project_id": project, "cost_type": "labor"}))

    # 手动重新锁定 → 又拦
    locked = ok_data(api.post(f"/api/projects/{project}/lock"))
    assert locked["is_locked"] is True
    err_data(api.put(f"/api/costs/{cost_id}", json={"remark": "锁定后改"}), 409)


def test_撤销完工需要密码(api):
    project = _project(api, "完工锁-撤销")
    ok_data(api.post(f"/api/projects/{project}/finish"))

    err_data(api.post(f"/api/projects/{project}/reopen", json={"password": "wrong"}), 400)
    assert ok_data(api.get(f"/api/projects/{project}"))["status"] == "finished"

    reopened = ok_data(api.post(f"/api/projects/{project}/reopen", json={"password": PWD}))
    assert reopened["status"] == "ongoing"
    assert reopened["is_locked"] is False, "撤销完工后应该完全不锁"

    # 在建项目本来就不锁，写操作直接通过
    _labor_cost(api, project, "张三")


def test_在建项目不受影响(api):
    project = _project(api, "完工锁-在建")
    # 没完工 → 不需要解锁就能写；lock/unlock/reopen 也不该乱来
    err_data(api.post(f"/api/projects/{project}/lock"), 400)
    err_data(api.post(f"/api/projects/{project}/unlock", json={"password": PWD}), 400)
    err_data(api.post(f"/api/projects/{project}/reopen", json={"password": PWD}), 400)
    _labor_cost(api, project, "张三")


def test_重复完工与解锁幂等(api):
    project = _project(api, "完工锁-幂等")
    ok_data(api.post(f"/api/projects/{project}/finish"))
    # 已完工再点完工 → 400
    err_data(api.post(f"/api/projects/{project}/finish"), 400)

    # 解锁两次都成功（幂等，只是刷新解锁时间）
    ok_data(api.post(f"/api/projects/{project}/unlock", json={"password": PWD}))
    ok_data(api.post(f"/api/projects/{project}/unlock", json={"password": PWD}))
    # 锁定两次都成功
    ok_data(api.post(f"/api/projects/{project}/lock"))
    ok_data(api.post(f"/api/projects/{project}/lock"))


def test_完工不影响任何金额(api):
    """锁只是权限，**不能动一个数字**。"""
    project = _project(api, "完工锁-金额不变")
    _labor_cost(api, project, "张三", days="5", rate="300")  # 1500

    before = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(before["metrics"]["actual_cost"], "1500.00")
    money_eq(before["metrics"]["suite_profit"] if "suite_profit" in before["metrics"] else before["metrics"]["settle_profit"], "98500.00")

    ok_data(api.post(f"/api/projects/{project}/finish"))

    after = ok_data(api.get(f"/api/projects/{project}/overview"))
    money_eq(after["metrics"]["actual_cost"], "1500.00")
    money_eq(after["metrics"]["settle_profit"], "98500.00")
    money_eq(after["metrics"]["expect_profit"], before["metrics"]["expect_profit"])


def test_锁定时错误里带机器可读信息(api):
    """前端靠 `data.reason == 'project_locked'` 自动弹密码框，结构必须稳定。"""
    project = _project(api, "完工锁-错误结构")
    ok_data(api.post(f"/api/projects/{project}/finish"))

    resp = api.post(
        "/api/costs/labor",
        json={"project_id": project, "worker_name": "张三", "work_days": "1", "day_rate": "300", "biz_date": "2026-05-10"},
    )
    payload = err_data(resp, 409)
    assert payload["data"] == {"reason": "project_locked", "project_id": project}, payload["data"]
