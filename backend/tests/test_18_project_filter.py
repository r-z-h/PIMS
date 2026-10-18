"""项目列表的「名字 + 日期」筛选（2026-10-17 用户需求）。

需求原话：「我需要的是能够通过项目名字和日期对项目进行筛选」。

两种日期口径（下拉切换）：
- ``start_date``：只列**开工日期**落在区间内的项目
- ``activity``  ：只列该区间内**有业务数据**（成本/收付款/往来/入库/结算）的项目

首页盈亏总表用同一套口径。
"""

from __future__ import annotations

from helpers import ok_data


def _project(api, name: str, start_date: str | None = None) -> int:
    payload = {"name": name, "client_budget": "100000", "cost_budget": "80000"}
    if start_date:
        payload["start_date"] = start_date
    return ok_data(api.post("/api/projects", json=payload))["id"]


def _cost(api, project: int, biz_date: str, amount: str = "1000") -> None:
    ok_data(
        api.post(
            "/api/costs/misc",
            json={
                "project_id": project,
                "category": "伙食费",
                "amount": amount,
                "biz_date": biz_date,
            },
        )
    )


def _names(api, **params) -> list[str]:
    """列表里的项目名。

    注意：同一模块内多条用例共享同一个测试库，前面的用例会留下项目，
    所以断言时用 `_only(got, 前缀)` 只看本用例造的数据。
    """
    data = ok_data(api.get("/api/projects", params={"page": 1, "page_size": 100, **params}))
    return [item["name"] for item in data["items"]]


def _only(names: list[str], prefix: str) -> list[str]:
    return [n for n in names if n.startswith(prefix)]


def test_按名字筛选项目(api):
    """keyword 一直是好的（名称/甲方/负责人/地点/备注 模糊搜）——锁住它别退化。"""
    _project(api, "筛选-甲工程", "2026-03-01")
    _project(api, "筛选-乙工程", "2027-01-10")

    assert _only(_names(api, keyword="筛选-甲"), "筛选-") == ["筛选-甲工程"]
    assert _only(_names(api, keyword="筛选-乙"), "筛选-") == ["筛选-乙工程"]
    assert _only(_names(api, keyword="筛选-"), "筛选-") == ["筛选-乙工程", "筛选-甲工程"]  # 按 id 倒序
    assert _only(_names(api, keyword="不存在的名字"), "筛选-") == []


def test_日期筛选_按开工日期(api):
    _project(api, "开工-2020", "2020-08-07")
    _project(api, "开工-2026", "2026-03-15")
    _project(api, "开工-无")

    got = _only(_names(api, date_field="start_date", start_date="2020-01-01", end_date="2020-12-31"), "开工-")
    assert got == ["开工-2020"], got

    got = _only(_names(api, date_field="start_date", start_date="2026-01-01", end_date="2026-12-31"), "开工-")
    assert got == ["开工-2026"], got

    # 没填开工日期的项目不参与（无法判断在不在区间内）
    got = _only(_names(api, date_field="start_date", start_date="2019-01-01", end_date="2030-12-31"), "开工-")
    assert "开工-无" not in got


def test_日期筛选_按有业务数据(api):
    """只按业务数据筛时，区间外没账的项目不该出现。

    注意：**项目创建时间在区间内也算"有业务数据"**（2026-10-17 加的规则，
    避免新建项目在录第一笔前被筛没）。所以这里用**远期区间**做断言，
    把"创建时间"这个因素排除掉，只看业务数据。
    """
    p_has = _project(api, "活动-有账", "2020-01-01")
    _project(api, "活动-没账", "2020-06-01")  # 一条数据都没有
    _cost(api, p_has, "2030-03-03")  # 记在 2030 年

    got = _only(_names(api, date_field="activity", start_date="2030-01-01", end_date="2030-12-31"), "活动-")
    assert got == ["活动-有账"], got

    # 区间内谁都没数据 → 空列表（不能退化成"全都返回"）
    got = _only(_names(api, date_field="activity", start_date="2015-01-01", end_date="2015-12-31"), "活动-")
    assert got == [], got


