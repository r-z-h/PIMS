/**
 * 打包态「本轮新功能」逐条复核（独立于 smoke-packaged.mjs，用真实浏览器点真实 DOM）。
 *
 * 覆盖：
 *   A. 左侧菜单顺序（首页/项目/记账/收付款/成本/往来/库存/结算/设置）
 *   B. /bookkeeping 五类成本录入页（五个页签 + 「筛选条件下」合计）
 *   C. /payments 资金收付流水页（新增收款 / 新增付款）
 *   D. /costs 成本汇总页 + 右上角「新增成本」下拉可五选一
 *   E. /costs 录一笔杂费 → 阻断式「登记已付」弹窗（四字段选填）→ 关闭后进成本明细
 *   F. /arap「应付单」页签能查到自动生成的应付单
 *   G. 再录一笔 1000、登记已付 400 → 未结 600，/payments 有 400 付款流水
 *
 * 用法：node scripts/verify-packaged-newfeatures.mjs
 *   PIMS_BASE     默认 http://127.0.0.1:8000
 *   PIMS_CDP_PORT 默认 9228
 *   PIMS_PASSWORD 默认 123456
 *   PIMS_SHOT_DIR 截图目录，默认 scripts/_verify_shots
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:8000';
const PORT = Number(process.env.PIMS_CDP_PORT || 9228);
const PASSWORD = process.env.PIMS_PASSWORD || '123456';
const SHOT_DIR = resolve(process.env.PIMS_SHOT_DIR || 'scripts/_verify_shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

/* ------------------------------------------------------------------ helpers */

