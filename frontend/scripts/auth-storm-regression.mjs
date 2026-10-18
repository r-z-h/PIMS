/**
 * 会话/401 收敛回归测试（真后端模式，不需要 mock）。
 *
 * 背景与历史故障：后端 `/api/auth/status` 的 logged_in 曾经只表示「服务端存在会话」（不校验请求 Cookie），
 * 而业务接口按 Cookie 校验。于是「服务端有会话、本浏览器 Cookie 无效/缺失」时，前端若只信 status 就会：
 *   渲染受保护页面 → 一串 401 → 弹回 /login → 登录页又信 status → 跳回首页 → 死循环
 *   （真实联调实测 18 圈、54 条红条，把登录按钮盖住）。
 * 后端已修正 status 语义（auth_service.status 用 session_valid 校验请求 Cookie，并有回归用例）；
 * 前端保留两道防线：401 闩锁（只弹一次、只跳一次）与 sessionExpired（停止渲染受保护子树）。
 *
 * 断言：
 *   A. 全新浏览器 + 服务端已有会话 → 打开 /：0 个 /api 4xx（也不发业务请求）、toast ≤1、停在登录页且按钮可点
 *   B. 正常登录（首页正常）→ 服务端换新会话让本机 Cookie 失效 → **不刷新页面**、用站内菜单触发取数：
 *      只允许一轮 401、toast ≤1、回到登录页并给出「上次登录已失效」，随后 1.5 秒起完全静默（不重试、不死循环）
 *   C. 清掉浏览器 Cookie 后再刷新 /：0 个 /api 4xx
 *   D. 重新登录：首页正常渲染（闩锁不会把人永久挡在外面）
 *
 * 前置：后端 8000（可用临时库）、前端 5173（VITE_USE_MOCK=false）
 * 用法：node scripts/auth-storm-regression.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
/** 默认打 5173/8000；可用 PIMS_BASE / PIMS_API 指向别的实例（多人并行联调时避免串台） */
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const API = process.env.PIMS_API || 'http://127.0.0.1:8000';
const PORT = Number(process.env.PIMS_CDP_PORT || 9225);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

/* ------------------------------ 后端直连助手 ------------------------------ */
async function apiLogin() {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '123456' }),
  });
  const body = await r.json();
  // Node 侧自己保存 Cookie：后端 /api/auth/status 的 logged_in 只看请求 Cookie，
  // 不带 Cookie 的请求会被正确判定为未登录（这正是为了修掉登录页死循环）。
  const setCookie = r.headers.getSetCookie?.() ?? [];
  setCookie.forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) sessionCookie = pair;
  });
  return body;
}

