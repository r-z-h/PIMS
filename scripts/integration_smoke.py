r"""PIMS 端到端冒烟测试（集成方使用，不属于前后端任一方的交付物）。

用法：
  1. 先启动后端（用临时数据库，避免污染真实数据）：
       $env:PIMS_DB_PATH = "$env:TEMP\pims_smoke.db"
       backend\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8010 --app-dir backend
  2. 再跑：
       backend\.venv\Scripts\python.exe scripts\integration_smoke.py http://127.0.0.1:8010

校验 docs/03-接口设计.md 第 14 节的端到端数字：
  400 万 / 350 万 → 预计利润 50 万；材料 100 吨×400 → 成本 +4 万、库存 100；
  领用 80 → 余量 20 且成本不变；工天 5×300 → 成本 +1500，结算后仍为 1500；
  应收 50 万收 30 万冲销 → 未收 20 万且结算利润不变。
"""
from __future__ import annotations

import sys
from decimal import Decimal

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8010"

PASSED: list[str] = []
FAILED: list[str] = []


def safe_print(text: str) -> None:
    """控制台可能是 GBK，遇到编不出的字符（如 − ✓）降级输出，避免脚本自己崩掉。"""
    try:
        print(text)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(text.encode(enc, errors="replace").decode(enc, errors="replace"))


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    safe_print(f"{'[OK]  ' if ok else '[FAIL]'} {name}{(' -> ' + detail) if detail else ''}")


def money(v) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


def call(client: httpx.Client, method: str, path: str, **kw):
    r = client.request(method, BASE + path, **kw)
    try:
        body = r.json()
    except Exception:
        body = {"_raw": r.text[:200], "_status": r.status_code}
    return r.status_code, body


def data_of(body):
    return (body or {}).get("data") if isinstance(body, dict) else None


