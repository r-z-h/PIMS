"""FastAPI 应用入口。

- 启动时执行 `app/db/schema.sql` 建表并写 `sys_setting` 初始值（幂等）
- `python -m app.main --seed` 可以在启动前写入种子数据（默认不写）
- 前端打包产物存在时自动静态托管（`frontend/dist`），SPA 走 index.html
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .api import arap, auth, costs, dashboard, export, funds, inventory, labor, logs, projects, query, settings, system
from .db import init_db
from .utils.response import EnvelopeJSONResponse, ok, register_exception_handlers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("pims.main")

FRONTEND_DIST = Path(config.BASE_DIR).parent / "frontend" / "dist"
SEED_FLAG = "--seed" in sys.argv


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """启动：建表 → 初始化 → 可选种子数据 → 每日自动备份。"""
    engine = init_db()
    logger.info("数据库就绪：%s", engine.url.database)

    from .services import system_service

    if config.settings.seed_on_startup or SEED_FLAG:
        from .db import session_scope
        from .seed import run_seed

        with session_scope() as session:
            result = run_seed(session)
        logger.info("种子数据：字典 +%s 条，示例项目 %s", result["dict_created"], result["project_created"])

    backup = system_service.auto_backup()
    if backup:
        logger.info("已自动备份：%s", backup["backup_path"])

    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title=config.settings.app_name,
        version=config.settings.app_version,
        description="工程一体化管理系统后端：单用户、单公司多项目、SQLite 本地存储。",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
        ],
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    @app.get("/api/health", tags=["system"], summary="健康检查")
    def health() -> EnvelopeJSONResponse:
        return ok(
            {
                "status": "ok",
                "app": config.settings.app_name,
                "version": config.settings.app_version,
                "schema_version": config.settings.schema_version,
            }
        )

    for router in (
        auth.router,
        settings.router,
        projects.router,
        funds.router,
        costs.router,
        arap.router,
        inventory.router,
        labor.router,
        dashboard.router,
        export.router,
        logs.router,
        query.router,
        system.router,
    ):
        app.include_router(router)

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    """前端打包产物存在时托管；不存在时只在根路径给一句提示。"""
    dist = Path(FRONTEND_DIST)
    index_file = dist / "index.html"
    if not index_file.is_file():
        @app.get("/", include_in_schema=False)
        def root() -> dict[str, Any]:
            return {
                "code": 0,
                "message": "ok",
                "data": {
                    "app": config.settings.app_name,
                    "docs": "/docs",
                    "openapi": "/openapi.json",
                    "hint": "前端尚未构建：frontend/dist 不存在，接口可用 /docs 调试",
                },
            }

        return

    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="接口不存在")
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and str(candidate).startswith(str(dist.resolve())):
            return FileResponse(candidate)
        return FileResponse(index_file)


app = create_app()


def main() -> int:
    import uvicorn

    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
