/**
 * 真实后端联调验证（不是 mock）—— headless Edge + CDP 驱动真实 DOM。
 *
 * 前置：
 *   1) 后端已启动：uvicorn app.main:app --port 8000 --app-dir backend（可使用临时库）
 *   2) 前端 dev server 已启动：npm run dev（VITE_USE_MOCK=false）
 * 用法：node scripts/real-backend-e2e.mjs
 *   多人并行联调时可用 PIMS_BASE / PIMS_API / PIMS_CDP_PORT 指向别的实例，避免串台。
 *
 * 目的：验证前端能真正消费后端的响应信封、字段名与错误码（mock 测不出这一层）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const API = process.env.PIMS_API || 'http://127.0.0.1:8000';
const PORT = Number(process.env.PIMS_CDP_PORT || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

const HELPERS = `
window.__T = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  norm: (s) => (s || '').replace(/\\s+/g, ''),
  txt: () => document.body.innerText,
  has: (t) => window.__T.norm(document.body.innerText).includes(window.__T.norm(t)),
  path: () => location.pathname,
  setInput(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  itemByLabel(root, label) {
    return [...root.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
  },
  fill(label, value, root) {
    const scope = root || document;
    const item = window.__T.itemByLabel(scope, label);
    if (!item) throw new Error('form item not found: ' + label);
    const el = item.querySelector('input, textarea');
    if (!el) throw new Error('input not found in: ' + label);
    return window.__T.setInput(el, value);
  },
  read(label, root) {
    const scope = root || document;
    const item = window.__T.itemByLabel(scope, label);
    if (!item) throw new Error('form item not found: ' + label);
    return item.querySelector('input, textarea').value;
  },
  modal() {
    // 弹层：Modal（多数表单）或 Drawer（项目档案按手册 5.3 用抽屉）
    const visible = (el) => !!el && el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((m) => m.style.display !== 'none')
      .map((m) => m.querySelector('.ant-modal'))
      .filter(visible);
    if (modals.length) return modals[modals.length - 1];
    const drawers = [...document.querySelectorAll('.ant-drawer-content')].filter(visible);
    return drawers.length ? drawers[drawers.length - 1] : null;
  },
  clickText(text, selector, root) {
    const scope = root || document;
    const nodes = [...scope.querySelectorAll(selector || 'button, a, .ant-tabs-tab, li, span')];
    const hit = nodes.find((n) => window.__T.norm(n.innerText) === window.__T.norm(text))
      || nodes.find((n) => window.__T.norm(n.innerText).includes(window.__T.norm(text)));
    if (!hit) throw new Error('clickable not found: ' + text);
    hit.click();
    return true;
  },
  clickModalOk() {
    const m = window.__T.modal();
    if (!m) throw new Error('no modal');
    const btns = [...m.querySelectorAll(
      '.ant-modal-footer button, .ant-drawer-footer button, .ant-drawer-extra button, .ant-drawer-header button',
    )];
    const ok = btns.find((b) => /确定|保存|提交|确认/.test(b.innerText)) || btns[btns.length - 1];
    if (!ok) throw new Error('modal ok button not found');
    ok.click();
    return true;
  },
  tableText() {
    return [...document.querySelectorAll('.ant-table')].map((t) => t.innerText).join('\\n');
  },
  tab(name) {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => window.__T.norm(x.innerText) === window.__T.norm(name));
    if (!t) throw new Error('tab not found: ' + name);
    t.click();
    return true;
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
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      this.handlers.slice().forEach((h) => h(msg));
    });
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result?.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(600);
  }
}

async function connect(url) {
  // Node 18+ 自带全局 WebSocket，无需额外依赖
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new CDP(ws);
}

async function pickTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 等 Edge 起来 */
    }
    await sleep(300);
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
    await sleep(250);
  }
  throw new Error(`等待超时：${desc}（最后结果 ${JSON.stringify(last)}）`);
}

/** 导航后必须重新注入辅助函数：整页导航会清空 window */
async function gotoAndInject(cdp, url) {
  await cdp.goto(url);
  await sleep(900);
  await cdp.eval(HELPERS);
  await waitFor(cdp, `typeof window.__T === 'object'`, '辅助脚本注入');
}

/** 记录当前页面发出的失败请求（用于定位登录页误报 401 这类问题） */
function watchFailedRequests(cdp) {
  const hits = [];
  cdp.handlers.push((msg) => {
    if (msg.method === 'Network.responseReceived') {
      const { url, status } = msg.params.response;
      if (status >= 400) hits.push(`${status} ${url.replace(API, '').replace(BASE, '')}`);
    }
  });
  return hits;
}

