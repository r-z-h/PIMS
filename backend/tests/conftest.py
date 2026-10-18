"""pytest 公共夹具。

每个测试模块使用**独立的临时数据库**（tmp_path_factory + 重新配置引擎），
互不干扰；`PIMS_AUTO_BACKUP=0` 关闭启动自动备份。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ["PIMS_AUTO_BACKUP"] = "0"
os.environ.pop("PIMS_SEED", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

DEFAULT_PASSWORD = "123456"


@pytest.fixture(scope="module")
def db_file(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """模块级临时数据库，并把全局引擎指过去。"""
    path = tmp_path_factory.mktemp("pims-data") / "pims.db"
    os.environ["PIMS_DB_PATH"] = str(path)

    from app import config, db as database

    config.reload_settings()
    database.configure_engine(path)
    database.init_db()
    return path


@pytest.fixture(scope="module")
def client(db_file: Path) -> TestClient:
    """模块级测试客户端（会触发 lifespan：建表 + 初始化）。"""
    from app.main import create_app

    app = create_app()
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def api(client: TestClient) -> TestClient:
    """已登录的客户端（默认密码 123456）；同一模块内共享，便于连续业务流水。"""
    if not client.cookies.get("pims_session"):
        response = client.post("/api/auth/login", json={"password": DEFAULT_PASSWORD})
        assert response.status_code == 200, response.text
        assert response.json()["code"] == 0, response.text
    return client


@pytest.fixture(scope="module")
def dbsession(db_file: Path):
    """直连数据库的会话（用于断言落库结果）。"""
    from app.db import get_session_factory

    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(scope="module")
def project(api: TestClient) -> int:
    """建一个标准项目：甲方预算 400 万 / 成本预算 350 万（模块内共享）。"""
    from helpers import ok_data

    data = ok_data(
        api.post(
            "/api/projects",
            json={"name": f"测试项目-{os.urandom(3).hex()}", "client_budget": 4000000, "cost_budget": 3500000},
        )
    )
    return int(data["id"])


@pytest.fixture()
def secured_client(api: TestClient) -> TestClient:
    """已设置密保的客户端（密保问答固定为测试答案）。"""
    from helpers import ok_data

    status = ok_data(api.get("/api/auth/status"))
    if not status["security_ready"]:
        ok_data(
            api.post(
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
    return api