def main() -> int:
    with httpx.Client(timeout=30.0) as c:
        # --- 1. 未登录必须 401 ---
        st, body = call(c, "GET", "/api/projects")
        check("未登录访问 /api/projects 返回 401", st == 401 or body.get("code") == 401,
              f"status={st} body={body}")

        # --- 2. 默认密码登录 ---
        st, body = call(c, "POST", "/api/auth/login", json={"password": "123456"})
        d = data_of(body) or {}
        check("默认密码 123456 登录成功", st == 200 and body.get("code") == 0, str(body)[:160])
        check("首次登录 security_ready=false（前端应跳密保页）", d.get("security_ready") is False,
              f"security_ready={d.get('security_ready')}")

        # --- 3. 设置密保 + 答错/答对 ---
        st, body = call(c, "POST", "/api/auth/security/setup", json={"questions": [
            {"question": "我第一辆车的车牌号？", "answer": "鄂A12345"},
            {"question": "我母亲的姓名？", "answer": "李秀兰"},
            {"question": "我小学的名字？", "answer": "实验小学"},
        ]})
        check("设置 3 组密保成功", body.get("code") == 0, str(body)[:160])

        st, body = call(c, "POST", "/api/auth/security/verify",
                        json={"answers": ["鄂A12345", "李秀兰", "错误答案"]})
        check("密保答错返回 403 且不提示哪题错",
              body.get("code") == 403 and "不正确" in str(body.get("message", "")),
              str(body)[:160])

        st, body = call(c, "POST", "/api/auth/security/verify",
                        json={"answers": ["鄂A12345", "李秀兰", "实验小学"]})
        ticket = (data_of(body) or {}).get("ticket")
        check("密保全对返回 ticket", body.get("code") == 0 and bool(ticket), str(body)[:160])

        # --- 4. 建项目：400 万 / 350 万 ---
        st, body = call(c, "POST", "/api/projects", json={
            "name": "冒烟测试项目", "client_name": "某某置业", "location": "武汉",
            "manager": "王工", "start_date": "2026-03-01", "status": "ongoing",
            "client_budget": 4000000.00, "cost_budget": 3500000.00,
            "members": ["王工", "张三"], "remark": "",
        })
        pid = (data_of(body) or {}).get("id")
        check("新建项目（甲方 400 万 / 成本 350 万）", body.get("code") == 0 and pid, str(body)[:200])

        st, body = call(c, "GET", f"/api/projects/{pid}/overview")
        m = (data_of(body) or {}).get("metrics", {})
        check("预计利润 = 400 万 − 350 万 = 50 万", money(m.get("expect_profit", -1)) == money(500000),
              f"expect_profit={m.get('expect_profit')}")

        # --- 5. 材料采购 100 吨 × 400，同时入库 ---
        st, body = call(c, "POST", "/api/costs/material", json={
            "project_id": pid, "material_name": "水泥", "unit": "吨",
            "quantity": 100, "unit_price": 400.00, "amount": 40000.00,
            "supplier": "某某建材", "biz_date": "2026-05-10", "remark": "",
        })
        d = data_of(body) or {}
        check("材料采购写入成本", body.get("code") == 0, str(body)[:200])
        check("采购同时生成库存入库且余量 = 100",
              Decimal(str(d.get("inventory_balance", -1))) == Decimal("100"), str(d)[:200])

        # --- 6. 领用 80 吨：只减库存，成本不变 ---
        st, body = call(c, "POST", "/api/inventory/out", json={
            "project_id": pid, "material_name": "水泥", "unit": "吨",
            "quantity": 80, "biz_date": "2026-05-20", "remark": "三层砌筑",
        })
        d = data_of(body) or {}
        check("领用后库存余量 = 20",
              Decimal(str(d.get("balance", -1))) == Decimal("20"), str(d)[:200])

        st, body = call(c, "GET", "/api/costs/summary", params={"project_id": pid})
        cost_after_use = None
        d = data_of(body) or {}
        if isinstance(d, dict):
            cost_after_use = d.get("total") or d.get("total_amount")
        check("领用不产生新成本（成本仍为 40000）",
              cost_after_use is not None and money(cost_after_use) == money(40000),
              f"summary={str(d)[:200]}")

        # --- 7. 工天 5 × 300 ---
        st, body = call(c, "POST", "/api/costs/labor", json={
            "project_id": pid, "worker_name": "张三", "biz_date": "2026-05-12",
            "work_days": 5, "day_rate": 300.00, "remark": "支模",
        })
        check("录工天 5×300 成功", body.get("code") == 0, str(body)[:160])

        st, body = call(c, "GET", f"/api/projects/{pid}/overview")
        m = (data_of(body) or {}).get("metrics", {})
        check("实际成本 = 40000 + 1500 = 41500",
              money(m.get("actual_cost", -1)) == money(41500), f"actual_cost={m.get('actual_cost')}")
        check("结算利润 = 400 万 − 41500 = 3958500",
              money(m.get("settle_profit", -1)) == money(3958500), f"settle_profit={m.get('settle_profit')}")

        # --- 8. 人工结算不重复入成本 ---
        st, body = call(c, "GET", "/api/labor/preview", params={"project_id": pid})
        items = (data_of(body) or {}).get("items", [])
        due = items[0].get("amount_due") if items else None
        check("结算预览应发 = 1500", due is not None and money(due) == money(1500), str(due))

        st, body = call(c, "POST", "/api/labor/settle", json={"project_id": pid})
        check("保存结算单成功", body.get("code") == 0, str(body)[:160])

        st, body = call(c, "GET", f"/api/projects/{pid}/overview")
        m = (data_of(body) or {}).get("metrics", {})
        check("结算后实际成本不变（仍 41500）",
              money(m.get("actual_cost", -1)) == money(41500), f"actual_cost={m.get('actual_cost')}")

        # --- 9. 应收 50 万，收 30 万冲销 ---
        st, body = call(c, "POST", "/api/arap", json={
            "project_id": pid, "type": "receivable", "biz_type": "progress",
            "amount": 500000.00, "biz_date": "2026-06-01",
            "partner": "某某置业", "remark": "进度款",
        })
        arap_id = (data_of(body) or {}).get("id")
        check("录应收单 50 万", body.get("code") == 0 and arap_id, str(body)[:200])

        st, body = call(c, "POST", "/api/funds", json={
            "project_id": pid, "direction": "in", "biz_type": "progress",
            "amount": 300000.00, "biz_date": "2026-06-20",
            "partner": "某某置业", "pay_method": "transfer", "remark": "",
        })
        flow_id = (data_of(body) or {}).get("id")
        check("录收款流水 30 万", body.get("code") == 0 and flow_id, str(body)[:200])

        st, body = call(c, "POST", "/api/arap/offset", json={
            "funds_flow_id": flow_id,
            "offsets": [{"ar_ap_id": arap_id, "amount": 300000.00}],
            "offset_date": "2026-06-20", "remark": "",
        })
        check("手工冲销 30 万成功", body.get("code") == 0, str(body)[:200])

        st, body = call(c, "GET", "/api/arap", params={"type": "receivable", "project_id": pid})
        rows = (data_of(body) or {}).get("items", [])
        unsettled = rows[0].get("unsettled") if rows else None
        if unsettled is None:
            unsettled = rows[0].get("amount") - rows[0].get("settled_amount") if rows else None
        check("未收余额 = 20 万", unsettled is not None and money(unsettled) == money(200000),
              f"unsettled={unsettled}")

        st, body = call(c, "GET", f"/api/projects/{pid}/overview")
        m = (data_of(body) or {}).get("metrics", {})
        check("冲销不影响结算利润（仍 3958500）",
              money(m.get("settle_profit", -1)) == money(3958500), f"settle_profit={m.get('settle_profit')}")

        # --- 10. 改密（密保全对）后可用新密码登录 ---
        st, body = call(c, "POST", "/api/auth/security/verify",
                        json={"answers": ["鄂A12345", "李秀兰", "实验小学"]})
        ticket2 = (data_of(body) or {}).get("ticket")
        st, body = call(c, "POST", "/api/auth/password/reset",
                        json={"ticket": ticket2, "new_password": "newpass888"})
        check("密保全对后可改密码", body.get("code") == 0, str(body)[:160])

        # --- 11. 导出 Excel ---
        r = c.get(BASE + "/api/export/excel", params={"project_id": pid})
        ok = r.status_code == 200 and "spreadsheet" in r.headers.get("content-type", "")
        check("导出 Excel 返回 xlsx 文件流", ok,
              f"status={r.status_code} type={r.headers.get('content-type')}")

        # --- 12. 收尾：把密码改回 123456 ---
        # 本脚本会改密码，若与其他用例共享同一个数据库，后续用例将无法用 123456 登录，
        # 造成「测试互相污染」的假故障。这里恢复初始口令，保持环境干净。
        st, body = call(c, "POST", "/api/auth/security/verify",
                        json={"answers": ["鄂A12345", "李秀兰", "实验小学"]})
        ticket3 = (data_of(body) or {}).get("ticket")
        st, body = call(c, "POST", "/api/auth/password/reset",
                        json={"ticket": ticket3, "new_password": "123456"})
        check("收尾：密码已恢复为 123456（避免污染后续用例）",
              body.get("code") == 0, str(body)[:160])

    safe_print("\n================ 汇总 ================")
    safe_print(f"通过 {len(PASSED)} 项，失败 {len(FAILED)} 项")
    for f in FAILED:
        safe_print(f"  失败：{f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
