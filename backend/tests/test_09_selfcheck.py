"""docs/03-接口设计.md 第 14 节 —— 接口自测清单（14 条，按顺序执行）。

本模块共享一个临时数据库，测试之间有先后依赖关系（清单本身就是一条业务流水）。
"""

from __future__ import annotations

import io
import json

from openpyxl import load_workbook

from helpers import SECURITY_ANSWERS, envelope, err_data, money_eq, ok_data

# 模块内共享的上下文（清单本身是顺序业务流水）
STATE: dict[str, int] = {}


def test_01_未登录访问项目列表返回401(client):
    client.cookies.clear()
    response = client.get("/api/projects")
    assert response.status_code == 401
    payload = err_data(response, 401)
    assert payload["message"] == "未登录或会话已过期"


def test_02_默认密码登录后需要设置密保(client):
    data = ok_data(client.post("/api/auth/login", json={"password": "123456"}))
    assert data["logged_in"] is True
    assert data["security_ready"] is False
    assert data["is_initial_password"] is True
    assert "123456" not in json.dumps(data, ensure_ascii=False)  # 不回声密码
    ok_data(client.get("/api/projects"))  # 登录后可访问受保护接口


def test_03_密保答错一题返回403且不透露哪题错(client):
    ok_data(
        client.post(
            "/api/auth/security/setup",
            json={
                "questions": [
                    {"question": "我第一辆车的车牌号？", "answer": SECURITY_ANSWERS[0]},
                    {"question": "我母亲的姓名？", "answer": SECURITY_ANSWERS[1]},
                    {"question": "我小学的名字？", "answer": SECURITY_ANSWERS[2]},
                ]
            },
        )
    )
    questions = ok_data(client.get("/api/auth/security-questions"))
    assert questions == {"questions": ["我第一辆车的车牌号？", "我母亲的姓名？", "我小学的名字？"], "security_ready": True}

    # 第 1 / 2 / 3 题错：提示完全一致，绝不透露是哪一题错
    messages = set()
    for wrong_index in (0, 1, 2):
        answers = list(SECURITY_ANSWERS)
        answers[wrong_index] = "肯定不对的答案"
        response = client.post("/api/auth/security/verify", json={"answers": answers})
        messages.add(err_data(response, 403)["message"])
    assert messages == {"密保答案不正确"}

    # 全对 → 5 分钟票据
    data = ok_data(client.post("/api/auth/security/verify", json={"answers": SECURITY_ANSWERS}))
    assert data["ticket"].startswith("rst_")
    assert data["expires_in"] == 300
    STATE["ticket"] = 0  # 占位，重置密码在认证模块单独测


def test_04_建项目四百万_三十五万_预计利润五十万(client):
    response = client.post(
        "/api/projects",
        json={
            "name": "示例·某小区5#楼",
            "client_name": "某某置业有限公司",
            "location": "武汉市洪山区",
            "manager": "王工",
            "start_date": "2026-03-01",
            "status": "ongoing",
            "client_budget": 4000000.00,
            "cost_budget": 3500000.00,
            "members": ["王工", "张三", "李四"],
        },
    )
    data = ok_data(response)
    assert data["duplicate_name"] is False
    money_eq(data["expect_profit"], "500000.00")
    money_eq(data["actual_cost"], "0.00")
    money_eq(data["settle_profit"], "4000000.00")
    assert data["members"] == ["王工", "张三", "李四"]
    # 金额必须是 JSON 数字且保留两位（不是字符串）
    assert '"expect_profit":500000.00' in response.text
    assert '"expect_profit":"500000.00"' not in response.text

    STATE["project_id"] = int(data["id"])


def test_05_材料采购100吨乘400_成本四万_库存一百(client):
    project_id = STATE["project_id"]
    data = ok_data(
        client.post(
            "/api/costs/material",
            json={
                "project_id": project_id,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": 100,
                "unit_price": 400.00,
                "amount": 40000.00,
                "supplier": "某某建材",
                "biz_date": "2026-05-10",
            },
        )
    )
    assert data["cost_id"] > 0
    assert data["inventory_txn_id"] > 0
    assert str(data["inventory_balance"]) in ("100.000", "100.0", "100")

    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "40000.00")
    money_eq(overview["cost_by_type"]["material"], "40000.00")

    balances = ok_data(client.get("/api/inventory", params={"project_id": project_id}))["items"]
    assert len(balances) == 1
    assert balances[0]["material_name"] == "水泥"
    assert str(balances[0]["balance"]) in ("100.000", "100.0", "100")


