"""PIMS 单机启动器：起后端 + 打开浏览器。

为什么用 Python 而不是全写在 .bat 里：
  批处理对换行符（必须 CRLF）、括号块、中文编码都很敏感，一旦出问题往往静默退出、
  连报错都看不到。把逻辑放在 Python 里就稳得多，.bat 只做一件事：转到这个脚本。

用法（一般由 start.bat 调用）：
    backend\\.venv\\Scripts\\python.exe scripts\\start_pims.py
可选环境变量：
    PIMS_PORT    后端端口，默认 8000
    PIMS_HOST    监听地址，默认 127.0.0.1
    PIMS_NO_OPEN 设为 1 则不自动打开浏览器
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DATA_DIR = BACKEND / "data"
DIST_INDEX = ROOT / "frontend" / "dist" / "index.html"

HOST = os.environ.get("PIMS_HOST", "127.0.0.1")
PORT = os.environ.get("PIMS_PORT", "8000")
BASE_URL = f"http://{HOST}:{PORT}/"


def say(msg: str = "") -> None:
    """Windows 控制台可能是 GBK，编不出的字符降级输出，不要让启动器自己崩掉。"""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        print(msg.encode(enc, errors="replace").decode(enc, errors="replace"), flush=True)


def wait_until_ready(timeout: float = 40.0) -> bool:
    """轮询首页，直到后端真的能响应（比死等固定秒数可靠）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE_URL, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    say("=" * 52)
    say("  PIMS - 工程企业项目成本管理系统")
    say("=" * 52)
    say()

    if not (BACKEND / "app" / "main.py").exists():
        say(f"[错误] 找不到后端代码：{BACKEND / 'app' / 'main.py'}")
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    python = sys.executable
    cmd = [
        python, "-m", "uvicorn", "app.main:app",
        "--host", HOST, "--port", str(PORT),
    ]

    say(f"[1/2] 启动后端 {BASE_URL} ...")
    say(f"      工作目录：{BACKEND}")
    say(f"      数据文件：{DATA_DIR / 'pims.db'}")
    if not DIST_INDEX.exists():
        say()
        say("[提示] frontend/dist 不存在，后端只能提供接口（/docs），网页界面打不开。")
        say("       需要先构建前端：cd frontend && npm install && npm run build")
    say()

    creation_flags = 0
    if os.name == "nt":
        # 让 uvicorn 与启动器共享控制台，Ctrl+C 能一起停；同时避免弹新窗口。
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP

    proc = subprocess.Popen(cmd, cwd=str(BACKEND), creationflags=creation_flags)

    if not wait_until_ready():
        if proc.poll() is not None:
            say(f"[错误] 后端启动失败（退出码 {proc.returncode}），上面的日志里有原因。")
        else:
            say("[错误] 等了 40 秒后端仍没就绪，请检查端口是否被占用：")
            say(f"        netstat -ano | findstr {PORT}")
        proc.terminate()
        return 1

    say(f"[2/2] 后端已就绪，打开浏览器 {BASE_URL}")
    if os.environ.get("PIMS_NO_OPEN") != "1":
        webbrowser.open(BASE_URL)

    say()
    say("  默认密码：123456（首次登录后必须设置 3 个密保问题）")
    say("  停止服务：在本窗口按 Ctrl+C，或直接关闭本窗口")
    say("  数据备份：backend\\data\\backup\\ 下每次启动自动留一份，保留最近 7 份")
    say()
    say("-" * 52)
    say("下面是后端日志（按 Ctrl+C 停止）：")
    say()

    try:
        proc.wait()
    except KeyboardInterrupt:
        say()
        say("正在停止后端 ...")
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        say("已停止。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
