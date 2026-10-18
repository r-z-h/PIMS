/**
 * 浏览器级联调验证：成本 ↔ 应付单联动（真后端 + 真前端，headless Edge + CDP）。
 *
 * 前置：
 *   1) 后端已启动（临时库，端口 8033）
 *   2) 前端 dev server 已启动且指向该后端（默认 http://127.0.0.1:5173）
 * 用法：node scripts/verify-payable-browser.mjs
 * 可用 PIMS_BASE / PIMS_API / PIMS_CDP_PORT 覆盖，避免与别人串台。
 *
 * 只读验证脚本：不改任何源码。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const API = process.env.PIMS_API || 'http://127.0.0.1:8033';
const PORT = Number(process.env.PIMS_CDP_PORT || 9333);
const SHOT_DIR = process.env.PIMS_SHOT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

/* ============================ CDP 基础设施 ============================ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result?.value;
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await sleep(700);
  }
  async shot(name) {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = join(SHOT_DIR, name);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    } catch (e) {
      return '截图失败: ' + e.message;
    }
  }
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
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  },
  itemByLabel(root, label) {
    return [...root.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
  },
  fill(label, value, root) {
    const item = window.__T.itemByLabel(root || document, label);
    if (!item) throw new Error('form item not found: ' + label);
    const el = item.querySelector('input:not([type=hidden]), textarea');
    if (!el) throw new Error('input not found in: ' + label);
    return window.__T.setInput(el, value);
  },
  read(label, root) {
    const item = window.__T.itemByLabel(root || document, label);
    if (!item) throw new Error('form item not found: ' + label);
    const el = item.querySelector('input:not([type=hidden]), textarea');
    return el ? el.value : null;
  },
  formItem(label, root) {
    const item = window.__T.itemByLabel(root || document, label);
    if (!item) throw new Error('form item not found: ' + label);
    return item;
  },
  modal() {
    const visible = (el) => !!el && el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((m) => m.style.display !== 'none')
      .map((m) => m.querySelector('.ant-modal'))
      .filter(visible);
    if (modals.length) return modals[modals.length - 1];
    const drawers = [...document.querySelectorAll('.ant-drawer-content')].filter(visible);
    return drawers.length ? drawers[drawers.length - 1] : null;
  },
  modalText() { const m = window.__T.modal(); return m ? m.innerText : ''; },
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
    const btns = [...m.querySelectorAll('.ant-modal-footer button')];
    const ok = btns.find((b) => /确定|保存|提交|确认/.test(b.innerText)) || btns[btns.length - 1];
    if (!ok) throw new Error('modal ok button not found');
    ok.click();
    return true;
  },
  clickModalButton(text) {
    const m = window.__T.modal();
    if (!m) throw new Error('no modal');
    const btn = [...m.querySelectorAll('.ant-modal-footer button')].find((b) => window.__T.norm(b.innerText) === window.__T.norm(text));
    if (!btn) throw new Error('modal button not found: ' + text);
    btn.click();
    return true;
  },
  /** 打开某个表单项里的 antd Select（不选值，只展开下拉） */
  openSelect(label, root) {
    const item = window.__T.formItem(label, root);
    const sel = item.querySelector('.ant-select-selector');
    if (!sel) throw new Error('select not found: ' + label);
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    sel.click();
    return true;
  },
  /** 在下拉里点选文本匹配的项 */
  pickOption(text) {
    const drops = [...document.querySelectorAll('.ant-select-dropdown')].filter((d) => !d.classList.contains('ant-select-dropdown-hidden'));
    for (const d of drops.reverse()) {
      const opt = [...d.querySelectorAll('.ant-select-item-option')]
        .find((o) => window.__T.norm(o.innerText) === window.__T.norm(text));
      if (opt) { opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); opt.click(); return true; }
    }
    throw new Error('option not found: ' + text + ' :: ' + drops.map((d) => d.innerText).join(' | '));
  },
  tableText() { return [...document.querySelectorAll('.ant-table')].map((t) => t.innerText).join('\\n'); },
  tab(name) {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => window.__T.norm(x.innerText) === window.__T.norm(name));
    if (!t) throw new Error('tab not found: ' + name);
    t.click();
    return true;
  },
  toasts() { return [...document.querySelectorAll('.ant-message-notice')].map((n) => n.innerText).join(' | '); },
  setLs(key, value) { localStorage.setItem(key, value); return true; },
};
true;
`;

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return new CDP(ws);
}

async function pickTarget() {
  for (let i = 0; i < 80; i += 1) {
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

async function waitFor(cdp, expression, desc, timeout = 20000) {
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

async function gotoAndInject(cdp, url) {
  await cdp.goto(url);
  await sleep(900);
  await cdp.eval(HELPERS);
  await waitFor(cdp, `typeof window.__T === 'object'`, '辅助脚本注入');
}

/* ============================ API 直连（仅用于种数据/交叉核对） ============================ */
let sessionCookie = '';
async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const r = await fetch(API + path, { ...init, headers });
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) sessionCookie = pair;
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

let edge;
let cdp;
const shots = {};

try {
  /* ---------- 0. 后端准备：登录 / 密保 / 项目 / 字典 ---------- */
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (login.body?.code !== 0) throw new Error('API 登录失败：' + JSON.stringify(login.body));
  check('[前置] 后端存活，API 登录成功', true);

  if (login.body.data.security_ready === false) {
    const setup = await api('/api/auth/security/setup', {
      method: 'POST',
      body: JSON.stringify({
        questions: [
          { question: '联调问题1', answer: '联调答案1' },
          { question: '联调问题2', answer: '联调答案2' },
          { question: '联调问题3', answer: '联调答案3' },
        ],
      }),
    });
    check('[前置] 首次登录设置 3 个密保问题', setup.body?.code === 0, JSON.stringify(setup.body).slice(0, 140));
  } else {
    check('[前置] 密保已就绪（跳过设置）', true);
  }

  const stamp = Date.now().toString().slice(-6);
  const projName = `浏览器联动项目${stamp}`;
  const proj = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: projName, client_budget: 500000, cost_budget: 400000, status: 'ongoing' }),
  });
  if (proj.body?.code !== 0) throw new Error('建项目失败：' + JSON.stringify(proj.body));
  const pid = proj.body.data.id;
  console.log(`   [信息] 项目 id=${pid} name=${projName}`);

  await api('/api/dict', { method: 'POST', body: JSON.stringify({ dict_type: 'misc_category', name: '伙食费' }) });

  /* ---------- 起浏览器 ---------- */
  const profile = mkdtempSync(join(tmpdir(), 'pims-edge-link-'));
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

  /* ---------- 1. 真实登录 ---------- */
  await gotoAndInject(cdp, BASE + '/');
  await waitFor(cdp, `window.__T.path() === '/login'`, '未登录跳转登录页');
  await cdp.eval(`(() => {
    const el = document.querySelector('input[type=password]');
    window.__T.setInput(el, '123456');
    return true;
  })()`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/security-setup' || window.__T.has('项目盈亏总表')`, '登录后进入系统', 25000);
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
    await waitFor(cdp, `window.__T.path() === '/'`, '密保保存后进入首页', 20000);
  }
  check('B0 真浏览器用 123456 登录成功（真后端会话）', true);

  /* ---------- 2. 真后端联通性：API 建的项目必须出现在 UI ---------- */
  await cdp.eval(`window.__T.setLs('pims.current_project_id', '${pid}')`);
  await cdp.eval(`window.__T.setLs('pims.date_range', JSON.stringify({ start_date: '2026-01-01', end_date: '2026-12-31' }))`);
  await gotoAndInject(cdp, BASE + '/projects');
  const sawProject = await waitFor(cdp, `window.__T.tableText().includes(${JSON.stringify(projName)})`, '项目列表出现 API 新建的项目', 25000).catch(() => false);
  check('B0b 前端确实连的是真后端（API 建的项目出现在 UI 列表）', Boolean(sawProject), projName);

  /* ---------- 3. 记账页录一笔杂费 ---------- */
  await gotoAndInject(cdp, BASE + '/bookkeeping');
  await waitFor(cdp, `window.__T.has('筛选条件下')`, '记账页渲染');
  await cdp.eval(`window.__T.tab('杂费')`);
  await sleep(800);
  await cdp.eval(`window.__T.clickText('新增杂费', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.modalText().includes('新增杂费')`, '新增杂费弹窗打开');
  const projectFieldValue = await cdp.eval(`(() => {
    const m = window.__T.modal();
    const item = window.__T.formItem('项目', m);
    return (item.querySelector('.ant-select-selection-item')?.innerText || '').trim();
  })()`);
  await cdp.eval(`(() => {
    const m = window.__T.modal();
    window.__T.fill('发生日期', '2026-10-15', m);
    window.__T.openSelect('杂费小类', m);
    return true;
  })()`);
  await sleep(500);
  await cdp.eval(`window.__T.pickOption('伙食费')`);
  await cdp.eval(`(() => {
    const m = window.__T.modal();
    window.__T.fill('金额', '1200', m);
    window.__T.fill('备注', '浏览器联调：伙食费', m);
    return true;
  })()`);
  await sleep(300);
  shots['form'] = await cdp.shot('01-杂费录入表单.png');
  await cdp.eval(`window.__T.clickModalOk()`);

  /* ---------- 4. 「登记已付」弹窗（核心） ---------- */
  let modalReady = true;
  try {
    await waitFor(cdp, `window.__T.modalText().includes('登记已付')`, '登记已付弹窗出现', 20000);
  } catch (e) {
    modalReady = false;
    check('B1 录完杂费后弹出「登记已付」弹窗', false, e.message + ' :: 页面=' + (await cdp.eval(`window.__T.txt().slice(0,300)`)));
  }
  if (modalReady) {
    const modalText = await cdp.eval(`window.__T.modalText()`);
    shots['payModal'] = await cdp.shot('02-登记已付弹窗.png');
    check('B1 录完杂费后弹出「登记已付」弹窗', true, modalText.split('\n').slice(0, 3).join(' / '));
    check('B1b 弹窗标题带成本描述（杂费 · 伙食费）', /已记账：杂费 · 伙食费/.test(modalText), modalText.split('\n')[0]);
    const auto = modalText.match(/已自动生成应付单：\s*([\d,]+(?:\.\d+)?)/);
    const autoAmount = auto ? Number(auto[1].replace(/,/g, '')) : null;
    check('B2 弹窗显示「已自动生成应付单：1,200.00」且等于成本金额（不是 0）',
      autoAmount === 1200, `弹窗文本=${auto ? auto[1] : '未匹配到'}；原始行=${(modalText.match(/已自动生成应付单：[^\n]*/) || ['无'])[0]}`);
    const unsettledLine = (modalText.match(/未结金额：[^\n（]*/) || ['无'])[0];
    check('B2b 弹窗未结金额 = 成本全额 1,200.00', /1,200\.00/.test(unsettledLine), unsettledLine);
    check('B2c 弹窗四项均为选填（已付金额/支付方式/付款日期/备注都在）',
      ['已付金额', '支付方式', '付款日期', '备注'].every((k) => modalText.includes(k)));

    /* ---------- 5. 填四字段 + 登记 ---------- */
    await cdp.eval(`(() => {
      const m = window.__T.modal();
      window.__T.fill('已付金额', '300', m);
      window.__T.openSelect('支付方式', m);
      return true;
    })()`);
    await sleep(500);
    await cdp.eval(`window.__T.pickOption('转账')`);
    await cdp.eval(`(() => {
      const m = window.__T.modal();
      window.__T.fill('付款日期', '2026-10-14', m);
      window.__T.fill('备注', '浏览器首付300', m);
      return true;
    })()`);
    await sleep(300);
    shots['payFilled'] = await cdp.shot('03-登记已付-已填写.png');
    const filled = await cdp.eval(`(() => {
      const m = window.__T.modal();
      return JSON.stringify({
        paid: window.__T.read('已付金额', m),
        method: (window.__T.formItem('支付方式', m).querySelector('.ant-select-selection-item')?.innerText || '').trim(),
        date: window.__T.read('付款日期', m),
        remark: window.__T.read('备注', m),
      });
    })()`);
    console.log('   [信息] 弹窗四字段值 = ' + filled);
    await cdp.eval(`window.__T.clickModalButton('登记')`);

    const okToast = await waitFor(
      cdp,
      `window.__T.toasts().includes('已登记付款') ? window.__T.toasts() : false`,
      '登记成功提示',
      20000,
    ).catch((e) => '超时：' + e.message);
    shots['paid'] = await cdp.shot('04-登记成功提示.png');
    check('B3 点「登记」后弹出成功提示（已登记付款 300.00；未结 900.00）',
      typeof okToast === 'string' && /已登记付款\s*300\.00/.test(okToast) && /未结\s*900\.00/.test(okToast),
      String(okToast).slice(0, 200));
    const closed = await waitFor(cdp, `!window.__T.modalText().includes('登记已付')`, '弹窗关闭', 15000).then(() => true).catch(() => false);
    check('B3b 「登记已付」弹窗已关闭', closed);
  }

  /* ---------- 6. /arap 应付单 ---------- */
  await gotoAndInject(cdp, BASE + '/arap');
  await waitFor(cdp, `window.__T.has('应收单') && window.__T.has('应付单')`, '往来页渲染');
  await cdp.eval(`window.__T.tab('应付单')`);
  await sleep(1200);
  const arapTable = await waitFor(cdp, `window.__T.tableText().includes('1,200.00') ? window.__T.tableText() : false`, '应付单出现该笔', 25000).catch(() => '');
  shots['arap'] = await cdp.shot('05-往来-应付单.png');
  const arapRow = String(arapTable).split('\n').find((l) => l.includes('1,200.00')) || '';
  check('B4 /arap 应付单页签能查到该笔（金额 1,200.00 / 已冲销 300.00 / 未结 900.00 / 状态部分）',
    arapRow.includes('1,200.00') && arapRow.includes('300.00') && arapRow.includes('900.00') && arapRow.includes('部分'),
    arapRow.replace(/\t/g, ' | '));
  check('B4b 应付单对方/类型正确（杂费，对方为空显示 -）', arapRow.includes('杂费'), arapRow.replace(/\t/g, ' | '));

  /* ---------- 7. /payments 付款流水 ---------- */
  await gotoAndInject(cdp, BASE + '/payments');
  await waitFor(cdp, `window.__T.has('支付方式')`, '收/付款页渲染');
  const payTable = await waitFor(cdp, `window.__T.tableText().includes('浏览器首付300') ? window.__T.tableText() : false`, '付款流水出现', 25000).catch(() => '');
  shots['payments'] = await cdp.shot('06-收付款流水.png');
  const payRow = String(payTable).split('\n').find((l) => l.includes('浏览器首付300')) || '';
  check('B5 /payments 能看到那笔付款流水（付 300.00 / 转账 / 2026-10-14 / 备注）',
    payRow.includes('300.00') && payRow.includes('转账') && payRow.includes('2026-10-14') && payRow.includes('浏览器首付300'),
    payRow.replace(/\t/g, ' | '));

  /* ---------- 8. /costs 成本明细与合计 ---------- */
  await gotoAndInject(cdp, BASE + '/costs');
  await waitFor(cdp, `window.__T.has('实际成本（五类合计）')`, '成本页渲染');
  const costTable = await waitFor(cdp, `window.__T.tableText().includes('伙食费') ? window.__T.tableText() : false`, '成本页出现该笔', 25000).catch(() => '');
  shots['costs'] = await cdp.shot('07-成本页.png');
  const costRow = String(costTable).split('\n').find((l) => l.includes('伙食费')) || '';
  const pageText = await cdp.eval(`window.__T.txt()`);
  check('B6 /costs 该笔出现在成本明细里（伙食费 1,200.00）',
    costRow.includes('伙食费') && costRow.includes('1,200.00'), costRow.replace(/\t/g, ' | '));
  check('B6b /costs 合计正确（杂费合计与总合计均为 1,200.00）',
    /实际成本（五类合计）\s*1,200\.00/.test(pageText.replace(/\n/g, ' ')) || (pageText.match(/1,200\.00/g) || []).length >= 3,
    '页面中 1,200.00 出现次数=' + (pageText.match(/1,200\.00/g) || []).length);

  /* ---------- 9. EXTRA：成本页自己也能录一笔（垫付）。失败不阻断后续步骤 ---------- */
  try {
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => window.__T.norm(b.innerText).includes('新增成本'));
      if (!btn) throw new Error('未找到「新增成本」按钮');
      const trigger = btn.closest('.ant-dropdown-trigger') || btn.parentElement || btn;
      ['mouseover', 'mouseenter', 'mousemove'].forEach((type) =>
        trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })));
      return true;
    })()`);
    await waitFor(cdp, `!!document.querySelector('.ant-dropdown-menu-item')`, '成本页「新增成本」下拉展开', 8000);
    await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((i) => window.__T.norm(i.innerText).includes('新增垫付'));
      if (!item) throw new Error('下拉里没有「新增垫付」');
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      item.click();
      return true;
    })()`);
    await waitFor(cdp, `window.__T.modalText().includes('新增垫付')`, '成本页新增垫付弹窗');
    await cdp.eval(`(() => {
      const m = window.__T.modal();
      window.__T.fill('发生日期', '2026-10-15', m);
      window.__T.fill('垫付人', '老板', m);
      window.__T.fill('垫付事由', '临时买料', m);
      window.__T.fill('金额', '500', m);
      return true;
    })()`);
    await sleep(300);
    await cdp.eval(`window.__T.clickModalOk()`);
    const extraModal = await waitFor(cdp, `window.__T.modalText().includes('登记已付') ? window.__T.modalText() : false`, '成本页录入后弹登记已付', 20000).catch((e) => '超时:' + e.message);
    shots['costsCreate'] = await cdp.shot('08-成本页录入垫付-登记已付.png');
    check('B7 [额外] 成本页也能录入五类（垫付 500）并自动生成应付单 500.00',
      typeof extraModal === 'string' && /已自动生成应付单：\s*500\.00/.test(extraModal),
      String(extraModal).split('\n').slice(0, 4).join(' / ').slice(0, 200));
    await cdp.eval(`window.__T.clickModalButton('稍后再说')`);
    await sleep(1200);
    const costsAfter = await waitFor(cdp, `window.__T.tableText().includes('500.00') ? window.__T.tableText() : false`, '成本页刷新出第二笔', 20000).catch(() => '');
    check('B7b [额外] 同一份数据：成本页出现垫付 500.00 明细', String(costsAfter).includes('500.00'), String(costsAfter).split('\n').filter((l) => l.includes('500.00')).join(' ; ').slice(0, 200));
    // 记账页应看到同一笔（共用同一份数据）
    await gotoAndInject(cdp, BASE + '/bookkeeping');
    await cdp.eval(`window.__T.tab('垫付')`);
    await sleep(1200);
    const bkAdvance = await waitFor(cdp, `window.__T.tableText().includes('500.00') ? window.__T.tableText() : false`, '记账页垫付页签出现同一笔', 20000).catch(() => '');
    shots['bookkeepingAdvance'] = await cdp.shot('09-记账页-垫付.png');
    check('B7c [额外] 记账页「垫付」页签能看到成本页录的那笔（同一份数据）',
      String(bkAdvance).includes('500.00') && String(bkAdvance).includes('临时买料'),
      String(bkAdvance).split('\n').filter((l) => l.includes('500.00')).join(' ; ').slice(0, 200));
  } catch (e) {
    check('B7 [额外] 成本页录入入口（垫付）', false, e.message);
    console.log('   [额外步骤失败现场] ' + (await cdp.shot('98-额外步骤失败.png')));
  }

  /* ---------- 10. 接口交叉核对 ----------
   * 注意：后端是单用户单会话（密码登录会覆盖旧 token），浏览器登录后 Node 这边的旧 Cookie
   * 已失效，所以这里必须重新登录一次。 */
  const relogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (relogin.body?.code !== 0) throw new Error('交叉核对前重新登录失败：' + JSON.stringify(relogin.body));
  const costs = await api(`/api/costs?project_id=${pid}&type=misc&page=1&page_size=10`);
  const miscCost = (costs.body?.data?.items ?? []).find((i) => Number(i.amount) === 1200);
  if (miscCost) {
    const detail = await api(`/api/costs/${miscCost.id}/payable`);
    check('B8 [交叉核对] 后端 GET /costs/{id}/payable：金额 1200、已冲销 300、未结 900、冲销 1 条',
      Number(detail.body?.data?.arap?.amount) === 1200 && Number(detail.body?.data?.arap?.settled_amount) === 300
        && Number(detail.body?.data?.unsettled) === 900 && (detail.body?.data?.offsets ?? []).length === 1,
      JSON.stringify({ amount: detail.body?.data?.arap?.amount, settled: detail.body?.data?.arap?.settled_amount, unsettled: detail.body?.data?.unsettled, status: detail.body?.data?.arap?.status }));
  } else {
    check('B8 [交叉核对] 能查到 UI 录入的杂费成本', false, '接口没返回杂费记录');
  }

  console.log('\n   截图目录：' + SHOT_DIR);
  Object.entries(shots).forEach(([k, v]) => console.log(`     ${k}: ${v}`));
} catch (e) {
  check('浏览器联调脚本异常', false, e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join(' | '));
  if (cdp) {
    const dump = await cdp.eval(`JSON.stringify({ url: location.href, text: document.body.innerText.slice(0, 600) })`).catch(() => '无法读取页面');
    console.log('   [失败现场] ' + dump);
    console.log('   [失败截图] ' + (await cdp.shot('99-异常现场.png')));
  }
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 浏览器级（真后端）联调汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
