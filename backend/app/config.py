"""全局配置。

约定（docs/01-开发手册.md 1.2）：
- 数据库文件 `backend/data/pims.db`
- Cookie 名 `pims_session`，会话有效期 7 天
- 密保校验通过后的临时票据 5 分钟有效

所有配置都可以用环境变量覆盖，测试用 `PIMS_DB_PATH` 指向临时库。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# backend/ 目录（app/ 的上一级）
BASE_DIR = Path(__file__).resolve().parent.parent


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    """运行期配置（可在测试里通过 load_settings() 重建）。"""

    app_name: str = "PIMS 工程一体化管理系统"
    app_version: str = "1.0.0"

    # 数据目录与数据库文件
    data_dir: Path = field(default_factory=lambda: Path(_env_str("PIMS_DATA_DIR", str(BASE_DIR / "data"))))
    db_filename: str = "pims.db"

    # 会话
    cookie_name: str = field(default_factory=lambda: _env_str("PIMS_COOKIE_NAME", "pims_session"))
    cookie_secure: bool = field(default_factory=lambda: _env_bool("PIMS_COOKIE_SECURE", False))
    session_days: int = field(default_factory=lambda: _env_int("PIMS_SESSION_DAYS", 7))

    # 密保票据有效期（秒）
    ticket_ttl_seconds: int = field(default_factory=lambda: _env_int("PIMS_TICKET_TTL", 300))

    # 登录防猜
    login_max_fail: int = field(default_factory=lambda: _env_int("PIMS_LOGIN_MAX_FAIL", 5))
    login_lock_seconds: int = field(default_factory=lambda: _env_int("PIMS_LOGIN_LOCK_SECONDS", 60))

    # 分页
    page_size_default: int = 20
    page_size_max: int = 200

    # 启动自动备份
    auto_backup: bool = field(default_factory=lambda: _env_bool("PIMS_AUTO_BACKUP", True))
    backup_keep: int = field(default_factory=lambda: _env_int("PIMS_BACKUP_KEEP", 7))

    # 数据库结构版本
    schema_version: int = 1

    @property
    def db_path(self) -> Path:
        """数据库文件绝对路径（可用 PIMS_DB_PATH 覆盖）。"""
        override = os.environ.get("PIMS_DB_PATH")
        if override:
            return Path(override)
        return Path(self.data_dir) / self.db_filename

    @property
    def backup_dir(self) -> Path:
        return self.db_path.parent / "backup"

    @property
    def schema_sql_path(self) -> Path:
        return Path(__file__).resolve().parent / "db" / "schema.sql"

    @property
    def seed_on_startup(self) -> bool:
        return _env_bool("PIMS_SEED", False)


def load_settings() -> Settings:
    """按当前环境变量重建配置。"""
    return Settings()


settings = load_settings()


def reload_settings() -> Settings:
    """重新读取环境变量（测试切换数据库时使用）。"""
    global settings
    settings = load_settings()
    return settings
