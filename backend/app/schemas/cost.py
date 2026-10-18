"""五类成本出入参（docs/03-接口设计.md 第 7 节）。"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from .common import InModel, MachineMeasure, MoneyAmount, PatchModel, Quantity, Quantity2


class LaborCostCreate(InModel):
    """录工天：实时计入成本。"""

    project_id: int = Field(gt=0)
    worker_name: str = Field(min_length=1, max_length=50)
    biz_date: date
    work_days: Quantity2 = Field(gt=0)
    day_rate: MoneyAmount = Field(gt=0)
    amount: MoneyAmount | None = Field(default=None, gt=0)  # 可省略 = 工日 × 工价
    remark: str | None = None


class MaterialCostCreate(InModel):
    """录材料采购：同时写库存入库。"""

    project_id: int = Field(gt=0)
    material_name: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    quantity: Quantity = Field(gt=0)
    unit_price: MoneyAmount = Field(ge=0)
    amount: MoneyAmount | None = Field(default=None, gt=0)
    supplier: str | None = Field(default=None, max_length=100)
    biz_date: date
    remark: str | None = None


class MachineCostCreate(InModel):
    """录机械费。"""

    project_id: int = Field(gt=0)
    machine_name: str = Field(min_length=1, max_length=100)
    measure: MachineMeasure
    quantity: Quantity2 = Field(gt=0)
    unit_price: MoneyAmount = Field(ge=0)
    amount: MoneyAmount | None = Field(default=None, gt=0)
    lessor: str | None = Field(default=None, max_length=100)
    biz_date: date
    remark: str | None = None


class MiscCostCreate(InModel):
    """录杂费（小类取字典，可自定义）。"""

    project_id: int = Field(gt=0)
    category: str = Field(min_length=1, max_length=50)
    amount: MoneyAmount = Field(gt=0)
    biz_date: date
    remark: str | None = None


class AdvanceCostCreate(InModel):
    """录垫付。"""

    project_id: int = Field(gt=0)
    payer: str | None = Field(default="老板", max_length=50)
    purpose: str | None = Field(default=None, max_length=200)
    amount: MoneyAmount = Field(gt=0)
    biz_date: date
    remark: str | None = None


class CostUpdate(PatchModel):
    """改成本：只改显式传入的字段，服务端按 type 同步明细表。"""

    amount: MoneyAmount | None = Field(default=None, gt=0)
    biz_date: date | None = None
    remark: str | None = None
    category: str | None = Field(default=None, max_length=50)

    # labor
    worker_name: str | None = Field(default=None, min_length=1, max_length=50)
    work_days: Quantity2 | None = Field(default=None, gt=0)
    day_rate: MoneyAmount | None = Field(default=None, gt=0)

    # material
    material_name: str | None = Field(default=None, min_length=1, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    quantity: Quantity | None = Field(default=None, gt=0)
    unit_price: MoneyAmount | None = Field(default=None, ge=0)
    supplier: str | None = Field(default=None, max_length=100)

    # machine
    machine_name: str | None = Field(default=None, min_length=1, max_length=100)
    measure: MachineMeasure | None = None
    lessor: str | None = Field(default=None, max_length=100)

    # advance
    payer: str | None = Field(default=None, max_length=50)
    purpose: str | None = Field(default=None, max_length=200)


class CostPaymentIn(InModel):
    """录成本后的「登记已付」：四个字段**全部选填**。

    - 不传 `paid_amount`（或传 0）→ 什么都不做，应付单全额挂账
    - 传了正数 → 生成一笔付款流水并自动冲销该成本对应的应付单
    - `pay_method` / `pay_date` / `remark` 只影响生成的付款流水，可后补
    """

    paid_amount: MoneyAmount | None = Field(default=None, ge=0)
    pay_method: str | None = Field(default=None, max_length=20)
    pay_date: date | None = None
    remark: str | None = Field(default=None, max_length=200)
