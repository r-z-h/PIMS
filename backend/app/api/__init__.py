"""路由层：只做参数校验与调用 service，不写业务判断。"""

from . import arap, auth, costs, dashboard, export, funds, inventory, labor, logs, projects, settings, system

__all__ = [
    "arap",
    "auth",
    "costs",
    "dashboard",
    "export",
    "funds",
    "inventory",
    "labor",
    "logs",
    "projects",
    "settings",
    "system",
]