const HELPERS = `
window.__V = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  norm: (s) => (s || '').replace(/\\s+/g, ''),
  num: (s) => Number(String(s == null ? '' : s).replace(/,/g, '').trim()),
  path: () => location.pathname,
  bodyHas(t) { return window.__V.norm(document.body.innerText).includes(window.__V.norm(t)); },
  itemByLabel(label, root) {
    const scope = root || document;
    return [...scope.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
  },
  setInput(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  fill(label, value, root) {
    const item = window.__V.itemByLabel(label, root);
    if (!item) throw new Error('form item not found: ' + label);
    const el = item.querySelector('input:not([type=hidden]), textarea');
    if (!el) throw new Error('input not found in item: ' + label);
    el.focus();
    return window.__V.setInput(el, value);
  },
  /** 最后一个可见的 Modal / Drawer */
  layer() {
    const visible = (el) => !!el && el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((m) => m.style.display !== 'none')
      .map((m) => m.querySelector('.ant-modal'))
      .filter(visible);
    if (modals.length) return modals[modals.length - 1];
    const drawers = [...document.querySelectorAll('.ant-drawer-content')].filter(visible);
    return drawers.length ? drawers[drawers.length - 1] : null;
  },
  layerTitle() {
    const l = window.__V.layer();
    return l ? (l.querySelector('.ant-modal-title, .ant-drawer-title')?.innerText || '').trim() : '';
  },
  /** 弹窗里可见的表单标签文本 */
  layerFormLabels() {
    const l = window.__V.layer();
    if (!l) return [];
    return [...l.querySelectorAll('.ant-form-item-label')].map((n) => (n.innerText || '').trim()).filter(Boolean);
  },
  clickText(text, selector, root) {
    const scope = root || document;
    const target = window.__V.norm(text);
    const el = [...scope.querySelectorAll(selector || 'button, a, .ant-tabs-tab, .ant-menu-item')]
      .find((n) => window.__V.norm(n.innerText).includes(target));
    if (!el) throw new Error('clickable not found: ' + text);
    el.click();
    return true;
  },
  clickLayerButton(text) {
    const l = window.__V.layer();
    if (!l) throw new Error('no layer');
    const btns = [...l.querySelectorAll('.ant-modal-footer button, .ant-drawer-footer button, .ant-drawer-extra button')];
    const target = window.__V.norm(text);
    const btn = [...btns].reverse().find((b) => window.__V.norm(b.innerText).includes(target));
    if (!btn) throw new Error('layer button not found: ' + text + ' in ' + JSON.stringify(btns.map((b) => b.innerText)));
    btn.click();
    return true;
  },
  /** 打开 antd Select（form-item 标签）的下拉 */
  openSelectInItem(label, root) {
    const item = window.__V.itemByLabel(label, root);
    if (!item) throw new Error('select form item not found: ' + label);
    const sel = item.querySelector('.ant-select-selector') || item.querySelector('input');
    if (!sel) throw new Error('selector not found: ' + label);
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((t) =>
      sel.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return true;
  },
  /** 当前展开着的下拉里的选项文本 */
  openDropdownOptions() {
    const drops = [...document.querySelectorAll('.ant-select-dropdown, .ant-dropdown')]
      .filter((d) => !d.classList.contains('ant-select-dropdown-hidden') && !d.classList.contains('ant-dropdown-hidden'));
    const drop = drops[drops.length - 1];
    if (!drop) return [];
    return [...drop.querySelectorAll('.ant-select-item-option-content, .ant-dropdown-menu-item')]
      .map((n) => (n.innerText || '').trim());
  },
  /** 点开着的下拉里的某个选项 */
  pickOption(text) {
    const drops = [...document.querySelectorAll('.ant-select-dropdown, .ant-dropdown')]
      .filter((d) => !d.classList.contains('ant-select-dropdown-hidden') && !d.classList.contains('ant-dropdown-hidden'));
    const drop = drops[drops.length - 1];
    if (!drop) throw new Error('no open dropdown');
    const target = window.__V.norm(text);
    const opt = [...drop.querySelectorAll('.ant-select-item-option, .ant-dropdown-menu-item')]
      .find((n) => window.__V.norm(n.innerText) === target)
      || [...drop.querySelectorAll('.ant-select-item-option, .ant-dropdown-menu-item')]
        .find((n) => window.__V.norm(n.innerText).includes(target));
    if (!opt) throw new Error('option not found: ' + text + ' in ' + JSON.stringify(window.__V.openDropdownOptions()));
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((t) =>
      opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    return true;
  },
  /** antd Dropdown（hover 触发）：给按钮发一串鼠标事件把菜单弹出来 */
  hoverButton(text) {
    const target = window.__V.norm(text);
    const btn = [...document.querySelectorAll('button')].find((b) => window.__V.norm(b.innerText).includes(target));
    if (!btn) throw new Error('button not found: ' + text);
    ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach((t) =>
      btn.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter' && t !== 'pointerenter', cancelable: true, view: window })));
    return true;
  },
  menuItems: () => [...document.querySelectorAll('.ant-menu-item')].map((n) => (n.innerText || '').trim()),
  tabItems: () => [...document.querySelectorAll('.ant-tabs-tab')].map((n) => (n.innerText || '').trim()),
  buttonTexts: () => [...document.querySelectorAll('button')].map((n) => (n.innerText || '').trim()).filter(Boolean),
  tableRows() {
    return [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim()));
  },
  tableText: () => [...document.querySelectorAll('.ant-table')].map((t) => t.innerText).join('\\n'),
  errorToasts: () => document.querySelectorAll('.ant-message-error').length,
  toastTexts: () => [...document.querySelectorAll('.ant-message-notice')].map((n) => (n.innerText || '').trim()),
};
true;
`;

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
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
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
}

async function pickTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 等 Edge 起来 */ }
    await sleep(400);
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
    await sleep(200);
  }
  throw new Error(`等待超时：${desc}（最后值 ${JSON.stringify(last)}）`);
}

async function shot(cdp, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOT_DIR, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  } catch (e) {
    return `(截图失败 ${e.message})`;
  }
}

/* --------------------------------------------------------------------- main */