/** 简易 cookie 罐：Node fetch 不会自动保存 Set-Cookie，需自己带上 */
let sessionCookie = '';

async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const r = await fetch(API + path, { ...init, headers });
  const setCookie = r.headers.getSetCookie?.() ?? [];
  setCookie.forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) sessionCookie = pair;
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

let edge;
let cdp;

try {
  /* ============ 准备：直接用 API 种一个基准项目（验证前端读真实响应的能力） ============ */
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (login.body?.code !== 0) throw new Error('登录失败，后端是否已启动？ ' + JSON.stringify(login.body));
  check('后端存活，默认密码可登录', login.body.code === 0);

  if (login.body.data.security_ready === false) {
    const setup = await api('/api/auth/security/setup', {
      method: 'POST',
      body: JSON.stringify({
        questions: [
          { question: '测试问题1', answer: '答案1' },
          { question: '测试问题2', answer: '答案2' },
          { question: '测试问题3', answer: '答案3' },
        ],
      }),
    });
    check('API 设置密保（供后续真实登录）', setup.body?.code === 0, JSON.stringify(setup.body).slice(0, 120));
  }

  const seed = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: '联调基准项目', client_name: '联调甲方', location: '武汉', manager: '王工',
      start_date: '2026-03-01', status: 'ongoing',
      client_budget: 4000000, cost_budget: 3500000, members: ['王工'], remark: 'e2e',
    }),
  });
  check('API 创建基准项目成功', seed.body?.code === 0, JSON.stringify(seed.body).slice(0, 120));
  const seedPid = seed.body.data.id;

  await api('/api/costs/misc', {
    method: 'POST',
    body: JSON.stringify({ project_id: seedPid, category: '伙食费', amount: 1500, biz_date: '2026-05-12', remark: 'e2e' }),
  });

  /* ============ 启动浏览器 ============ */
  const profile = mkdtempSync(join(tmpdir(), 'pims-edge-real-'));
  edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1680,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const target = await pickTarget();
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* ---- 1. 登录流程走真实后端 ---- */
  await cdp.send('Network.enable');
  const failedReqs = watchFailedRequests(cdp);
  await gotoAndInject(cdp, BASE + '/');
  const diag = await cdp.eval(`JSON.stringify({
    url: location.href,
    rootHtmlLen: (document.getElementById('root')?.innerHTML || '').length,
    toastCount: document.querySelectorAll('.ant-message-notice').length,
    bodyText: document.body.innerText.slice(0, 100),
  })`);
  console.log('   [诊断] ' + diag);
  console.log('   [登录页失败请求] ' + (failedReqs.length ? failedReqs.join(' ; ') : '无'));
  await waitFor(cdp, `window.__T.path() === '/login'`, '未登录跳 /login');
  check('真后端下：未登录访问 / 跳转登录页', true);
  check(
    '登录页不发出 401 业务请求（不刷无用报错提示）',
    failedReqs.filter((h) => h.includes('/api/')).length === 0,
    failedReqs.join(' ; ') || '无',
  );
  check(
    '登录页不堆积错误 toast',
    (await cdp.eval(`document.querySelectorAll('.ant-message-notice').length`)) <= 1,
    'toast=' + (await cdp.eval(`document.querySelectorAll('.ant-message-notice').length`)),
  );

  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  // 首次登录会跳密保设置（后端返回 security_ready=false）；若已设置则直接进首页
  await waitFor(
    cdp,
    `window.__T.path() === '/security-setup' || window.__T.has('项目盈亏总表')`,
    '登录后进入首页或密保页',
  );
  if (await cdp.eval(`window.__T.path() === '/security-setup'`)) {
    for (let i = 0; i < 3; i += 1) {
      await cdp.eval(`(() => {
        const card = [...document.querySelectorAll('.ant-card')].find((c) => (c.querySelector('.ant-card-head-title')?.innerText || '').includes('密保问题 ${i + 1}'));
        const items = [...card.querySelectorAll('.ant-form-item')];
        window.__T.setInput(items[0].querySelector('input'), '联调问题${i + 1}');
        window.__T.setInput(items[1].querySelector('input'), '联调答案${i + 1}');
        return true;
      })()`);
    }
    await cdp.eval(`window.__T.clickText('保存并进入系统', '.ant-btn-primary')`);
    await waitFor(cdp, `window.__T.path() === '/'`, '密保保存后进入首页');
  }
  check('真后端下：登录 → 密保 → 进入首页', true);

  /* ---- 2. 首页盈亏总表：读的是真实后端的计算结果 ---- */
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '首页盈亏总表渲染');
  // 卡片标题先于数据渲染，必须等数据行真的出现再断言，否则冷启动时会误判为「暂无项目」
  await waitFor(cdp, `window.__T.tableText().includes('联调基准项目')`, '首页加载出项目数据行', 25000);
  const board = await cdp.eval(`window.__T.tableText()`);
  check('首页显示 API 建的项目「联调基准项目」', board.includes('联调基准项目'));
  check('预计利润 500,000.00（400万−350万，来自后端）', board.includes('500,000.00'), board.slice(0, 200).replace(/\n/g, ' | '));
  check('实际成本 1,500.00（后端算的五类之和）', board.includes('1,500.00'));
  check('结算利润 3,998,500.00（400万−1500）', board.includes('3,998,500.00'));
  check('页面不出现「现金结余」', !(await cdp.eval(`window.__T.has('现金结余')`)));

  /* ---- 3. 通过 UI 新建项目：验证表单 → 真后端 → 列表刷新 ---- */
  await gotoAndInject(cdp, BASE + '/projects');
  await waitFor(cdp, `window.__T.has('联调基准项目')`, '项目列表加载真实数据');
  await cdp.eval(`window.__T.clickText('新建项目', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '新建项目弹窗');
  await cdp.eval(`(() => {
    const m = window.__T.modal();
    window.__T.fill('项目名称', 'UI 新建项目', m);
    window.__T.fill('甲方预算', '1000000', m);
    window.__T.fill('我方成本预算', '800000', m);
    return true;
  })()`);
  await cdp.eval(`window.__T.clickModalOk()`);
  const created = await waitFor(cdp, `window.__T.tableText().includes('UI 新建项目')`, 'UI 新建项目出现在列表', 20000).catch(() => false);
  check('UI 表单提交 → 真后端落库 → 列表刷新', Boolean(created));

  /* ---- 4. 记账页（五类成本录入）：真实后端的形状能否渲染 ---- */
  await gotoAndInject(cdp, BASE + '/bookkeeping');
  await waitFor(cdp, `window.__T.has('筛选条件下')`, '记账页渲染');
  await cdp.eval(`window.__T.tab('杂费')`);
  const miscOk = await waitFor(cdp, `window.__T.tableText().includes('伙食费')`, '杂费列表渲染真实数据').catch(() => false);
  check('杂费页签渲染后端返回的明细（含小类）', Boolean(miscOk));

  /* ---- 4b. 新的「成本」汇总页：能否对真实数据汇总 ---- */
  await gotoAndInject(cdp, BASE + '/costs');
  const costOk = await waitFor(cdp, `window.__T.has('成本明细（按类别分组）')`, '成本汇总页渲染').catch(() => false);
  check('新「成本」汇总页渲染', Boolean(costOk));
  const costBoard = await cdp.eval(`window.__T.tableText()`);
  check('成本页显示该笔杂费明细与合计', costBoard.includes('伙食费') && costBoard.includes('1,500.00'),
    costBoard.slice(0, 200).replace(/\n/g, ' | '));

  /* ---- 5. 应收应付页：真实 arap 形状 ---- */
  await gotoAndInject(cdp, BASE + '/arap');
  const arapOk = await waitFor(cdp, `window.__T.has('应收') && window.__T.has('应付')`, '往来页渲染').catch(() => false);
  check('往来页渲染（应收/应付两个页签）', Boolean(arapOk));

  /* ---- 6. 库存页：必须选项目才显示（项目隔离） ---- */
  await gotoAndInject(cdp, BASE + '/inventory');
  const invOk = await waitFor(cdp, `window.__T.has('库存')`, '库存页渲染').catch(() => false);
  check('库存页渲染', Boolean(invOk));

  /* ---- 7. 退出登录：真后端会话失效 ---- */
  await gotoAndInject(cdp, BASE + '/');
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '回到首页');
  const loggedOut = await cdp.eval(`(async () => {
    try {
      const r = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      const j = await r.json();
      return j.code === 0;
    } catch (e) { return false; }
  })()`);
  check('调用 /api/auth/logout 成功（真后端会话接口）', Boolean(loggedOut));
} catch (e) {
  check('联调脚本异常', false, e.message);
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 真后端联调汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
