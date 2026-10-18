"""测试辅助函数。"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from httpx import Response

# 密保测试答案（与 conftest 的 secured_client 保持一致）
SECURITY_ANSWERS = ["鄂A12345", "李秀兰", "实验小学"]


def envelope(response: Response) -> dict[str, Any]:
    """返回统一响应体（断言 HTTP 状态码与信封 code 对应：0 ↔ 200，错误码 ↔ 同名 HTTP 码）。"""
    payload = response.json()
    assert set(payload.keys()) == {"code", "message", "data"}, payload
    expected_http = 200 if payload["code"] == 0 else payload["code"]
    assert response.status_code == expected_http, (
        f"HTTP {response.status_code} 与信封 code {payload['code']} 不一致：{payload}"
    )
    return payload


def ok_data(response: Response) -> Any:
    """断言成功并返回 data。"""
    payload = envelope(response)
    assert payload["code"] == 0, payload
    return payload["data"]


def err_data(response: Response, code: int) -> dict[str, Any]:
    """断言指定错误码并返回信封。

    注：data 不再强制为 None —— 有些错误会带**机器可读**的补充信息
    （如项目完工锁的 `{"reason": "project_locked", "project_id": 3}`），
    前端靠它自动弹密码框。需要用 data 的用例自己断言具体内容。
    """
    payload = envelope(response)
    assert payload["code"] == code, payload
    return payload


def money_eq(value: Any, expected: str) -> None:
    """金额断言：JSON 数字按 Decimal 精确比较（两位小数）。"""
    assert money_of(value) == Decimal(expected), f"{value!r} != {expected}"


def money_of(value: Any) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def make_project(client, name: str, client_budget: str = "4000000.00", cost_budget: str = "3500000.00") -> int:
    data = ok_data(
        client.post(
            "/api/projects",
            json={"name": name, "client_budget": client_budget, "cost_budget": cost_budget},
        )
    )
    return int(data["id"])


def project_metrics(client, project_id: int, start: str | None = None, end: str | None = None) -> dict[str, Any]:
    params = {}
    if start:
        params["start_date"] = start
    if end:
        params["end_date"] = end
    data = ok_data(client.get(f"/api/projects/{project_id}/overview", params=params))
    return data["metrics"]


def dashboard_row(client, project_id: int, start: str | None = None, end: str | None = None) -> dict[str, Any]:
    params = {}
    if start:
        params["start_date"] = start
    if end:
        params["end_date"] = end
    data = ok_data(client.get("/api/dashboard/projects", params=params))
    for item in data["items"]:
        if item["project_id"] == project_id:
            return item
    raise AssertionError(f"项目 {project_id} 不在盈亏总表中")


def add_labor(client, project_id: int, worker: str, days: str, rate: str, biz_date: str = "2026-05-12") -> int:
    data = ok_data(
        client.post(
            "/api/costs/labor",
            json={
                "project_id": project_id,
                "worker_name": worker,
                "biz_date": biz_date,
                "work_days": days,
                "day_rate": rate,
            },
        )
    )
    return int(data["cost_id"])


def add_material(
    client,
    project_id: int,
    name: str = "水泥",
    unit: str = "吨",
    quantity: str = "100",
    unit_price: str = "400",
    biz_date: str = "2026-05-10",
    supplier: str = "某某建材",
) -> dict[str, Any]:
    return ok_data(
        client.post(
            "/api/costs/material",
            json={
                "project_id": project_id,
                "material_name": name,
                "unit": unit,
                "quantity": quantity,
                "unit_price": unit_price,
                "supplier": supplier,
                "biz_date": biz_date,
            },
        )
    )


def add_misc(client, project_id: int, category: str, amount: str, biz_date: str = "2026-05-12") -> int:
    data = ok_data(
        client.post(
            "/api/costs/misc",
            json={"project_id": project_id, "category": category, "amount": amount, "biz_date": biz_date},
        )
    )
    return int(data["cost_id"])


def add_machine(
    client,
    project_id: int,
    quantity: str = "10",
    unit_price: str = "2000",
    biz_date: str = "2026-05-11",
) -> int:
    data = ok_data(
        client.post(
            "/api/costs/machine",
            json={
                "project_id": project_id,
                "machine_name": "挖机(小松200)",
                "measure": "shift",
                "quantity": quantity,
                "unit_price": unit_price,
                "lessor": "李老板",
                "biz_date": biz_date,
            },
        )
    )
    return int(data["cost_id"])


def add_advance(client, project_id: int, amount: str = "50000", biz_date: str = "2026-05-15") -> int:
    data = ok_data(
        client.post(
            "/api/costs/advance",
            json={
                "project_id": project_id,
                "payer": "老板",
                "purpose": "临时买料",
                "amount": amount,
                "biz_date": biz_date,
            },
        )
    )
    return int(data["cost_id"])


def add_receivable(
    client,
    project_id: int,
    amount: str = "500000",
    biz_type: str = "progress",
    biz_date: str = "2026-06-01",
) -> int:
    data = ok_data(
        client.post(
            "/api/arap",
            json={
                "project_id": project_id,
                "type": "receivable",
                "biz_type": biz_type,
                "amount": amount,
                "biz_date": biz_date,
                "partner": "某某置业有限公司",
            },
        )
    )
    return int(data["id"])


def add_funds(
    client,
    project_id: int,
    direction: str = "in",
    amount: str = "300000",
    biz_type: str | None = None,
    biz_date: str = "2026-06-20",
) -> int:
    if biz_type is None:
        biz_type = "progress" if direction == "in" else "material"
    data = ok_data(
        client.post(
            "/api/funds",
            json={
                "project_id": project_id,
                "direction": direction,
                "biz_type": biz_type,
                "amount": amount,
                "biz_date": biz_date,
                "partner": "某某置业有限公司" if direction == "in" else "某某建材",
                "pay_method": "transfer",
            },
        )
    )
    return int(data["id"])
