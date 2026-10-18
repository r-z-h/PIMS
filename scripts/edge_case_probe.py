"""第二轮自检：金额/数量精度边界 + 库存回冲 + 极端数值（真实尺度数字）。

用法：
  起后端（独立临时库）后：
    backend\\.venv\\Scripts\\python.exe scripts\\edge_case_probe.py http://127.0.0.1:8020

设计原则：只打「没验过的交接面」——前端 JS double / 后端 Decimal / SQLite NUMERIC 的边界，
以及「买入库后删除成本，库存是否回冲」这类跨模块动作。
"""
from __future__ import annotations

import sys
from decimal import Decimal

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8020"

PASSED: list[str] = []
FAILED: list[str] = []


def safe_print(text: str) -> None:
    try:
        print(text)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(text.encode(enc, errors="replace").decode(enc, errors="replace"))


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    safe_print(f"{'[OK]  ' if ok else '[FAIL]'} {name}{(' -> ' + detail) if detail else ''}")


def D(v, q="0.01") -> Decimal:
    if v is None:
        return Decimal("-1")
    return Decimal(str(v)).quantize(Decimal(q))


def main() -> int:
    with httpx.Client(timeout=30.0) as c:
        r = c.post(BASE + "/api/auth/login", json={"password": "123456"})
        assert r.json()["code"] == 0, r.text
        c.post(BASE + "/api/auth/security/setup", json={"questions": [
            {"question": "边界问题1", "answer": "a1"},
            {"question": "边界问题2", "answer": "a2"},
            {"question": "边界问题3", "answer": "a3"},
        ]})

        def api(method, path, **kw):
            resp = c.request(method, BASE + path, **kw)
            try:
                return resp.status_code, resp.json()
            except Exception:
                return resp.status_code, {"_raw": resp.text[:200]}

        def data(body):
            return (body or {}).get("data")

        # ---------- 建项目：合同额 0（极端值）----------
        st, body = api("POST", "/api/projects", json={
            "name": "边界测试项目" + "长" * 40, "client_budget": 0, "cost_budget": 0,
            "start_date": "2026-01-01", "status": "ongoing",
        })
        pid = (data(body) or {}).get("id")
        check("合同额/成本预算填 0 可建项目（不崩）", body.get("code") == 0 and pid, str(body)[:150])
        check("超长中文项目名可保存", body.get("code") == 0, str(body)[:100])

        st, body = api("GET", f"/api/projects/{pid}/overview")
        m = (data(body) or {}).get("metrics", {})
        check("预算全 0 时预计利润 = 0", D(m.get("expect_profit")) == Decimal("0.00"),
              f"expect_profit={m.get('expect_profit')}")

        # ---------- 精度 1：材料 2.5 吨 × 412.37 = 1030.925 → 应四舍五入到分 ----------
        st, body = api("POST", "/api/costs/material", json={
            "project_id": pid, "material_name": "水泥", "unit": "吨",
            "quantity": 2.5, "unit_price": 412.37, "biz_date": "2026-02-01",
        })
        amt = (data(body) or {}).get("amount")
        check("材料 2.5 × 412.37 → 1030.93（分位四舍五入）",
              D(amt) == Decimal("1030.93"), f"amount={amt}（期望 1030.93）")

        # ---------- 精度 2：三位小数数量 1.234 吨 × 100 = 123.40 ----------
        st, body = api("POST", "/api/costs/material", json={
            "project_id": pid, "material_name": "砂子", "unit": "吨",
            "quantity": 1.234, "unit_price": 100, "biz_date": "2026-02-01",
        })
        amt2 = (data(body) or {}).get("amount")
        check("材料 1.234 × 100 → 123.40（保留分）", D(amt2) == Decimal("123.40"), f"amount={amt2}")

        # ---------- 精度 3：半个人工日 0.5 × 333.33 = 166.665 → 166.67 ----------
        st, body = api("POST", "/api/costs/labor", json={
            "project_id": pid, "worker_name": "张三", "biz_date": "2026-02-02",
            "work_days": 0.5, "day_rate": 333.33,
        })
        amt3 = (data(body) or {}).get("amount")
        check("人工 0.5 工日 × 333.33 → 166.67", D(amt3) == Decimal("166.67"), f"amount={amt3}")

        # ---------- 精度 4：机械按小时 7.5 小时 × 88.88 = 666.60 ----------
        st, body = api("POST", "/api/costs/machine", json={
            "project_id": pid, "machine_name": "挖机", "measure": "hour",
            "quantity": 7.5, "unit_price": 88.88, "biz_date": "2026-02-03",
        })
        amt4 = (data(body) or {}).get("amount")
        check("机械 7.5 小时 × 88.88 → 666.60", D(amt4) == Decimal("666.60"), f"amount={amt4}")

        # ---------- 精度 5：合计是否精确等于四项之和（无浮点漂移）----------
        st, body = api("GET", f"/api/projects/{pid}/overview")
        actual = D((data(body) or {}).get("metrics", {}).get("actual_cost"))
        expect = sum((D(amt), D(amt2), D(amt3), D(amt4)), Decimal("0.00"))
        check(f"实际成本 = 四项精确之和（{expect}）", actual == expect,
              f"actual={actual} 期望={expect}")

        # ---------- 精度 6：结算利润 = 0 - 合计（负数，亏本口径）----------
        sp = D((data(body) or {}).get("metrics", {}).get("settle_profit"))
        check("合同额 0 + 有成本 → 结算利润为负（亏本可表达）",
              sp == (Decimal("0.00") - expect), f"settle_profit={sp}")

        # ---------- 库存回冲：删掉材料成本，库存必须跟着减 ----------
        st, body = api("POST", "/api/costs/material", json={
            "project_id": pid, "material_name": "钢筋", "unit": "吨",
            "quantity": 10, "unit_price": 4000, "biz_date": "2026-02-04",
            "supplier": "某钢厂",
        })
        cost_id = (data(body) or {}).get("cost_id")
        st, body = api("GET", "/api/inventory", params={"project_id": pid})
        rows = {x["material_name"]: x for x in (data(body) or {}).get("items", [])}
        before = D(rows.get("钢筋", {}).get("balance"), "0.001")
        check("采购 10 吨钢筋后库存余量 = 10", before == Decimal("10.000"), f"balance={before}")

        st, body = api("DELETE", f"/api/costs/{cost_id}")
        check("删除材料成本成功", body.get("code") == 0, str(body)[:150])

        st, body = api("GET", "/api/inventory", params={"project_id": pid})
        rows = {x["material_name"]: x for x in (data(body) or {}).get("items", [])}
        after = D(rows.get("钢筋", {}).get("balance"), "0.001") if "钢筋" in rows else Decimal("0.000")
        check("删除材料成本后库存回冲为 0（不留虚高）", after == Decimal("0.000"), f"balance={after}")

        st, body = api("GET", f"/api/projects/{pid}/overview")
        actual2 = D((data(body) or {}).get("metrics", {}).get("actual_cost"))
        # 注意：`expect` 是「四项之和」（不含钢筋 4 万），钢筋是之后才采购的，
        # 所以删除钢筋后实际成本应当回到 expect，而不是 expect − 4 万。
        check("删除后实际成本回到四项之和（4 万成本已扣除）",
              actual2 == expect, f"actual={actual2} 期望={expect}")

        # ---------- 大额：千万级合同额，看有无精度损失 ----------
        st, body = api("POST", "/api/projects", json={
            "name": "大额项目", "client_budget": 98765432.10, "cost_budget": 87654321.05,
            "start_date": "2026-01-01", "status": "ongoing",
        })
        big_pid = (data(body) or {}).get("id")
        st, body = api("GET", f"/api/projects/{big_pid}/overview")
        m2 = (data(body) or {}).get("metrics", {})
        exp_big = Decimal("98765432.10") - Decimal("87654321.05")
        check(f"千万级预计利润 = {exp_big}（无精度损失）",
              D(m2.get("expect_profit")) == exp_big, f"expect_profit={m2.get('expect_profit')}")

        # ---------- 负数/零校验 ----------
        st, body = api("POST", "/api/costs/misc", json={
            "project_id": pid, "category": "伙食费", "amount": 0, "biz_date": "2026-02-05",
        })
        check("金额 0 被拒绝（400）", body.get("code") == 400, f"code={body.get('code')} msg={body.get('message')}")

        st, body = api("POST", "/api/costs/misc", json={
            "project_id": pid, "category": "伙食费", "amount": -100, "biz_date": "2026-02-05",
        })
        check("负数金额被拒绝（400）", body.get("code") == 400, f"code={body.get('code')} msg={body.get('message')}")

        # ---------- 领用超过库存：应允许但 enough=false ----------
        st, body = api("POST", "/api/inventory/out", json={
            "project_id": pid, "material_name": "水泥", "unit": "吨",
            "quantity": 99, "biz_date": "2026-02-06",
        })
        d = data(body) or {}
        check("领用超库存：允许提交但 enough=false",
              body.get("code") == 0 and d.get("enough") is False,
              f"code={body.get('code')} enough={d.get('enough')} balance={d.get('balance')}")

    safe_print("\n================ 边界探针汇总 ================")
    safe_print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for f in FAILED:
        safe_print(f"  失败：{f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