/** 预置 3 组密保：否则「首次登录」会落到 /security-setup（FR-1.2 的预期行为） */
async function apiSetupSecurity() {
  const r = await fetch(`${API}/api/auth/security/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    body: JSON.stringify({
      questions: [
        { question: '回归问题1', answer: '回归答案1' },
        { question: '回归问题2', answer: '回归答案2' },
        { question: '回归问题3', answer: '回归答案3' },
      ],
    }),
  });
  return r.json();
}

/** 当前系统状态（带 Cookie 查询） */
async function apiStatus() {
  const r = await fetch(`${API}/api/auth/status`, {
    headers: sessionCookie ? { Cookie: sessionCookie } : {},
  });
  return r.json();
}

/* ------------------------------ CDP ------------------------------ */
const HELPERS = `
window.__T = {
  norm: (s) => (s || '').replace(/\\s+/g, ''),
  path: () => location.pathname,
  has: (t) => window.__T.norm(document.body.innerText).includes(window.__T.norm(t)),
  toastCount: () => document.querySelectorAll('.ant-message-notice').length,
  setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  itemByLabel(label) {
    return [...document.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
  },
  fill(label, value) {
    const item = window.__T.itemByLabel(label);
    if (!item) throw new Error('form item not found: ' + label);
    return window.__T.setInput(item.querySelector('input, textarea'), value);
  },
  clickText(text, selector) {
    const nodes = [...document.querySelectorAll(selector || 'button, a, .ant-tabs-tab')];
    const target = window.__T.norm(text);
    const el = nodes.find((n) => window.__T.norm(n.innerText).includes(target));
    if (!el) throw new Error('clickable not found: ' + text);
    el.click();
    return true;
  },
  loginButtonClickable() {
    const b = [...document.querySelectorAll('button')].find((x) => window.__T.norm(x.innerText).includes('登录'));
    if (!b) return 'no-login-button';
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return (top === b || b.contains(top)) ? 'clickable' : 'covered-by:' + (top?.className || 'unknown');
  },
  sessionHint() {
    return window.localStorage.getItem('pims.session_hint');
  },
};
true;
`;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      this.handlers.slice().forEach((h) => h(msg));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(1500);
    await this.eval(HELPERS);
  }
}

async function pickTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 等 Edge 起来 */
    }
    await sleep(400);
  }
  throw new Error('找不到 Edge 调试目标');
}

async function waitFor(cdp, expression, desc, timeout = 15000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await cdp.eval(expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${desc}（${JSON.stringify(last)}）`);
}

let edge;
let cdp;
let sessionCookie = '';
const events = [];
const t0 = Date.now();

const apiHits = (from = 0) => events.slice(from).filter((e) => e.kind === 'api');
const failedApi = (from = 0) => apiHits(from).filter((e) => e.status >= 400 && e.url.startsWith('/api/'));
/** 真正的业务接口调用（排除 Vite 提供的 /src/api/*.ts 模块） */
const businessHits = (from = 0) =>
  apiHits(from).filter(
    (e) => e.url.startsWith('/api/') && /^\/api\/(projects|dashboard|costs|funds|arap|inventory|labor|dict|logs|export)/.test(e.url),
  );

try {
  /* ---------- 准备：让服务端先存在一个会话（浏览器还没有 Cookie） ----------
   * 注意：/api/auth/status 的 logged_in 只反映「请求携带的 Cookie」，
   * 所以 Node 侧必须自己保存 Cookie，否则这个前置条件不成立。
   */
  const pre = await apiLogin();
  check('后端存活（用于制造"服务端有会话"的条件）', pre.code === 0, JSON.stringify(pre).slice(0, 100));
  check('前置：带 Cookie 查询 status 显示已登录', (await apiStatus()).data?.logged_in === true);
  // 先设置密保：否则浏览器首次登录会按 FR-1.2 落到 /security-setup，而不是首页
  const sec = await apiSetupSecurity();
  check('前置：已设置 3 组密保（避免首次登录落到密保页）', sec.code === 0, JSON.stringify(sec).slice(0, 100));

  const profile = mkdtempSync(join(tmpdir(), 'pims-storm-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1680,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const target = await pickTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)));
  });
  cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.handlers.push((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const { url, status } = msg.params.response;
      if (url.includes('/api/') || url.includes('/src/api/')) {
        events.push({ kind: 'api', at: Date.now() - t0, url: url.replace(BASE, ''), status });
      }
    }
  });

  /* ================= A. 全新浏览器 + 服务端已有会话 ================= */
  const aStart = events.length;
  await cdp.goto(BASE + '/');
  await sleep(2500);
  const aPath = await cdp.eval(`window.__T.path()`);
  const aToasts = await cdp.eval(`window.__T.toastCount()`);
  const aBtn = await cdp.eval(`window.__T.loginButtonClickable()`);
  const aFail = failedApi(aStart);
  const aBiz = businessHits(aStart);
  check('A. 场景成立：服务端有会话而浏览器无 Cookie', pre.data?.logged_in === true);
  check('A. 未登录访问 / 落到登录页', aPath === '/login', `path=${aPath}`);
  check('A. /api 4xx 失败请求 = 0', aFail.length === 0, aFail.map((e) => `${e.status} ${e.url}`).join(' ; ') || '无');
  check('A. 完全没有发出业务请求（projects/dashboard/...）', aBiz.length === 0,
    aBiz.map((e) => e.url.replace(/\?.*/, '')).join(' ; ') || '无');
  check('A. 登录页 toast ≤ 1', aToasts <= 1, `toast=${aToasts}`);
  check('A. 登录按钮可点击（未被红条遮住）', aBtn === 'clickable', aBtn);

  /* ================= B. 先正常登录，再让本机 Cookie 失效 ================= */
  await cdp.eval(`window.__T.fill('登录密码', '123456')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  try {
    await waitFor(cdp, `window.__T.path() === '/' && window.__T.has('项目盈亏总表')`, '正常登录进入首页', 20000);
    check('B. 正常登录 → 首页盈亏总表渲染（未破坏主流程）', true);
  } catch (e) {
    const where = await cdp.eval(`JSON.stringify({ path: location.pathname, text: document.body.innerText.slice(0, 80) })`);
    check('B. 正常登录 → 首页盈亏总表渲染（未破坏主流程）', false, `${e.message} 当前=${where}`);
    throw e;
  }
  check('B. 本机登录痕迹已写入', (await cdp.eval(`window.__T.sessionHint()`)) === '1');

  /* 让浏览器手里的 Cookie 真正失效：Node 侧再登录一次，单用户会话 token 被覆盖。
   * 注意只清 localStorage 不够 —— 浏览器本地还留着旧登录态就不会重新问服务端；
   * 这里同时清掉浏览器登录痕迹，模拟「拿着过期 Cookie 的请求」。 */
  const beforeReLogin = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/status', { credentials: 'include' });
    const j = await r.json();
    return { logged_in: j.data?.logged_in, status: r.status };
  })()`);
  console.log(`   [诊断] Node 再登录前，浏览器带 Cookie 问 status：${JSON.stringify(beforeReLogin)}`);

  await apiLogin();
  await sleep(300);

  const afterReLogin = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/status', { credentials: 'include' });
    const j = await r.json();
    return { logged_in: j.data?.logged_in, status: r.status };
  })()`);
  console.log(`   [诊断] Node 再登录后，浏览器带 Cookie 问 status：${JSON.stringify(afterReLogin)}`);
  check('B. 过期 Cookie 被 status 正确判定为未登录（后端语义修复生效）',
    afterReLogin.logged_in === false && afterReLogin.status === 200, JSON.stringify(afterReLogin));

  await cdp.eval(`window.localStorage.clear(); true`);
  await sleep(300);

  const bStart = events.length;
  await cdp.goto(BASE + '/');
  await sleep(2500);
  const bPath = await cdp.eval(`location.pathname`);
  console.log(`   [诊断] 进入 / 之后：path=${bPath}，期间 /api 请求=` +
    `${JSON.stringify(apiHits(bStart).filter((e) => e.url.startsWith('/api/')).map((e) => `${e.status} ${e.url.replace(/\?.*/, '')}`))}`);
  await waitFor(cdp, `window.__T.path() === '/login'`, '回到登录页', 20000);
  const settleAt = Date.now() - t0;
  await sleep(3000); // 静默观察期：不该再有任何重试
  const bFail = failedApi(bStart);
  const bToasts = await cdp.eval(`window.__T.toastCount()`);
  const bAfterSettle = apiHits(bStart).filter((e) => e.at > settleAt + 1500);

  /* 期望已经变化（这是好事）：守卫靠 status 就识别出会话失效，
   * 因此不需要靠一串 401 才发现 —— 失败请求应当为 0。
   * （401 闩锁仍然保留，作为会话在使用中失效时的兜底，见 client.ts；它无法在这里稳定复现，
   *   因为 status 会先把状态摆正。） */
  check('B. 会话失效被识别且失败请求 = 0（无需靠 401 风暴）', bFail.length === 0,
    bFail.map((e) => `${e.status} ${e.url}`).join(' ; ') || '无');
  check('B. 不重复请求（跳回登录页后 1.5 秒起没有任何 /api 请求）',
    bAfterSettle.length === 0, bAfterSettle.map((e) => e.url).join(' ; ') || '无');
  check('B. 登录页 toast ≤ 1（不刷屏）', bToasts <= 1, `toast=${bToasts}`);
  check('B. 登录按钮仍可点击', (await cdp.eval(`window.__T.loginButtonClickable()`)) === 'clickable');

  /* ================= C. 清 Cookie 后再刷新：0 业务请求 ================= */
  await cdp.send('Network.clearBrowserCookies');
  const cStart = events.length;
  await cdp.goto(BASE + '/');
  await sleep(2500);
  const cFail = failedApi(cStart);
  check('C. 清除 Cookie 后刷新 /：/api 4xx = 0', cFail.length === 0,
    cFail.map((e) => `${e.status} ${e.url}`).join(' ; ') || '无');
  check('C. 落在登录页', (await cdp.eval(`window.__T.path()`)) === '/login');

  /* ========== B2. 会话在页面「使用中」失效：401 闩锁的兜底路径 ==========
   * B 覆盖的是「刷新页面 → status 直接说未登录」，因此不会产生 401。
   * 但 status 摆不正的情况是真实存在的：页面已经渲染好、Cookie 在手里失效（别处登录/7 天到期），
   * 此时任何一次站内取数都会 401 —— 这条路径只能靠 401 闩锁兜住，必须单独测。 */
  await cdp.eval(`window.__T.fill('登录密码', '123456')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/' && window.__T.has('项目盈亏总表')`, 'B2 重新登录进入首页', 20000);
  check('B2. 重新登录成功（C 之后仍可正常进入首页）', true);

  await apiLogin(); // 服务端换 token，浏览器手里的 Cookie 在使用中失效
  await sleep(300);

  const b2Start = events.length;
  await cdp.eval(`window.__T.clickText('项目', '.ant-menu-item')`); // 站内跳转，不刷新页面
  await waitFor(cdp, `window.__T.path() === '/login'`, 'B2 使用中失效后回到登录页', 20000);
  const b2SettleAt = Date.now() - t0;
  await sleep(3000);
  const b2Fail = failedApi(b2Start);
  const b2AfterSettle = apiHits(b2Start).filter((e) => e.at > b2SettleAt + 1500);
  const b2Toasts = await cdp.eval(`window.__T.toastCount()`);
  check('B2. 使用中失效会被服务端 401 拒绝（闩锁路径生效）', b2Fail.length > 0, `${b2Fail.length} 个 401`);
  check('B2. 401 只允许一轮（≤8 个，含 StrictMode 双跑）', b2Fail.length <= 8, `${b2Fail.length} 个：` +
    [...new Set(b2Fail.map((e) => `${e.status} ${e.url.replace(/\?.*/, '')}`))].join(' ; '));
  check('B2. 跳回登录页后 1.5 秒起不再有任何 /api 请求（不重试、不死循环）',
    b2AfterSettle.length === 0, b2AfterSettle.map((e) => e.url).join(' ; ') || '无');
  check('B2. 登录页 toast ≤ 1（一轮 401 只弹一条）', b2Toasts <= 1, `toast=${b2Toasts}`);
  check('B2. 登录按钮仍可点击', (await cdp.eval(`window.__T.loginButtonClickable()`)) === 'clickable');
  check('B2. 登录页给出「上次登录已失效」提示', Boolean(await cdp.eval(`window.__T.has('上次登录已失效')`)));
  check('B2. 登录痕迹已被清除', (await cdp.eval(`window.__T.sessionHint()`)) === null);

  /* ================= D. 重新登录：主流程恢复 ================= */
  await cdp.eval(`window.__T.fill('登录密码', '123456')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  const dOk = await waitFor(cdp, `window.__T.path() === '/' && window.__T.has('项目盈亏总表')`, '重新登录进入首页', 20000).catch(() => false);
  check('D. 重新登录成功、首页恢复（闩锁不会把人永久挡在外面）', Boolean(dOk));
  if (!dOk) {
    const where = await cdp.eval(`JSON.stringify({
      path: location.pathname,
      text: document.body.innerText.slice(0, 160),
      toast: [...document.querySelectorAll('.ant-message-notice')].map((n) => n.innerText).join(' | '),
    })`);
    console.log(`   [诊断] D 卡在这里：${where}`);
    console.log(`   [诊断] D 期间 /api 请求：${JSON.stringify(apiHits(events.length - 20).map((e) => `${e.status} ${e.url.replace(/\?.*/, '')}`))}`);
  }
} catch (error) {
  check(`执行异常：${error.message}`, false);
} finally {
  try {
    await cdp?.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 401 收敛回归汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
