"""快速查询：把「按需看一类数」包装成统一结构（2026-10-19 需求）。

设计要点（与用户约定）：
- **只做展示，不新增任何业务口径**：每个查询都调用现有 service，
  所以结果与页面上看到的数字必然一致。
- 返回 **blocks 数组**，每块自带 `columns` 定义 + `rows` + `summary`，
  前端只写一个循环 + 一个表格组件，新增查询类型时前端零改动。
- **一种查询失败不影响其他块**：逐块 try，失败块带 `error` 字段。

规则注册表 `QUERY_TYPES` 是唯一扩展点：加一种查询 = 写一个 `_xxx()` 函数 +
在注册表里加一行 + 在 `_RUNNERS` 里登记。
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..models.ar_ap import TYPE_LABELS as ARAP_TYPE_LABELS
from ..models.ar_ap import TYPE_PAYABLE, TYPE_RECEIVABLE
from ..models.cost import COST_TYPES, TYPE_LABELS as COST_TYPE_LABELS
from ..utils.dates import dstr
from ..utils.errors import BadRequest
from ..utils.money import ZERO, money, percent

# --------------------------------------------------------------------------- 注册表

# 列类型 → 前端渲染方式（金额右对齐两位小数、数量三位、日期、文本、状态标签）
COL_TEXT = "text"
COL_MONEY = "money"
COL_QTY = "qty"
COL_DATE = "date"
COL_PERCENT = "percent"
COL_STATUS = "status"

QUERY_TYPES: tuple[dict[str, Any], ...] = (
    {
        "code": "labor_unsettled",
        "name": "工人未结款",
        "description": "按工人汇总：累计应付 / 已付 / 还欠，附付款方式构成",
        "needs_project": True,
        "source": "labor_service.settlement_overview",
    },
    {
        "code": "arap_unsettled",
        "name": "往来未结",
        "description": "应收未收 / 应付未付的单据明细",
        "needs_project": True,
        "source": "arap_service.summary + pending",
    },
    {
        "code": "cost_budget",
        "name": "成本与预算",
        "description": "五类成本构成、占比，以及与成本预算的对比",
        "needs_project": True,
        "source": "project_service.overview",
    },
)

QUERY_CODES: tuple[str, ...] = tuple(item["code"] for item in QUERY_TYPES)
QUERY_NAMES: dict[str, str] = {item["code"]: item["name"] for item in QUERY_TYPES}

# 默认全选顺序 = 注册表顺序
DEFAULT_TYPES: list[str] = list(QUERY_CODES)


def list_types() -> list[dict[str, Any]]:
    """可选查询清单（前端据此渲染勾选框，默认全选）。"""
    return [
        {
            "code": item["code"],
            "name": item["name"],
            "description": item["description"],
            "needs_project": item["needs_project"],
            "default_selected": True,
        }
        for item in QUERY_TYPES
    ]


# --------------------------------------------------------------------------- 列定义


def _col(key: str, title: str, type_: str = COL_TEXT, *, width: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"key": key, "title": title, "type": type_}
    if width:
        out["width"] = width
    return out


# --------------------------------------------------------------------------- 各查询实现


def _labor_unsettled(
    db: Session, project_id: int, start: date | None, end: date | None
) -> dict[str, Any]:
    """工人未结款：直接复用结算页的欠款总览（已付来自冲销记录，与页面同源）。"""
    from . import labor_service

    data = labor_service.settlement_overview(db, project_id, "labor", start, end)
    items = data["items"]

    rows: list[dict[str, Any]] = []
    for item in items:
        methods = item.get("paid_methods") or []
        rows.append(
            {
                "partner": item["partner"],
                "amount_due": money(item["amount_due"]),
                "paid_amount": money(item["paid_amount"]),
                "unsettled": money(item["unsettled"]),
                "paid_methods_text": "、".join(
                    f"{m['pay_method_label']} {money(m['amount']):.2f}" for m in methods
                )
                or "—",
                "status": item["status"],
            }
        )

    # 只留还欠 > 0 的人在「未结款」里更直观，但要能看全，所以不筛；
    # 排序：还欠多的在前（与结算页一致）
    rows.sort(key=lambda r: (-r["unsettled"], -r["amount_due"]))

    return {
        "type": "labor_unsettled",
        "title": "工人未结款",
        "columns": [
            _col("partner", "工人", width=120),
            _col("amount_due", "累计应付", COL_MONEY, width=140),
            _col("paid_amount", "已付", COL_MONEY, width=140),
            _col("unsettled", "还欠", COL_MONEY, width=140),
            _col("paid_methods_text", "已付构成"),
        ],
        "rows": rows,
        "summary": {
            "total_due": money(data["total_due"]),
            "total_paid": money(data["total_paid"]),
            "total_unsettled": money(data["total_unsettled"]),
            "worker_count": len(rows),
        },
        "empty_text": "该项目暂无工人成本记录",
        "note": "已付 = 该工人名下应付单的全部冲销记录之和（与结算页一致）",
    }


def _arap_unsettled(
    db: Session, project_id: int, start: date | None, end: date | None
) -> dict[str, Any]:
    """往来未结：应收 / 应付合并成一张表，一单据一行。"""
    from . import arap_service

    rows: list[dict[str, Any]] = []
    for type_, label in (
        (TYPE_RECEIVABLE, ARAP_TYPE_LABELS[TYPE_RECEIVABLE]),
        (TYPE_PAYABLE, ARAP_TYPE_LABELS[TYPE_PAYABLE]),
    ):
        for item in arap_service.pending(db, project_id, type_):
            # 时间段只用于限定单据日期（与页面的 biz_date 筛选一致）
            if start and item["biz_date"] < dstr(start):
                continue
            if end and item["biz_date"] > dstr(end):
                continue
            rows.append(
                {
                    "type_label": label,
                    "biz_date": item["biz_date"],
                    "biz_type_label": item["biz_type_label"],
                    "partner": item["partner"] or "—",
                    "amount": money(item["amount"]),
                    "settled_amount": money(item["settled_amount"]),
                    "unsettled": money(item["unsettled"]),
                    "status": item["status"],
                }
            )

    # 排序（用户 2026-10-19 确认）：**先按单据日期升序，同一天再按未结金额降序**
    rows.sort(key=lambda r: (r["biz_date"], -r["unsettled"], r["partner"] or ""))

    receivable_left = sum(
        (r["unsettled"] for r in rows if r["type_label"] == ARAP_TYPE_LABELS[TYPE_RECEIVABLE]), ZERO
    )
    payable_left = sum(
        (r["unsettled"] for r in rows if r["type_label"] == ARAP_TYPE_LABELS[TYPE_PAYABLE]), ZERO
    )

    return {
        "type": "arap_unsettled",
        "title": "往来未结",
        "columns": [
            _col("type_label", "类型"),
            _col("biz_date", "单据日期", COL_DATE),
            _col("biz_type_label", "业务类型"),
            _col("partner", "对方"),
            _col("amount", "单据金额", COL_MONEY),
            _col("settled_amount", "已冲销", COL_MONEY),
            _col("unsettled", "未结", COL_MONEY),
            _col("status", "状态", COL_STATUS),
        ],
        "rows": rows,
        "summary": {
            "receivable_unsettled": money(receivable_left),
            "payable_unsettled": money(payable_left),
            "count": len(rows),
        },
        "empty_text": "该项目暂无未结清的应收应付单",
        "note": "未结 = 单据金额 − 已冲销额；只列状态不是「已结清」的单据",
    }


def _cost_budget(
    db: Session, project_id: int, start: date | None, end: date | None
) -> dict[str, Any]:
    """成本与预算：五类构成 + 占比 + 预算对比（口径来自 project_service.overview）。"""
    from . import project_service

    data = project_service.overview(db, project_id, start, end)
    by_type: dict[str, Decimal] = data["cost_by_type"]
    metrics = data["metrics"]
    actual = money(metrics["actual_cost"])
    budget = money(metrics["cost_budget"])

    rows = [
        {
            "type": ctype,
            "type_label": COST_TYPE_LABELS[ctype],
            "amount": money(by_type.get(ctype, ZERO)),
            "share": percent(by_type.get(ctype, ZERO), actual),
        }
        for ctype in COST_TYPES
    ]
    # 金额大的在前，零值沉底
    rows.sort(key=lambda r: (-r["amount"], r["type_label"]))

    over = actual > budget if budget > ZERO else False
    rows.append(
        {
            "type": "__total__",
            "type_label": "合计",
            "amount": actual,
            "share": Decimal("100.00") if actual > ZERO else ZERO,
        }
    )

    return {
        "type": "cost_budget",
        "title": "成本与预算",
        "columns": [
            _col("type_label", "成本类型"),
            _col("amount", "金额", COL_MONEY),
            _col("share", "占比", COL_PERCENT),
        ],
        "rows": rows,
        "summary": {
            "actual_cost": actual,
            "cost_budget": budget,
            "budget_left": money(metrics["budget_left"]),
            "budget_usage_rate": money(metrics["budget_usage_rate"]),
            "over_budget": over,
            "client_budget": money(metrics["client_budget"]),
            "settle_profit": money(metrics["settle_profit"]),
        },
        "empty_text": "该项目暂无成本记录",
        "note": "实际成本 = 五类成本之和；资金流水与应收应付不参与利润计算",
    }


_RUNNERS: dict[str, Callable[..., dict[str, Any]]] = {
    "labor_unsettled": _labor_unsettled,
    "arap_unsettled": _arap_unsettled,
    "cost_budget": _cost_budget,
}


# --------------------------------------------------------------------------- 入口


def run(
    db: Session,
    types: list[str],
    project_id: int | None = None,
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    """按勾选的查询类型逐个计算，返回 blocks 数组。

    - `types` 为空 → 400（不能返回空结果，否则用户会以为「一切正常」）
    - 去重并保持用户勾选顺序
    - 单个查询抛错不影响其他查询：该块返回 `error`，其余照常
    """
    if not types:
        raise BadRequest("请至少选择一项查询内容")

    ordered: list[str] = []
    for code in types:
        if code not in _RUNNERS:
            raise BadRequest(f"不支持的查询类型：{code}")
        if code not in ordered:
            ordered.append(code)

    blocks: list[dict[str, Any]] = []
    for code in ordered:
        needs_project = next(item["needs_project"] for item in QUERY_TYPES if item["code"] == code)
        if needs_project and project_id is None:
            raise BadRequest(f"「{QUERY_NAMES[code]}」需要指定项目")

        meta = next(item for item in QUERY_TYPES if item["code"] == code)
        try:
            block = _RUNNERS[code](db, int(project_id), start, end)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001 - 单块失败不拖垮整页
            block = {
                "type": code,
                "title": meta["name"],
                "columns": [],
                "rows": [],
                "summary": {},
                "empty_text": "",
                "error": str(getattr(exc, "message", None) or exc),
            }
        blocks.append(block)

    return {
        "blocks": blocks,
        "project_id": project_id,
        "range": {"start_date": dstr(start), "end_date": dstr(end)},
        "selected": ordered,
    }
