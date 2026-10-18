"""认证：登录 / 密保 / 改密 / 重置 / 防猜锁定（FR-1）。"""

from __future__ import annotations

from helpers import SECURITY_ANSWERS, err_data, ok_data


def test_status_初始状态(client):
    data = ok_data(client.get("/api/auth/status"))
    assert data["logged_in"] is False
    assert data["security_ready"] is False
    assert data["is_initial_password"] is True
    assert data["schema_version"] == 1

    # 未登录不能访问受保护接口
    err_data(client.get("/api/funds"), 401)
    err_data(client.get("/api/dashboard/projects"), 401)
    err_data(client.post("/api/auth/logout"), 401)


def test_密保未设置时的提示(client):
    err_data(client.get("/api/auth/security-questions"), 404)
    err_data(client.post("/api/auth/security/verify", json={"answers": SECURITY_ANSWERS}), 404)


def test_密码错误返回400(client):
    payload = err_data(client.post("/api/auth/login", json={"password": "wrong-password"}), 400)
    assert payload["message"] == "密码不正确"


def test_登录成功下发HttpOnly_Cookie(client):
    response = client.post("/api/auth/login", json={"password": "123456"})
    data = ok_data(response)
    assert data["logged_in"] is True
    assert data["expires_in"] == 7 * 24 * 3600
    assert "session_token" not in data  # 只在 HttpOnly Cookie 里
    set_cookie = response.headers["set-cookie"]
    assert "pims_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "Path=/" in set_cookie

    info = ok_data(client.get("/api/auth/status"))
    assert info["logged_in"] is True


def test_status的logged_in只看本请求Cookie(db_file, api):
    """回归：`logged_in` 必须是「本请求携带的 Cookie 有效」，而不是「服务端存在会话」。

    历史上 `status()` 只判断服务端有没有 session_token，导致「服务端有会话、本浏览器无 Cookie」
    时前端被告知已登录 → 渲染业务页 → 拿到 401 → 跳登录 → 又跳回首页，形成死循环
    （真实联调中出现过 18 圈、54 条错误提示）。
    """
    from app.main import create_app
    from fastapi.testclient import TestClient

    # api 已登录：服务端此时确实存在有效会话
    assert ok_data(api.get("/api/auth/status"))["logged_in"] is True

    # 模拟另一个浏览器：没有 Cookie
    with TestClient(create_app(), raise_server_exceptions=False) as fresh:
        assert ok_data(fresh.get("/api/auth/status"))["logged_in"] is False

    # 带了错误的 Cookie 也算未登录
    client = TestClient(create_app(), raise_server_exceptions=False)
    try:
        client.cookies.set("pims_session", "not-a-valid-token")
        assert ok_data(client.get("/api/auth/status"))["logged_in"] is False
    finally:
        client.close()


def test_设置密保必须三题且问题不重复(client):
    # 只有 1 组问题 → 400
    err_data(
        client.post("/api/auth/security/setup", json={"questions": [{"question": "只有一个？", "answer": "x"}]}),
        400,
    )
    # 3 组问题但重复 → 400
    err_data(
        client.post(
            "/api/auth/security/setup",
            json={"questions": [{"question": "同一个问题？", "answer": "a"}] * 3},
        ),
        400,
    )

    ok_data(
        client.post(
            "/api/auth/security/setup",
            json={
                "questions": [
                    {"question": "我第一辆车的车牌号？", "answer": "鄂A12345"},
                    {"question": "我母亲的姓名？", "answer": "李秀兰"},
                    {"question": "我小学的名字？", "answer": "实验小学"},
                ]
            },
        )
    )
    status = ok_data(client.get("/api/auth/status"))
    assert status["security_ready"] is True


def test_密保答案大小写与空格不敏感(client):
    ticket = ok_data(
        client.post(
            "/api/auth/security/verify",
            json={"answers": [" 鄂a12345 ", "李秀兰", "实验小学 "]},
        )
    )
    assert ticket["ticket"].startswith("rst_")


def test_密保未全对不能重置密码(client):
    ok_data(client.post("/api/auth/security/verify", json={"answers": SECURITY_ANSWERS}))
    err_data(
        client.post(
            "/api/auth/password/reset",
            json={"ticket": "rst_invalid-ticket-value", "new_password": "abcdefg"},
        ),
        403,
    )


