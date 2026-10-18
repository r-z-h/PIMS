# scripts/checks —— 一次性深度验证脚本

这些是**针对具体功能改动做过的一次性深度验证**，留着是为了以后改动后能复跑回归。
它们不是日常必跑的套件（日常套件见根 `README.md` 的「验证结果」表）。

| 脚本 | 验什么 | 前置 |
|---|---|---|
| `verify-packaged-newfeatures.mjs` | **打包态**（只起后端、静态托管 dist）下新功能逐条可用：菜单顺序、记账/收付款/成本三页、五类下拉录入、自动弹「登记已付」、应付单可查、登记已付 400 后未结 600 与付款流水 | 后端跑在 8000（`frontend/dist` 需已构建） |
| `verify-payable-browser.mjs` | **真后端 + 真浏览器**下成本↔应付单联动全链路（弹窗显示"已自动生成应付单"、登记已付、往来未结、付款流水、成本页汇总、成本页也能录） | 后端 8033 + 前端 dev 5173，且 `VITE_USE_MOCK=false` |
| `verify-payable-browser-delete.mjs` | 删除成本时「应付单保留」的 UI 提示与结果 | 同上 |
| `verify-payable-types.mjs` | 五类成本的应付单映射（类型/对方/关联）与「不填已付→全额挂账」、改额精度 | 后端 8033 |
| `verify-settle-link.mjs` | **结算接账全链路**（需求 T6/T7/T8）：人工费应付单显示「去结算」→ 跳结算页并定位到人 → 生成预览并保存结算单 → 登记发放 → 生成付款流水 + 冲销应付单 → 往来单据 `closed` → 成本未重复计入 | 后端 8033 + 前端 dev 5173，且 `VITE_USE_MOCK=false` |
| `verify-copy-fixes.mjs` | 页面文案修复（无裸露 Markdown 星号、成本页文案不再自相矛盾） | 后端 8000（打包态） |
| `render-html-to-png.mjs` | 把 HTML 渲染成 PNG（体系结构图就是用它生成的） | 无（headless Edge） |

## 跑真后端类脚本的**单会话坑**（踩过，务必注意）

后端是**单会话**的：谁最后登录，谁的 cookie 才有效。
如果脚本先调 `/api/auth/login` 拿会话、随后**浏览器又登录一次**，
浏览器会把脚本的会话顶掉 → 脚本后续所有接口调用返回 **401**（表现为"接口交叉核对全是 undefined"）。

`verify-settle-link.mjs` 的做法（可照抄）：

1. 脚本先用 API 把**数据准备好**（建项目、录成本、设密保）
2. **只让浏览器登录**（脚本此后不再调用 login）
3. 用 CDP 的 `Network.getCookies` 把浏览器的 `pims_session` 取过来给脚本用
   —— 注意会话 cookie 是 **HttpOnly**，`document.cookie` 读不到，必须走 CDP

## 跑法示例

```powershell
# 1) 起后端（务必用临时库，别碰 backend/data）
$env:PIMS_DB_PATH = "$env:TEMP\pims_check.db"
$env:PIMS_AUTO_BACKUP = '0'
backend\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8033 --app-dir backend

# 2a) 只连接口的脚本
node scripts\checks\verify-payable-types.mjs

# 2b) 需要真浏览器的脚本：另起前端 dev server（真后端模式）
Set-Content frontend\.env.development.local "VITE_USE_MOCK=false`nVITE_API_TARGET=http://127.0.0.1:8033"
cd frontend; npm run dev -- --port 5173
# 再开一个终端：
$env:PIMS_BASE='http://127.0.0.1:5173'; $env:PIMS_API='http://127.0.0.1:8033'
node scripts\checks\verify-settle-link.mjs

# 3) 必须清理
Remove-Item "$env:TEMP\pims_check.db*" -Force
Remove-Item frontend\.env.development.local -Force -ErrorAction SilentlyContinue
```

> 脚本里的端口/地址可用环境变量覆盖（`PIMS_API`、`PIMS_BASE`），换端口时不必改代码。
