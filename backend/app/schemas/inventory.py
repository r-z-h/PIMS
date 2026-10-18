"""库存出入参。"""

from __future__ import annotations

from datetime import date

from pydantic import Field

from .common import InModel, MoneyAmount, PatchModel, Quantity


class InventoryInCreate(InModel):
    """手工补录入库：不生成成本（常规采购走 /api/costs/material）。"""

    project_id: int = Field(gt=0)
    material_name: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    quantity: Quantity = Field(gt=0)
    unit_price: MoneyAmount | None = Field(default=None, ge=0)
    supplier: str | None = Field(default=None, max_length=100)
    biz_date: date
    remark: str | None = None


class InventoryOutCreate(InModel):
    """领用：只减库存，不生成成本；余量不足返回 enough=false。"""

    project_id: int = Field(gt=0)
    material_name: str = Field(min_length=1, max_length=100)
    unit: str = Field(min_length=1, max_length=20)
    quantity: Quantity = Field(gt=0)
    biz_date: date
    remark: str | None = None


class InventoryTxnUpdate(PatchModel):
    material_name: str | None = Field(default=None, min_length=1, max_length=100)
    unit: str | None = Field(default=None, min_length=1, max_length=20)
    quantity: Quantity | None = Field(default=None, gt=0)
    unit_price: MoneyAmount | None = Field(default=None, ge=0)
    supplier: str | None = Field(default=None, max_length=100)
    biz_date: date | None = None
    remark: str | None = None