def test_新建项目在有业务数据口径下也看得见(api):
    """刚建的项目一条数据都没有，但**创建时间在区间内**，应该看得见。

    这是实测发现的问题：不加这条规则，新建完项目它会立刻从列表里"消失"，
    用户会以为没建成。
    """
    new_id = _project(api, "活动-新建的", "2019-05-05")  # 开工日期特意放到区间外
    assert new_id

    # 不传日期：所有项目都在
    assert "活动-新建的" in _names(api)

    # 传今年（项目就是今年建的）→ 仍应看得见
    import datetime

    year = datetime.date.today().year
    got = _only(
        _names(api, date_field="activity", start_date=f"{year}-01-01", end_date=f"{year}-12-31"),
        "活动-",
    )
    assert "活动-新建的" in got, got

    # 而开工日期口径下它不该出现（开工 2019 不在今年）
    got = _only(
        _names(api, date_field="start_date", start_date=f"{year}-01-01", end_date=f"{year}-12-31"),
        "活动-",
    )
    assert "活动-新建的" not in got, got


def test_日期筛选_两种口径结果不同(api):
    """同一条数据下，两种口径应能筛出不同结果——证明它俩真的是两条逻辑。"""
    # 开工 2020，但成本记在 2026
    pid = _project(api, "口径对比-跨年", "2020-03-03")
    _cost(api, pid, "2026-06-06")

    by_start = _names(api, date_field="start_date", start_date="2020-01-01", end_date="2020-12-31")
    by_activity = _names(api, date_field="activity", start_date="2020-01-01", end_date="2020-12-31")
    assert "口径对比-跨年" in by_start, by_start
    assert "口径对比-跨年" not in by_activity, by_activity

    by_start_2026 = _names(api, date_field="start_date", start_date="2026-01-01", end_date="2026-12-31")
    by_activity_2026 = _names(api, date_field="activity", start_date="2026-01-01", end_date="2026-12-31")
    assert "口径对比-跨年" not in by_start_2026, by_start_2026
    assert "口径对比-跨年" in by_activity_2026, by_activity_2026


def test_名字与日期可以叠加(api):
    a = _project(api, "叠加-甲", "2020-05-05")
    _project(api, "叠加-乙", "2020-05-05")
    _cost(api, a, "2020-05-05")

    got = _names(api, keyword="叠加-甲", date_field="activity", start_date="2020-01-01", end_date="2020-12-31")
    assert got == ["叠加-甲"], got

    # 名字对但该区间没业务数据 → 空
    got = _names(api, keyword="叠加-甲", date_field="activity", start_date="2019-01-01", end_date="2019-12-31")
    assert got == [], got


def test_不传日期就不筛项目_老行为不变(api):
    """不传 date_field 时，日期参数**不影响**返回哪些项目（只有金额受区间影响）。"""
    _project(api, "兼容-老调用", "2020-01-01")
    got = _names(api, start_date="2015-01-01", end_date="2015-12-31")
    assert "兼容-老调用" in got, got


def test_首页盈亏总表用同一套筛选(api):
    p2020 = _project(api, "首页-2020有账", "2020-02-02")
    _project(api, "首页-2026有账", "2026-02-02")
    _cost(api, p2020, "2020-03-03")

    def table_names(**params):
        data = ok_data(api.get("/api/dashboard/projects", params=params))
        return [item["name"] for item in data["items"]]

    by_start = table_names(date_field="start_date", start_date="2020-01-01", end_date="2020-12-31")
    assert "首页-2020有账" in by_start
    assert "首页-2026有账" not in by_start

    by_activity = table_names(date_field="activity", start_date="2020-01-01", end_date="2020-12-31")
    assert "首页-2020有账" in by_activity
    assert "首页-2026有账" not in by_activity

    # 不传 date_field：所有项目都在（老行为）
    all_names = table_names(start_date="2020-01-01", end_date="2020-12-31")
    assert "首页-2026有账" in all_names


def test_日期筛选用错值会被拒绝(api):
    from helpers import err_data

    err_data(api.get("/api/projects", params={"date_field": "bogus", "start_date": "2026-01-01"}), 400)
