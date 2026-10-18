"""金额与数量的 Decimal 处理（docs/01-开发手册.md 1.3）。

铁律：**禁止 float 参与计算**。
- 金额：`NUMERIC(14,2)` → Python `Decimal`，统一 ROUND_HALF_UP 保留 2 位
- 数量：`NUMERIC(12,3)` / 工天 `NUMERIC(8,2)` → `Decimal`
- JSON 输出：金额以「数字」形式返回并保留两位（见 utils/response.py 的 Decimal 渲染）
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable

from sqlalchemy import Numeric
from sqlalchemy.types import TypeDecorator

CENT = Decimal("0.01")
MILLI = Decimal("0.001")
HUNDRED = Decimal("100")
ZERO = Decimal("0.00")


def to_decimal(value: Any, default: Decimal | None = None) -> Decimal:
    """把任意输入安全转成 Decimal（float 一律走 str，避免二进制误差）。"""
    if value is None or value == "":
        if default is None:
            raise ValueError("金额不能为空")
        return default
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):  # bool 是 int 的子类，单独拦掉
        raise ValueError("金额格式不正确")
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        text = value.strip().replace(",", "").replace("，", "")
        if text == "":
            if default is None:
                raise ValueError("金额不能为空")
            return default
        try:
            return Decimal(text)
        except InvalidOperation as exc:  # pragma: no cover - 提示语
            raise ValueError(f"金额格式不正确：{value}") from exc
    raise ValueError(f"金额格式不正确：{value!r}")


def money(value: Any, default: Decimal | None = None) -> Decimal:
    """金额：保留两位小数（四舍五入）。"""
    return to_decimal(value, default).quantize(CENT, rounding=ROUND_HALF_UP)


def qty(value: Any, default: Decimal | None = None) -> Decimal:
    """数量：保留三位小数（四舍五入）。"""
    return to_decimal(value, default).quantize(MILLI, rounding=ROUND_HALF_UP)


def qty2(value: Any, default: Decimal | None = None) -> Decimal:
    """工日数 / 台班数：保留两位小数。"""
    return to_decimal(value, default).quantize(CENT, rounding=ROUND_HALF_UP)


def mul_money(a: Any, b: Any) -> Decimal:
    """数量 × 单价 → 金额（先算后舍入，只在最后保留两位）。"""
    return money(to_decimal(a) * to_decimal(b))


def sum_money(values: Iterable[Any]) -> Decimal:
    """金额求和，结果保留两位。"""
    total = ZERO
    for item in values:
        if item is None:
            continue
        total += to_decimal(item)
    return money(total)


def money_str(value: Any) -> str:
    """固定两位小数的字符串（变更日志 / 导出用）。"""
    return f"{money(value):.2f}"


def qty_str(value: Any, digits: int = 3) -> str:
    return f"{qty(value):.{digits}f}"


def percent(part: Any, whole: Any) -> Decimal:
    """百分比（保留两位），分母为 0 时返回 0。"""
    whole_d = to_decimal(whole, ZERO)
    if whole_d == 0:
        return ZERO
    return (to_decimal(part, ZERO) / whole_d * HUNDRED).quantize(CENT, rounding=ROUND_HALF_UP)


class _DecimalType(TypeDecorator):
    """SQLite 上的精确十进制列。

    SQLite 没有原生 DECIMAL，SQLAlchemy 默认会走 float 并给出告警。
    这里显式接管绑定/取值过程：
    - 写库：先按位数四舍五入，再交给驱动（SQLite 按 NUMERIC 亲和性存储）
    - 读库：驱动返回的数值统一用 `Decimal(str(v))` 还原，绝不直接用二进制浮点参与运算
    `NUMERIC(14,2)` 最多 14 位有效数字，远小于 float64 的 15~17 位有效数字，
    因此「写→读」往返在两位小数口径下是精确的。
    """

    cache_ok = True
    impl = Numeric(14, 2, asdecimal=False)
    digits = 2

    def _quantize(self, value: Decimal) -> Decimal:
        return value.quantize(CENT if self.digits == 2 else MILLI, rounding=ROUND_HALF_UP)

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return self._quantize(to_decimal(value))

    def process_result_value(self, value: Any, dialect: Any) -> Decimal | None:
        if value is None:
            return None
        return self._quantize(to_decimal(value))


class Money(_DecimalType):
    """金额列 NUMERIC(14,2)。"""

    cache_ok = True
    impl = Numeric(14, 2, asdecimal=False)
    digits = 2


class Qty(_DecimalType):
    """数量列 NUMERIC(12,3)。"""

    cache_ok = True
    impl = Numeric(12, 3, asdecimal=False)
    digits = 3


class Qty2(_DecimalType):
    """工天数 / 台班数 NUMERIC(8,2)。"""

    cache_ok = True
    impl = Numeric(8, 2, asdecimal=False)
    digits = 2