def test_06_领用80吨_余量20_成本不变(client):
    project_id = STATE["project_id"]
    data = ok_data(
        client.post(
            "/api/inventory/out",
            json={
                "project_id": project_id,
                "material_name": "水泥",
                "unit": "吨",
                "quantity": 80,
                "biz_date": "2026-05-20",
                "remark": "5#楼三层砌筑",
            },
        )
    )
    assert data["enough"] is True
    assert str(data["balance"]) in ("20.000", "20.0", "20")

    # 领用只减库存，不产生成本
    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "40000.00")

    costs = ok_data(client.get("/api/costs", params={"project_id": project_id}))["items"]
    assert len(costs) == 1  # 只有采购那一条，领用没有写 cost
    assert costs[0]["type"] == "material"

    # 余量不足时仍然 code=0，只把 enough 置 false（允许先领后补录）
    short = ok_data(
        client.post(
            "/api/inventory/out",
            json={"project_id": project_id, "material_name": "水泥", "unit": "吨", "quantity": 50, "biz_date": "2026-05-21"},
        )
    )
    assert short["enough"] is False
    assert str(short["balance"]) in ("-30.000", "-30.0", "-30")


def test_07_录工天5天300元_成本加1500(client):
    project_id = STATE["project_id"]
    data = ok_data(
        client.post(
            "/api/costs/labor",
            json={
                "project_id": project_id,
                "worker_name": "张三",
                "biz_date": "2026-05-12",
                "work_days": 5,
                "day_rate": 300.00,
                "remark": "5#楼二层支模",
            },
        )
    )
    money_eq(data["amount"], "1500.00")
    STATE["labor_cost_id"] = int(data["cost_id"])

    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "41500.00")
    money_eq(overview["cost_by_type"]["labor"], "1500.00")


def test_08_人工结算金额一致_实际成本不变(client):
    project_id = STATE["project_id"]
    preview = ok_data(client.get("/api/labor/preview", params={"project_id": project_id}))
    assert len(preview["items"]) == 1
    assert preview["items"][0]["worker_name"] == "张三"
    money_eq(preview["items"][0]["amount_due"], "1500.00")
    assert str(preview["items"][0]["total_days"]) in ("5.00", "5.0", "5")
    money_eq(preview["total_amount"], "1500.00")
    assert preview["note"] == "结算不重复计入成本"

    settled = ok_data(
        client.post("/api/labor/settle", json={"project_id": project_id, "settle_date": "2026-07-01"})
    )
    assert settled["created"] == 1
    money_eq(settled["total_amount"], "1500.00")
    settle_id = int(settled["items"][0]["id"])
    STATE["settle_id"] = settle_id

    # 结算绝不新增成本
    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "41500.00")
    assert len(ok_data(client.get("/api/costs", params={"project_id": project_id}))["items"]) == 2

    # 重复生成结算单：覆盖未发放部分，仍然不新增成本
    again = ok_data(client.post("/api/labor/settle", json={"project_id": project_id}))
    assert again["created"] == 0 and again["updated"] == 1

    # 发放 1500 → 结清；再发一次必须被拒绝
    ok_data(
        client.post(
            f"/api/labor/settles/{settle_id}/pay",
            json={"amount": 1500.00, "pay_date": "2026-07-05", "pay_method": "wechat"},
        )
    )
    # 2026-10-16 起「已付/还欠」由应付单的冲销记录算（不再看结算单自己的 paid_amount）
    ov = ok_data(client.get("/api/labor/overview", params={"project_id": project_id}))
    row = next(item for item in ov["items"] if item["partner"] == "张三")
    money_eq(row["amount_due"], "1500.00")
    money_eq(row["paid_amount"], "1500.00")
    money_eq(row["unsettled"], "0.00")
    assert row["status"] == "closed"
    err_data(
        client.post(
            f"/api/labor/settles/{settle_id}/pay",
            json={"amount": 500.00, "pay_date": "2026-07-06", "pay_method": "cash"},
        ),
        400,
    )

    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "41500.00")


