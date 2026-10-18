"""验证：删除结算单后，「应付 / 已付 / 还欠」是否保持不变。

用户问的是：删掉结算单，已经付出去的钱会不会"涨回来"变成又欠着。
按设计（T11）：结算单只是"这一期该结多少"的快照，
应付来自成本、已付来自冲销记录，两者都不走结算单，所以删它账不该动。
"""

import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend")
sys.path.insert(0, BACKEND)

DB = os.path.join(os.environ["TEMP"], "pims_del_settle_check.db")
for suffix in ("", "-wal", "-shm"):
    path = DB + suffix
    if os.path.exists(path):
        os.remove(path)

os.environ["PIMS_DB_PATH"] = DB
os.environ["PIMS_AUTO_BACKUP"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402

init_db()
c = TestClient(app)

# 单会话后端：先登录拿到会话 cookie
login = c.post("/api/auth/login", json={"password": "123456"})
if login.status_code == 200 and login.json().get("data", {}).get("need_setup"):
    # 首次登录会要求设密保，随便设三条即可
    c.post(
        "/api/auth/setup-security",
        json={
            "answers": [
                {"question": "问题一", "answer": "答案一"},
                {"question": "问题二", "answer": "答案二"},
                {"question": "问题三", "answer": "答案三"},
            ]
        },
    )


def data(resp):
    assert resp.status_code == 200, (resp.status_code, resp.text)
    return resp.json()["data"]


def show(tag):
    ov = data(c.get("/api/labor/overview", params={"project_id": pid, "cost_type": "labor"}))
    row = next(item for item in ov["items"] if item["partner"] == "沈八")
    settles = data(c.get("/api/labor/settles", params={"project_id": pid, "cost_type": "labor"}))["items"]
    arap = data(c.get("/api/arap", params={"project_id": pid, "type": "payable"}))["items"]
    print(
        f"  {tag}\n"
        f"    总览：应付 {row['amount_due']:.2f}　已付 {row['paid_amount']:.2f}　"
        f"还欠 {row['unsettled']:.2f}　状态 {row['status']}\n"
        f"    结算单张数：{len(settles)}\n"
        f"    应付单：{[(a['id'], a['settled_amount'], a['status']) for a in arap]}"
    )
    return row, settles


pid = data(
    c.post(
        "/api/projects",
        json={"name": "删结算单验证", "client_budget": 100000, "cost_budget": 80000},
    )
)["id"]

# ① 录一笔人工 15 天 × 300 = 4500（会同时生成 4500 应付单）
data(
    c.post(
        "/api/costs/labor",
        json={"project_id": pid, "worker_name": "沈八", "work_days": "15", "day_rate": "300", "biz_date": "2026-10-01"},
    )
)
print("=== ① 刚录完成本 ===")
show("初始")

# ② 生成结算单
saved = data(c.post("/api/labor/settle", json={"project_id": pid, "cost_type": "labor"}))
settle_id = saved["items"][0]["id"]
print(f"\n=== ② 生成结算单（id={settle_id}）===")
show("生成后")

# ③ 发放 500
data(c.post("/api/labor/pay", json={
    "project_id": pid, "cost_type": "labor", "partner": "沈八",
    "amount": "500", "pay_date": "2026-10-16", "pay_method": "wechat",
}))
print("\n=== ③ 登记发放 500 ===")
before, settles_before = show("发放后")
arap_before = data(c.get("/api/arap", params={"project_id": pid, "type": "payable"}))["items"]

# ④ 删除结算单
data(c.delete(f"/api/labor/settles/{settle_id}"))
print(f"\n=== ④ 删除结算单 (id={settle_id}) ===")
after, settles_after = show("删除后")

arap_after = data(c.get("/api/arap", params={"project_id": pid, "type": "payable"}))["items"]
flows = data(c.get("/api/funds", params={"project_id": pid, "direction": "out"}))["items"]
offsets = data(c.get(f"/api/arap/{arap_after[0]['id']}"))["offsets"]

print("\n" + "=" * 64)
print("结论：")
checks = [
    ("总览·应付", before["amount_due"], after["amount_due"]),
    ("总览·已付", before["paid_amount"], after["paid_amount"]),
    ("总览·还欠", before["unsettled"], after["unsettled"]),
    ("应付单·已冲销", arap_before[0]["settled_amount"], arap_after[0]["settled_amount"]),
]
ok = True
for name, b, a in checks:
    same = f"{b:.2f}" == f"{a:.2f}"
    ok = ok and same
    print(f"  {name:14} 删除前 {b:>10.2f}　删除后 {a:>10.2f}　{'不变 ✓' if same else '变了 ✗'}")

print(f"  结算单张数      删除前 {len(settles_before)}　删除后 {len(settles_after)}　{'（唯一被删掉的东西）' if len(settles_after) < len(settles_before) else '未删除 ✗'}")
print(f"  付款流水        仍存在 {len(flows)} 笔（钱没有凭空消失）")
print(f"  冲销记录        仍存在 {len(offsets)} 条")
print(f"\n{'✅ 账没变，只是那张"本期该结多少"的快照没了' if ok else '❌ 账动了，不符合预期'}")
sys.exit(0 if ok else 1)