def test_密保全对可以重置密码(client):
    ticket = ok_data(client.post("/api/auth/security/verify", json={"answers": SECURITY_ANSWERS}))["ticket"]
    ok_data(client.post("/api/auth/password/reset", json={"ticket": ticket, "new_password": "newpass888"}))
    # 旧票不能复用
    err_data(
        client.post("/api/auth/password/reset", json={"ticket": ticket, "new_password": "another123"}),
        403,
    )
    # 新密码可登录，旧密码不行
    err_data(client.post("/api/auth/login", json={"password": "123456"}), 400)
    data = ok_data(client.post("/api/auth/login", json={"password": "newpass888"}))
    assert data["is_initial_password"] is False
    assert data["security_ready"] is True


def test_改密码只认密保全对且不校验旧密码(client):
    ok_data(client.post("/api/auth/login", json={"password": "newpass888"}))

    # 不给密保答案 → 400
    err_data(client.post("/api/auth/password/change", json={"new_password": "zzz12345"}), 400)
    # 密保答错 → 403 且不透露哪题错
    payload = err_data(
        client.post(
            "/api/auth/password/change",
            json={"new_password": "zzz12345", "answers": ["错", "李秀兰", "实验小学"]},
        ),
        403,
    )
    assert payload["message"] == "密保答案不正确"
    # 密保全对 → 成功（即使旧密码字段是错的也不校验，FR-1.3 无其他后门）
    ok_data(
        client.post(
            "/api/auth/password/change",
            json={
                "new_password": "temp12345",
                "answers": SECURITY_ANSWERS,
                "old_password": "完全不认识的老密码",
            },
        )
    )
    err_data(client.post("/api/auth/login", json={"password": "newpass888"}), 400)
    ok_data(client.post("/api/auth/login", json={"password": "temp12345"}))

    # ticket 等价路径：verify 拿到票据后可以直接改密
    ticket = ok_data(client.post("/api/auth/security/verify", json={"answers": SECURITY_ANSWERS}))["ticket"]
    ok_data(client.post("/api/auth/password/change", json={"new_password": "final12345", "ticket": ticket}))
    # 票据一次性
    err_data(
        client.post("/api/auth/password/change", json={"new_password": "another123", "ticket": ticket}),
        403,
    )
    err_data(client.post("/api/auth/login", json={"password": "temp12345"}), 400)
    ok_data(client.post("/api/auth/login", json={"password": "final12345"}))


def test_退出登录后会话失效(client):
    ok_data(client.post("/api/auth/login", json={"password": "final12345"}))
    ok_data(client.get("/api/projects"))
    ok_data(client.post("/api/auth/logout"))
    err_data(client.get("/api/projects"), 401)


def test_密码错误5次锁定1分钟(client, dbsession):
    from app.models.sys_setting import KEY_LOGIN_FAIL_COUNT, KEY_LOGIN_LOCKED_UNTIL
    from app.services import setting_service as store

    for _ in range(5):
        err_data(client.post("/api/auth/login", json={"password": "bad"}), 400)

    payload = err_data(client.post("/api/auth/login", json={"password": "final12345"}), 400)
    assert "密码错误次数过多" in payload["message"]

    # 解锁（测试中不等 60 秒），确认计数器会清零
    store.remove(dbsession, KEY_LOGIN_LOCKED_UNTIL)
    store.set_value(dbsession, KEY_LOGIN_FAIL_COUNT, 0)
    dbsession.commit()
    ok_data(client.post("/api/auth/login", json={"password": "final12345"}))


def test_改密记录写入password_reset_log(client, dbsession):
    from sqlalchemy import select

    from app.models.password_reset_log import PasswordResetLog

    actions = [
        (row.action, row.result)
        for row in dbsession.execute(select(PasswordResetLog).order_by(PasswordResetLog.id.asc()))
        .scalars()
        .all()
    ]
    assert ("change", "success") in actions
    assert ("change", "fail") in actions
    assert ("reset_by_security", "success") in actions
    assert ("reset_by_security", "fail") in actions