def test_09_应收50万收30万冲销_未收20万_结算利润不变(client):
    project_id = STATE["project_id"]
    before = ok_data(client.get("/api/dashboard/projects"))
    settle_profit_before = next(
        item["settle_profit"] for item in before["items"] if item["project_id"] == project_id
    )

    arap_id = int(
        ok_data(
            client.post(
                "/api/arap",
                json={
                    "project_id": project_id,
                    "type": "receivable",
                    "biz_type": "progress",
                    "amount": 500000.00,
                    "biz_date": "2026-06-01",
                    "partner": "某某置业有限公司",
                    "remark": "第三次进度款",
                },
            )
        )["id"]
    )
    flow_id = int(
        ok_data(
            client.post(
                "/api/funds",
                json={
                    "project_id": project_id,
                    "direction": "in",
                    "biz_type": "progress",
                    "amount": 300000.00,
                    "biz_date": "2026-06-20",
                    "partner": "某某置业有限公司",
                    "pay_method": "transfer",
                },
            )
        )["id"]
    )
    STATE["arap_id"] = arap_id
    STATE["flow_id"] = flow_id

    pending = ok_data(client.get("/api/arap/pending", params={"project_id": project_id, "type": "receivable"}))
    assert [item["id"] for item in pending["items"]] == [arap_id]
    money_eq(pending["items"][0]["unsettled"], "500000.00")

    # 单张冲销额不得超过单据未结额
    err_data(
        client.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": arap_id, "amount": 600000.00}],
                "offset_date": "2026-06-20",
            },
        ),
        400,
    )
    # 冲销合计不得超过流水金额
    err_data(
        client.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": arap_id, "amount": 300001.00}],
                "offset_date": "2026-06-20",
            },
        ),
        400,
    )

    result = ok_data(
        client.post(
            "/api/arap/offset",
            json={
                "funds_flow_id": flow_id,
                "offsets": [{"ar_ap_id": arap_id, "amount": 300000.00}],
                "offset_date": "2026-06-20",
            },
        )
    )
    money_eq(result["offset_amount"], "300000.00")
    money_eq(result["flow_offset_remaining"], "0.00")
    STATE["offset_id"] = int(result["offset_ids"][0])

    detail = ok_data(client.get(f"/api/arap/{arap_id}"))
    money_eq(detail["settled_amount"], "300000.00")
    money_eq(detail["unsettled"], "200000.00")
    assert detail["status"] == "partial"
    assert len(detail["offsets"]) == 1

    # 已产生冲销的流水不能直接删除
    err_data(client.delete(f"/api/funds/{flow_id}"), 409)
    # 已产生冲销的单据不能直接删除
    err_data(client.delete(f"/api/arap/{arap_id}"), 409)

    # 冲销不改成本、不改利润
    after = ok_data(client.get("/api/dashboard/projects"))
    row = next(item for item in after["items"] if item["project_id"] == project_id)
    assert row["settle_profit"] == settle_profit_before
    money_eq(row["unreceived"], "200000.00")
    money_eq(row["actual_cost"], "41500.00")
    money_eq(row["received"], "300000.00")

    summary = ok_data(client.get("/api/arap/summary", params={"project_id": project_id}))
    money_eq(summary["receivable_unsettled"], "200000.00")


def test_10_撤销冲销_未收回500000_状态回open(client):
    result = ok_data(client.delete(f"/api/arap/offset/{STATE['offset_id']}"))
    money_eq(result["unsettled"], "500000.00")
    assert result["status"] == "open"
    money_eq(result["flow_offset_total"], "0.00")

    detail = ok_data(client.get(f"/api/arap/{STATE['arap_id']}"))
    assert detail["status"] == "open"
    money_eq(detail["settled_amount"], "0.00")
    assert detail["offsets"] == []


def test_11_删除成本后实际成本减少且日志有delete(client):
    project_id = STATE["project_id"]
    cost_id = STATE["labor_cost_id"]
    ok_data(client.delete(f"/api/costs/{cost_id}"))

    overview = ok_data(client.get(f"/api/projects/{project_id}/overview"))
    money_eq(overview["metrics"]["actual_cost"], "40000.00")
    money_eq(overview["cost_by_type"]["labor"], "0.00")

    costs = ok_data(client.get("/api/costs", params={"project_id": project_id}))["items"]
    assert all(item["id"] != cost_id for item in costs)

    logs = ok_data(client.get("/api/logs", params={"table_name": "cost", "record_id": cost_id}))["items"]
    assert any(item["action"] == "delete" for item in logs)

    cost_logs = ok_data(client.get(f"/api/costs/{cost_id}/logs"))["items"]
    assert [item["action"] for item in cost_logs] == ["create", "delete"]
    assert cost_logs[-1]["before"]["amount"] == "1500.00"

    # 「显示已删除」开关
    with_deleted = ok_data(
        client.get("/api/costs", params={"project_id": project_id, "include_deleted": True})
    )["items"]
    assert any(item["id"] == cost_id and item["deleted"] == 1 for item in with_deleted)