let edge;
let cdp;
try {
  const profile = mkdtempSync(join(tmpdir(), 'pims-verify-nf-'));
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

  console.log(`目标实例：${BASE}\n`);

  /* ---------------- 0. 打开 + 登录 ---------------- */
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await cdp.eval(HELPERS);
  await waitFor(cdp, `window.__V.bodyHas('登录密码') || window.__V.bodyHas('项目盈亏总表')`, '首屏');
  if (await cdp.eval(`window.__V.bodyHas('登录密码')`)) {
    await cdp.eval(`window.__V.fill('登录密码', ${JSON.stringify(PASSWORD)})`);
    await cdp.eval(`window.__V.clickText('登录', '.ant-btn-primary')`);
  }
  await waitFor(cdp, `window.__V.path() === '/' && window.__V.bodyHas('项目盈亏总表')`, '进入首页', 25000);
  await cdp.eval(HELPERS); // 路由切换后 window 保留，重复注入无害
  check('登录后进入首页（打包态 SPA 路由正常）', true, `path=${await cdp.eval('window.__V.path()')}`);

  /* ---------------- A. 菜单顺序 ---------------- */
  const menu = await cdp.eval(`JSON.stringify(window.__V.menuItems())`);
  const menus = JSON.parse(menu);
  const EXPECT_MENU = ['首页', '项目', '记账', '收/付款', '成本', '往来', '库存', '结算', '设置'];
  check(
    `A. 左侧菜单顺序 = ${EXPECT_MENU.join(' / ')}`,
    JSON.stringify(menus) === JSON.stringify(EXPECT_MENU),
    `实际 = ${menus.join(' / ')}`,
  );

  /* ---------------- B. /bookkeeping ---------------- */
  await cdp.eval(`window.__V.clickText('记账', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/bookkeeping'`, '/bookkeeping');
  await waitFor(cdp, `window.__V.bodyHas('筛选条件下')`, '记账页合计');
  const tabs = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.tabItems())`));
  const EXPECT_TABS = ['人工', '材料', '机械', '杂费', '垫付'];
  check(
    'B1. /bookkeeping 是五类成本录入页（五个页签：人工/材料/机械/杂费/垫付）',
    JSON.stringify(tabs) === JSON.stringify(EXPECT_TABS),
    `实际页签 = ${tabs.join(' / ')}`,
  );
  check('B2. /bookkeeping 有「筛选条件下」合计', await cdp.eval(`window.__V.bodyHas('筛选条件下')`));
  await shot(cdp, 'B-bookkeeping');

  /* ---------------- C. /payments ---------------- */
  await cdp.eval(`window.__V.clickText('收/付款', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/payments'`, '/payments');
  await waitFor(cdp, `window.__V.bodyHas('新增收款')`, '付款页按钮');
  const payBtns = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.buttonTexts())`));
  check('C1. /payments 是资金收付流水页（有「新增收款」）', payBtns.includes('新增收款'), `按钮=${payBtns.join('|')}`);
  check('C2. /payments 有「新增付款」', payBtns.includes('新增付款'));
  await shot(cdp, 'C-payments');

  /* ---------------- D. /costs + 新增成本下拉五类 ---------------- */
  await cdp.eval(`window.__V.clickText('成本', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/costs'`, '/costs');
  await waitFor(cdp, `window.__V.bodyHas('成本明细')`, '成本汇总页渲染');
  check('D1. /costs 是成本汇总页（含「成本明细（按类别分组）」）', await cdp.eval(`window.__V.bodyHas('成本明细（按类别分组）')`));
  check('D2. /costs 右上角有「新增成本」按钮', await cdp.eval(`window.__V.buttonTexts().includes('新增成本')`));

  // 展开「新增成本」下拉
  await cdp.eval(`window.__V.hoverButton('新增成本')`);
  let dropdownOptions = [];
  try {
    await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '新增成本下拉展开', 6000);
    dropdownOptions = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.openDropdownOptions())`));
  } catch (e) {
    check('D3. 「新增成本」下拉可展开', false, e.message);
  }
  const EXPECT_DROP = ['新增人工', '新增材料', '新增机械', '新增杂费', '新增垫付'];
  check(
    'D3. 「新增成本」下拉能选五类（人工/材料/机械/杂费/垫付）',
    JSON.stringify(dropdownOptions) === JSON.stringify(EXPECT_DROP),
    `实际 = ${dropdownOptions.join(' / ')}`,
  );
  await shot(cdp, 'D-costs-dropdown');

  /* ---------------- E. 录一笔杂费 1000 → 登记已付弹窗 ---------------- */
  await cdp.eval(`window.__V.pickOption('新增杂费')`);
  await waitFor(cdp, `window.__V.layerTitle().includes('新增杂费')`, '新增杂费表单', 10000);
  const costFormLabels = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.layerFormLabels())`));
  check('E1. 「新增成本 → 杂费」打开五类共用录入表单', costFormLabels.includes('杂费小类') && costFormLabels.includes('金额') && costFormLabels.includes('项目'),
    `表单字段 = ${costFormLabels.join(' / ')}`);
  await shot(cdp, 'E1-cost-form');

  // 项目（必填）
  await cdp.eval(`window.__V.openSelectInItem('项目', window.__V.layer())`);
  await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '项目下拉', 8000);
  const projectOptions = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.openDropdownOptions())`));
  const projectName = projectOptions.find((o) => o.includes('冒烟测试项目')) || projectOptions[0];
  await cdp.eval(`window.__V.pickOption(${JSON.stringify(projectName)})`);
  // 杂费小类（必填）
  await cdp.eval(`window.__V.openSelectInItem('杂费小类', window.__V.layer())`);
  await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '杂费小类下拉', 8000);
  const miscOptions = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.openDropdownOptions())`));
  await cdp.eval(`window.__V.pickOption(${JSON.stringify(miscOptions[0])})`);
  // 金额
  await cdp.eval(`window.__V.fill('金额', '1000', window.__V.layer())`);
  await cdp.eval(`window.__V.fill('备注', '复核一笔杂费', window.__V.layer())`);
  await sleep(300);
  const filled = JSON.parse(await cdp.eval(`JSON.stringify({
    project: window.__V.itemByLabel('项目', window.__V.layer())?.querySelector('.ant-select-selection-item')?.innerText || '',
    misc: window.__V.itemByLabel('杂费小类', window.__V.layer())?.querySelector('.ant-select-selection-item')?.innerText || '',
    amount: window.__V.itemByLabel('金额', window.__V.layer())?.querySelector('input')?.value || '',
  })`));
  check('E2. 表单填写成功（项目=' + filled.project + ' / 杂费小类=' + filled.misc + ' / 金额=' + filled.amount + '）',
    Boolean(filled.project) && Boolean(filled.misc) && Number(String(filled.amount).replace(/,/g, '')) === 1000,
    JSON.stringify(filled));

  await cdp.eval(`window.__V.clickLayerButton('确定')`);
  // 期望：阻断式「登记已付」弹窗
  let payModalUp = false;
  try {
    await waitFor(cdp, `window.__V.layerTitle().includes('登记已付')`, '登记已付弹窗', 15000);
    payModalUp = true;
  } catch { /* 下面记录失败 */ }
  check('E3. 录完杂费 → 自动弹出「登记已付」弹窗', payModalUp,
    payModalUp ? `标题=${await cdp.eval('window.__V.layerTitle()')}` : `当前 layer=${await cdp.eval('window.__V.layerTitle()')}`);
  if (payModalUp) {
    const labels = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.layerFormLabels())`));
    const EXPECT_PAY_LABELS = ['已付金额', '支付方式', '付款日期', '备注'];
    check('E4. 「登记已付」弹窗是四字段选填', EXPECT_PAY_LABELS.every((l) => labels.includes(l)),
      `弹窗字段 = ${labels.join(' / ')}`);
    const required = await cdp.eval(`(() => {
      const l = window.__V.layer();
      return l.querySelectorAll('.ant-form-item-required').length;
    })()`);
    check('E5. 四字段均非必填（无 required 标记）', required === 0, `required 标记数 = ${required}`);
    check('E6. 弹窗提示已自动生成应付单', await cdp.eval(`window.__V.layer().innerText.includes('已自动生成应付单')`));
    // 阻断式：点遮罩不应关闭（maskClosable=false）
    await cdp.eval(`(() => {
      const w = document.querySelector('.ant-modal-wrap:not([style*="display: none"])');
      if (w) ['mousedown','mouseup','click'].forEach((t) =>
        w.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
      return true;
    })()`);
    await sleep(500);
    check('E6b. 弹窗是阻断式的（点遮罩不会关闭）', await cdp.eval(`window.__V.layerTitle().includes('登记已付')`),
      `当前 layer=${await cdp.eval('window.__V.layerTitle()')}`);
    await shot(cdp, 'E3-pay-modal');

    // 关闭（稍后再说）→ 该笔应出现在成本明细
    await cdp.eval(`window.__V.clickLayerButton('稍后再说')`);
    await waitFor(cdp, `!window.__V.layer()`, '登记已付弹窗关闭', 10000);
    const appeared = await waitFor(cdp, `window.__V.tableText().includes('1,000.00')`, '成本明细出现该笔', 15000).catch(() => false);
    check('E7. 关掉弹窗后该笔出现在成本明细里（金额 1,000.00）', Boolean(appeared));
    await shot(cdp, 'E7-cost-detail');
  }

  /* ---------------- F. /arap 应付单能查到自动生成的应付单 ---------------- */
  await cdp.eval(`window.__V.clickText('往来', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/arap'`, '/arap');
  await cdp.eval(`window.__V.clickText('应付单', '.ant-tabs-tab')`);
  await sleep(1200);
  let rows = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.tableRows())`));
  const firstPayable = rows.find((r) => r.some((c) => c.includes('1,000.00')));
  check('F1. /arap「应付单」页签能查到录成本自动生成的应付单（金额 1,000.00）',
    Boolean(firstPayable), `应付单行 = ${JSON.stringify(rows)}`);
  check('F2. 该应付单未结 = 1,000.00、状态 = 未收付',
    Boolean(firstPayable) && firstPayable.includes('1,000.00') && firstPayable.includes('未收付'),
    firstPayable ? firstPayable.join(' | ') : '未找到');
  await shot(cdp, 'F-arap-payable-first');

  /* ---------------- G. 第二笔 1000 + 登记已付 400 ---------------- */
  await cdp.eval(`window.__V.clickText('成本', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/costs'`, '/costs');
  await waitFor(cdp, `window.__V.buttonTexts().includes('新增成本')`, '成本页就绪');
  await cdp.eval(`window.__V.hoverButton('新增成本')`);
  await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '新增成本下拉', 8000);
  await cdp.eval(`window.__V.pickOption('新增杂费')`);
  await waitFor(cdp, `window.__V.layerTitle().includes('新增杂费')`, '第二笔表单', 10000);

  await cdp.eval(`window.__V.openSelectInItem('项目', window.__V.layer())`);
  await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '项目下拉', 8000);
  const projectOptions2 = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.openDropdownOptions())`));
  await cdp.eval(`window.__V.pickOption(${JSON.stringify(projectOptions2.find((o) => o.includes('冒烟测试项目')) || projectOptions2[0])})`);
  await cdp.eval(`window.__V.openSelectInItem('杂费小类', window.__V.layer())`);
  await waitFor(cdp, `window.__V.openDropdownOptions().length > 0`, '杂费小类下拉', 8000);
  const miscOptions2 = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.openDropdownOptions())`));
  await cdp.eval(`window.__V.pickOption(${JSON.stringify(miscOptions2[1] ?? miscOptions2[0])})`);
  await cdp.eval(`window.__V.fill('金额', '1000', window.__V.layer())`);
  await cdp.eval(`window.__V.fill('备注', '复核第二笔-登记已付400', window.__V.layer())`);
  await sleep(300);
  await cdp.eval(`window.__V.clickLayerButton('确定')`);
  await waitFor(cdp, `window.__V.layerTitle().includes('登记已付')`, '第二笔登记已付弹窗', 15000);
  await cdp.eval(`window.__V.fill('已付金额', '400', window.__V.layer())`);
  await sleep(200);
  const paidField = await cdp.eval(`window.__V.itemByLabel('已付金额', window.__V.layer())?.querySelector('input')?.value`);
  check('G1. 「登记已付」可填已付金额 400', Number(String(paidField).replace(/,/g, '')) === 400, `输入框值 = ${paidField}`);
  await shot(cdp, 'G1-pay400-modal');
  await cdp.eval(`window.__V.clickLayerButton('登记')`);
  await waitFor(cdp, `!window.__V.layer()`, '登记已付弹窗关闭', 15000);
  const gToast = await cdp.eval(`JSON.stringify(window.__V.toastTexts())`);
  check('G2. 登记已付成功（有成功提示）', String(gToast).includes('已登记付款'), `提示=${gToast}`);
  await sleep(1200);

  /* ---------------- H. /arap 未结应为 600 ---------------- */
  await cdp.eval(`window.__V.clickText('往来', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/arap'`, '/arap');
  await cdp.eval(`window.__V.clickText('应付单', '.ant-tabs-tab')`);
  await sleep(1500);
  rows = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.tableRows())`));
  const partialRow = rows.find((r) => r.includes('400.00'));
  check('H1. /arap 应付单出现已冲销 400.00 的记录', Boolean(partialRow), JSON.stringify(rows));
  check('H2. 该应付单未结 = 600.00（成本 1000 − 已付 400）',
    Boolean(partialRow) && partialRow.includes('600.00'), partialRow ? partialRow.join(' | ') : '未找到');
  check('H3. 该应付单状态 = 部分',
    Boolean(partialRow) && partialRow.includes('部分'), partialRow ? partialRow.join(' | ') : '未找到');
  const unselBar = await cdp.eval(`document.querySelector('.pims-total-bar')?.innerText || ''`);
  check('H4. 「该付未付合计」= 1,600.00（1000 未结 + 600 未结）',
    unselBar.includes('1,600.00'), unselBar.replace(/\s+/g, ' '));
  await shot(cdp, 'H-arap-unsettled600');

  /* ---------------- I. /payments 有 400 付款流水 ---------------- */
  await cdp.eval(`window.__V.clickText('收/付款', '.ant-menu-item')`);
  await waitFor(cdp, `window.__V.path() === '/payments'`, '/payments');
  await sleep(1500);
  const payRows = JSON.parse(await cdp.eval(`JSON.stringify(window.__V.tableRows())`));
  const flow400 = payRows.find((r) => r.includes('400.00'));
  check('I1. /payments 有 1 笔 400.00 的付款流水', Boolean(flow400), JSON.stringify(payRows));
  check('I2. 该流水收付方向 = 付', Boolean(flow400) && flow400.includes('付'),
    flow400 ? flow400.join(' | ') : '未找到');
  await shot(cdp, 'I-payments-400');

  const errToasts = await cdp.eval(`window.__V.errorToasts()`);
  check('J. 全程无错误提示（.ant-message-error = 0）', errToasts === 0, `error=${errToasts}`);
} catch (error) {
  check(`执行异常：${error.message}`, false);
  if (cdp) {
    const p = await shot(cdp, 'ZZ-exception');
    console.log(`  异常截图：${p}`);
  }
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* 忽略 */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  console.log('\n============ 打包态新功能复核汇总 ============');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  console.log(`截图目录：${SHOT_DIR}`);
  process.exit(failed.length ? 1 : 0);
}
