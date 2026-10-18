"""dict_item 数据字典。"""

from __future__ import annotations

from sqlalchemy import Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base

DICT_MISC_CATEGORY = "misc_category"
DICT_MATERIAL = "material"
DICT_UNIT = "unit"
DICT_PARTNER = "partner"
DICT_TYPES = (DICT_MISC_CATEGORY, DICT_MATERIAL, DICT_UNIT, DICT_PARTNER)
DICT_TYPE_LABELS = {
    DICT_MISC_CATEGORY: "杂费小类",
    DICT_MATERIAL: "材料",
    DICT_UNIT: "单位",
    DICT_PARTNER: "对方",
}

# 预置字典（docs/02-数据库设计.md 第 5 节）
DEFAULT_DICT_ITEMS: dict[str, list[str]] = {
    DICT_MISC_CATEGORY: ["伙食费", "转运费", "招待费", "罚款", "临时工", "其他"],
    DICT_UNIT: ["吨", "车", "方", "袋", "米", "根", "件", "个", "套", "桶"],
    DICT_MATERIAL: ["水泥", "砂子", "石子", "钢筋", "模板", "砖", "混凝土", "电缆"],
    DICT_PARTNER: [],
}


class DictItem(Base):
    __tablename__ = "dict_item"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dict_type: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sort_no: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    enabled: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