def test_12_导出Excel_11个Sheet且行数正确(client):
    project_id = STATE["project_id"]
    response = client.get("/api/export/excel", params={"project_id": project_id})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert "attachment" in response.headers["content-disposition"]

    workbook = load_workbook(io.BytesIO(response.content))
    expected_names = [
        "项目盈亏",
        "资金流水",
        "人工",
        "材料",
        "机械",
        "杂费",
        "垫付",
        "应收",
        "应付",
        "库存",
        "人工结算",
    ]
    assert workbook.sheetnames == expected_names
    assert len(workbook.sheetnames) == 11

    expected_rows = {
        "项目盈亏": 3,  # 表头 + 1 个项目 + 合计
        # 表头 + 2 笔收付款 + 1 笔「人工结算发放」生成的付款流水
        # （2026-10-16 需求 T6：结算页登记发放也要生成付款流水并冲销应付单）
        "资金流水": 3,
        "人工": 1,  # 人工成本已软删除
        "材料": 2,
        "机械": 1,
        "杂费": 1,
        "垫付": 1,
        "应收": 2,
        # 应付：表头 + 材料/机械两笔成本各自自动生成的应付单（2026-10-15 起录成本即自动生成）
        "应付": 3,
        "库存": 2,
        "人工结算": 2,
    }
    for name, rows in expected_rows.items():
        assert workbook[name].max_row == rows, f"{name} 行数 {workbook[name].max_row} != {rows}"

    # 中文表头加粗 + 冻结首行 + 金额千分位两位小数 + 列宽自适应
    profit_sheet = workbook["项目盈亏"]
    assert profit_sheet["A1"].value == "项目"
    assert profit_sheet["A1"].font.bold is True
    assert profit_sheet.freeze_panes == "A2"
    assert profit_sheet["C2"].number_format == "#,##0.00"
    assert profit_sheet["E2"].value == 500000
    assert profit_sheet["F2"].value == 40000
    assert profit_sheet["A3"].value == "合计"

    material_sheet = workbook["材料"]
    assert material_sheet["A1"].value == "日期"
    assert material_sheet["C2"].value == "水泥"
    assert material_sheet["D2"].value == 100
    assert material_sheet["G2"].value == 40000
    assert material_sheet.column_dimensions["C"].width >= 9

    # 过滤条件生效：换成区间外的时间 → 材料 Sheet 只剩表头
    empty = client.get(
        "/api/export/excel", params={"project_id": project_id, "start_date": "2026-01-01", "end_date": "2026-02-01"}
    )
    workbook2 = load_workbook(io.BytesIO(empty.content))
    assert workbook2["材料"].max_row == 1
    assert workbook2["库存"].max_row == 2  # 库存是余额表，不受时间段影响（1 种材料）
    assert workbook2["项目盈亏"].max_row == 3  # 项目仍然列出（成本为 0）+ 合计


def test_13_时间段筛选只统计区间内的成本(client):
    project_id = STATE["project_id"]
    in_range = ok_data(
        client.get(
            f"/api/projects/{project_id}/overview",
            params={"start_date": "2026-05-01", "end_date": "2026-05-31"},
        )
    )
    money_eq(in_range["metrics"]["actual_cost"], "40000.00")  # 材料 5/10

    out_of_range = ok_data(
        client.get(
            f"/api/projects/{project_id}/overview",
            params={"start_date": "2026-03-01", "end_date": "2026-04-30"},
        )
    )
    money_eq(out_of_range["metrics"]["actual_cost"], "0.00")

    # 按 biz_date（业务发生日期）而不是创建时间
    trends = ok_data(client.get("/api/dashboard/cost-trend", params={"project_id": project_id}))
    assert [item["month"] for item in trends["items"]] == ["2026-05"]

    # 开始日期晚于结束日期 → 400
    err_data(
        client.get(
            f"/api/projects/{project_id}/overview",
            params={"start_date": "2026-06-01", "end_date": "2026-05-01"},
        ),
        400,
    )


def test_14_统一响应体与错误码(client):
    err_data(client.get("/api/projects/999999"), 404)
    payload = err_data(
        client.post("/api/costs/misc", json={"project_id": 1, "amount": -5, "biz_date": "2026-05-01"}), 400
    )
    assert "参数校验失败" in payload["message"]

    response = client.get("/api/not-exist")
    assert response.status_code == 404
    assert response.json()["code"] == 404

    payload = envelope(client.get("/api/auth/status"))
    assert payload["message"] == "ok"
    assert payload["code"] == 0
