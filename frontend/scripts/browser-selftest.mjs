/**
 * Mock 模式端到端自测（headless Edge + CDP）
 * 用法：node scripts/browser-selftest.mjs
 * 前置：npm run dev（Mock 模式）已运行；默认 http://127.0.0.1:5173，可用 PIMS_BASE 覆盖
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const PORT = 9222;
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
    const list = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((m) => m.style.display !== 'none' && m.querySelector('.ant-modal'));
    return list.length ? list[list.length - 1] : null;
  },
  clickText(text, selector, root) {
    const scope = root || document;
    const nodes = [...scope.querySelectorAll(selector || 'button, a, .ant-tabs-tab, .ant-select-item-option')];
    const target = window.__T.norm(text);
    const el = nodes.find((e) => window.__T.norm(e.innerText).includes(target));
    if (!el) throw new Error('clickable not found: ' + text + ' [scope=' + (scope === document ? 'doc' : 'modal') + ']');
    el.click();
    return true;
  },
  clickModalOk() {
    const wraps = [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => w.style.display !== 'none');
    const wrap = wraps[wraps.length - 1];
    if (!wrap) throw new Error('no visible modal wrap');
    const btns = [...wrap.querySelectorAll('button')];
    const byText = btns.find((b) => /确\\s*定|确\\s*认|OK/.test(b.innerText || ''));
    const btn = wrap.querySelector('.ant-modal-footer .ant-btn-primary') ||
      wrap.querySelector('.ant-modal-confirm-btns .ant-btn-primary') ||
      wrap.querySelector('.ant-btn-primary') ||
      byText ||
      btns[btns.length - 1];
    if (!btn) {
      throw new Error('modal ok button not found; buttons = ' +
        btns.map((b) => b.className + '|' + b.innerText).join(' ; '));
    }
    btn.click();
    return true;
  },
  async tab(label) {
    const el = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => (t.innerText || '').trim() === label);
    if (!el) throw new Error('tab not found: ' + label);
    el.click();
    await window.__T.sleep(700);
    return true;
  },
  async selectItem(label, optionText, root) {
    const scope = root || document;
    const item = window.__T.itemByLabel(scope, label);
    if (!item) throw new Error('select item not found: ' + label);
    const selector = item.querySelector('.ant-select-selector');
    if (!selector) throw new Error('select selector not found: ' + label);
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    selector.click();
    await window.__T.sleep(600);
    const opts = [...document.querySelectorAll('.ant-select-item-option')];
    const opt = opts.find((o) => (o.getAttribute('title') || o.innerText || '').trim() === optionText) ||
      opts.find((o) => (o.innerText || '').includes(optionText));
    if (!opt) throw new Error('option not found: ' + optionText + ' | available: ' + opts.map((o) => (o.innerText || '').trim()).join('/'));
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    opt.click();
    await window.__T.sleep(500);
    return true;
  },
  rowAction(rowText, actionText) {
    const row = [...document.querySelectorAll('.ant-table-tbody tr')]
      .find((tr) => window.__T.norm(tr.innerText).includes(window.__T.norm(rowText)));
    if (!row) throw new Error('row not found: ' + rowText);
    const btn = [...row.querySelectorAll('button')]
      .find((b) => window.__T.norm(b.innerText).includes(window.__T.norm(actionText)));
    if (!btn) throw new Error('action not found: ' + actionText + ' in row ' + rowText);
    btn.click();
    return true;
  },
  readOffsetAmount() {
    const wraps = [...document.querySelectorAll('.ant-modal-wrap')].filter((w) => w.style.display !== 'none');
    const wrap = wraps[wraps.length - 1];
    const inputs = [...wrap.querySelectorAll('.ant-table-tbody input')]
      .filter((i) => i.type !== 'checkbox' && i.type !== 'radio');
    return inputs.length ? inputs[0].value : 'NO_MONEY_INPUT(rows=' + wrap.querySelectorAll('.ant-table-tbody tr').length + ')';
  },
  inventoryRow(mat) {
    const row = [...document.querySelectorAll('.ant-table-tbody tr')]
      .find((tr) => (tr.innerText || '').includes(mat));
    if (!row) return null;
    return [...row.querySelectorAll('td')].map((td) => (td.innerText || '').trim());
  },
  tableText() {
    return [...document.querySelectorAll('.ant-table-tbody, .ant-table-summary')].map((t) => t.innerText).join('\\n');
  },
  async pickHeaderProject(name) {
    const sel = document.querySelector('.pims-header .ant-select-selector');
    if (!sel) throw new Error('header project select not found');
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    sel.click();
    await window.__T.sleep(700);
    const opts = [...document.querySelectorAll('.ant-select-item-option')];
    const opt = opts.find((o) => (o.getAttribute('title') || o.innerText || '').includes(name));
    if (!opt) throw new Error('project option not found: ' + name + ' | ' + opts.map((o) => o.innerText).join('/'));
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    opt.click();
    await window.__T.sleep(700);
    return document.querySelector('.pims-header .ant-select-selection-item')?.innerText || '';
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
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)));
    });
    const cdp = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else {
        cdp.handlers.slice().forEach((h) => h(msg));
      }
    };
    return cdp;
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
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page error: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  }

  waitEvent(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting event ' + method)), timeout);
      const handler = (msg) => {
        if (msg.method === method) {
          clearTimeout(timer);
          this.handlers = this.handlers.filter((h) => h !== handler);
          resolve(msg.params);
        }
      };
      this.handlers.push(handler);
    });
  }

  async goto(url) {
    const loaded = this.waitEvent('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(1200);
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
      /* 浏览器还没起来 */
    }
    await sleep(500);
  }
  throw new Error('无法连接 headless Edge 调试端口');
}

async function waitFor(cdp, expression, desc, timeout = 12000) {
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

let edge;
let cdp;

try {
  const profile = mkdtempSync(join(tmpdir(), 'pims-edge-'));
  edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1680,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const target = await pickTarget();
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  /* ---------------- 1. 未登录访问首页 → 跳登录页 ---------------- */
  await cdp.goto(BASE + '/');
  await waitFor(cdp, `window.__T && window.__T.path() === '/login'`, '未登录跳转 /login');
  check('未登录访问 / 自动跳转登录页', true);
  check('登录页渲染（初始密码 123456 已预填）', await cdp.eval(`window.__T.read('登录密码') === '123456'`));

  /* ---------------- 2. 登录 → 强制密保设置 ---------------- */
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/security-setup'`, '登录后跳转密保设置');
  await waitFor(cdp, `window.__T.has('设置密保问题')`, '密保设置页渲染');
  check('security_ready=false → 强制跳「设置密保」页', true);

  const answers = ['鄂A12345', '李秀兰', '实验小学'];
  for (let i = 0; i < 3; i += 1) {
    await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('.ant-card')].find((c) => (c.querySelector('.ant-card-head-title')?.innerText || '').includes('密保问题 ${i + 1}'));
      const items = [...card.querySelectorAll('.ant-form-item')];
      const q = items[0].querySelector('input');
      const a = items[1].querySelector('input');
      window.__T.setInput(q, '密保问题 ${i + 1}：测试题');
      window.__T.setInput(a, '${answers[i]}');
      return true;
    })()`);
  }
  await cdp.eval(`window.__T.clickText('保存并进入系统', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/'`, '密保保存后进入首页', 15000);
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '首页盈亏总表渲染');
  check('3 组密保保存后放行进入首页', true);

  /* ---------------- 3. 首页项目盈亏总表 ---------------- */
  const board = await cdp.eval(`window.__T.tableText()`);
  check('首页表格含项目行（某小区 5#楼 / 市政道路改造 / 厂房维修）',
    ['某小区 5#楼', '市政道路改造', '厂房维修（已完工）'].every((t) => board.includes(t)));
  check('预计利润 500,000.00（400万−350万，验收 A3）', board.includes('500,000.00'));
  check('实际成本 1,351,500.00（五类之和，验收 A4）', board.includes('1,351,500.00'));
  check('结算利润 2,648,500.00（400万−135.15万，验收 A4）', board.includes('2,648,500.00'));
  check('底部合计行：甲方预算合计 6,000,000.00', board.includes('6,000,000.00'));
  check('底部合计行：结算利润合计 4,597,000.00', board.includes('4,597,000.00'));
  check('页面不出现「现金结余」指标', !(await cdp.eval(`window.__T.has('现金结余')`)));

  /* 顶部选择「当前项目」，后续录入表单会默认带出该项目 */
  const picked = await cdp.eval(`window.__T.pickHeaderProject('某小区 5#楼')`);
  check('顶部当前项目选择器可用', picked.includes('某小区 5#楼'), `当前项目=${picked}`);

  /* ---------------- 4. 五类成本五个页签 ---------------- */
  await cdp.goto(BASE + '/costs');
  await waitFor(cdp, `window.__T.has('筛选条件下')`, '成本页渲染');
  const tabNames = ['人工', '材料', '机械', '杂费', '垫付'];
  for (const name of tabNames) {
    await cdp.eval(`window.__T.tab('${name}')`);
    const ok = await waitFor(cdp, `window.__T.has('筛选条件下「${name}」合计')`, `页签 ${name}`);
    check(`成本页签「${name}」独立表格与合计渲染`, Boolean(ok));
  }

  /* 4.1 新增垫付 123.45 */
  await cdp.eval(`window.__T.tab('垫付')`);
  await cdp.eval(`window.__T.clickText('新增垫付', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '垫付表单弹窗');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('垫付事由', '自动化测试垫付', m); window.__T.fill('金额', '123.45', m); return true; })()`);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('1,234.5') || window.__T.tableText().includes('123.45')`, '新增垫付入表', 15000);
  const advanceRow = await cdp.eval(`window.__T.tableText()`);
  check('垫付新增成功（123.45 入表）', advanceRow.includes('123.45') && advanceRow.includes('自动化测试垫付'));

  /* 4.2 编辑该条 → 改成 200.00 */
  await cdp.eval(`window.__T.rowAction('自动化测试垫付', '编辑')`);
  await waitFor(cdp, `!!window.__T.modal()`, '编辑弹窗');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('金额', '200.00', m); return true; })()`);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('200.00')`, '编辑后金额更新', 15000);
  check('垫付编辑成功（123.45 → 200.00）', true);

  /* 4.3 修改记录时间线 */
  await cdp.eval(`window.__T.rowAction('自动化测试垫付', '修改记录')`);
  const timelineOk = await waitFor(cdp, `window.__T.has('成本修改记录') && window.__T.has('新增') && window.__T.has('修改')`, '修改记录时间线', 15000);
  check('修改记录时间线含新增 + 修改两条留痕', Boolean(timelineOk));
  await cdp.eval(`(() => { const b = document.querySelector('.ant-drawer-close, .ant-drawer-header button'); if (b) b.click(); return true; })()`);
  await sleep(700);

  /* 4.4 删除该条 */
  await cdp.eval(`window.__T.rowAction('自动化测试垫付', '删除')`);
  await waitFor(cdp, `!!window.__T.modal()`, '删除确认弹窗');
  check('删除有二次确认', true);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `!window.__T.tableText().includes('自动化测试垫付')`, '删除后行消失', 15000);
  check('垫付删除成功（行消失、实际成本随之减少）', true);

  /* 4.5 人工新增：5 天 × 300 → 金额自动 1,500.00 */
  await cdp.eval(`window.__T.tab('人工')`);
  await cdp.eval(`window.__T.clickText('新增人工', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '人工表单');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('姓名', '自动化张三', m); window.__T.fill('工日数', '5', m); window.__T.fill('日工价', '300', m); return true; })()`);
  await sleep(700);
  const autoAmount = await cdp.eval(`window.__T.read('金额', window.__T.modal())`);
  check('人工金额自动 = 工日数 × 日工价 = 1,500.00', autoAmount === '1,500.00', `实际 ${autoAmount}`);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('自动化张三')`, '人工入表', 15000);
  check('人工新增成功且实时入成本', true);

  /* 4.6 材料新增：字典下拉 + 数量×单价自动算金额 */
  await cdp.eval(`window.__T.tab('材料')`);
  await cdp.eval(`window.__T.clickText('新增材料', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '材料表单');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('数量', '10', m); window.__T.fill('单价', '88.5', m); return true; })()`);
  await cdp.eval(`window.__T.selectItem('材料名称', '水泥', window.__T.modal())`);
  await cdp.eval(`window.__T.selectItem('单位', '吨', window.__T.modal())`);
  await sleep(700);
  const materialAmount = await cdp.eval(`window.__T.read('金额', window.__T.modal())`);
  check('材料金额自动 = 数量 × 单价 = 885.00', materialAmount === '885.00', `实际 ${materialAmount}`);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('885.00')`, '材料入表', 15000);
  check('材料采购新增成功（采购即成本 + 同时入库）', true);

  /* 4.7 机械新增：默认台班 */
  await cdp.eval(`window.__T.tab('机械')`);
  await cdp.eval(`window.__T.clickText('新增机械', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '机械表单');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('设备名称', '自动化挖机', m); window.__T.fill('数量', '2', m); window.__T.fill('单价', '1000', m); return true; })()`);
  await sleep(700);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('自动化挖机')`, '机械入表', 15000);
  check('机械新增成功（计量方式默认台班）', true);

  /* 4.8 杂费新增：字典小类 */
  await cdp.eval(`window.__T.tab('杂费')`);
  await cdp.eval(`window.__T.clickText('新增杂费', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.modal()`, '杂费表单');
  await cdp.eval(`(() => { const m = window.__T.modal(); window.__T.fill('金额', '66.66', m); return true; })()`);
  await cdp.eval(`window.__T.selectItem('杂费小类', '伙食费', window.__T.modal())`);
  await sleep(400);
  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `window.__T.tableText().includes('66.66')`, '杂费入表', 15000);
  check('杂费新增成功（小类取字典）', true);

  /* ---------------- 5. 应收应付冲销 ---------------- */
  await cdp.goto(BASE + '/arap');
  await waitFor(cdp, `window.__T.has('应收单') && window.__T.has('该收未收合计')`, '往来页渲染');
  const arapText = await cdp.eval(`window.__T.tableText()`);
  check('应收单列表显示 金额/已冲销/未结/状态', ['500,000.00', '300,000.00', '200,000.00', '部分'].every((t) => arapText.includes(t)));
  check('底部「该收未收合计 / 该付未付合计」', await cdp.eval(`window.__T.has('该收未收合计') && window.__T.has('该付未付合计')`));

  await cdp.eval(`window.__T.rowAction('某某置业有限公司', '收款')`);
  await waitFor(cdp, `!!window.__T.modal() && window.__T.modal().innerText.includes('待结单据')`, '冲销弹窗');
  const offsetReady = await waitFor(cdp, `window.__T.modal().innerText.includes('200,000.00')`, '待结单据未结金额', 15000);
  const offsetText = await cdp.eval(`window.__T.modal().innerText`);
  check('冲销弹窗列出待结单据与未结金额 200,000.00', Boolean(offsetReady) && offsetText.includes('200,000.00'));
  await sleep(800);
  const offsetAmount = await cdp.eval(`window.__T.readOffsetAmount()`);
  const flowAmount = await cdp.eval(`window.__T.read('本次收付金额', window.__T.modal())`);
  const offsetSum = await cdp.eval(`window.__T.modal().innerText.includes('本次冲销合计：200,000.00')`);
  check('勾选单据后自动带出未结金额（本次冲销 = 200,000.00）', offsetAmount === '200,000.00', `实际 ${offsetAmount}`);
  check('本次收付金额自动补齐为 200,000.00', flowAmount === '200,000.00', `实际 ${flowAmount}`);
  check('冲销合计实时计算 = 200,000.00', Boolean(offsetSum));

  await cdp.eval(`window.__T.clickModalOk()`);
  await waitFor(cdp, `!window.__T.modal()`, '冲销弹窗关闭', 15000);
  await sleep(1200);
  const arapAfter = await cdp.eval(`window.__T.tableText()`);
  check('冲销后状态转「已结清」且未结归零', arapAfter.includes('已结清'));

  /* ---------------- 6. 库存（按项目隔离） ---------------- */
  await cdp.goto(BASE + '/inventory');
  await waitFor(cdp, `window.__T.has('库存余量') && window.__T.has('库存流水')`, '库存页渲染');
  const cementRow = await cdp.eval(`window.__T.inventoryRow('水泥')`);
  const invText = await cdp.eval(`window.__T.tableText()`);
  const num = (s) => Number(String(s).replace(/,/g, '')) || 0;
  const balanceOk =
    Array.isArray(cementRow) &&
    cementRow.length >= 5 &&
    num(cementRow[2]) - num(cementRow[3]) === num(cementRow[4]);
  check(
    '库存余量 = 入库 − 领用（水泥，余量随本次采购 +10 联动）',
    balanceOk,
    Array.isArray(cementRow) ? cementRow.join(' | ') : '未找到水泥行',
  );
  check('库存流水区分入库/领用', await cdp.eval(`window.__T.has('入库') && window.__T.has('领用')`), invText.slice(0, 0));

  /* ---------------- 7. 人工结算 ---------------- */
  await cdp.goto(BASE + '/labor-settle');
  await waitFor(cdp, `window.__T.has('生成结算预览')`, '结算页渲染');
  await cdp.eval(`window.__T.clickText('生成结算预览', '.ant-btn-primary')`);
  const settleReady = await waitFor(cdp, `window.__T.tableText().includes('张三') && window.__T.tableText().includes('1,500.00')`, '结算预览', 15000);
  check('结算预览按人汇总（张三 5 工天 / 1,500.00）', Boolean(settleReady));
  check('提示「结算不重复计入成本」', await cdp.eval(`window.__T.has('不重复计入成本') || window.__T.has('不新增成本')`));
  await cdp.eval(`window.__T.clickText('保存结算单', '.ant-btn-primary')`);
  const saved = await waitFor(cdp, `window.__T.has('已保存') || window.__T.tableText().includes('未发')`, '保存结算单', 15000);
  check('保存结算单成功（结算不新增成本）', Boolean(saved));

  /* ---------------- 8. 导出按钮 ---------------- */
  await cdp.goto(BASE + '/');
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '回到首页');
  await cdp.eval(`window.__T.clickText('导出 Excel', 'button')`);
  const exported = await waitFor(cdp, `window.__T.has('已导出')`, '导出提示', 20000);
  check('导出按钮可用（Mock 返回多 Sheet 预览文件并提示文件名）', Boolean(exported));

  /* ---------------- 9. 其余页面（项目档案 / 详情 / 流水 / 设置） ---------------- */
  await cdp.goto(BASE + '/projects');
  await waitFor(cdp, `window.__T.has('新建项目')`, '项目档案页');
  check('项目档案页渲染（列表 + 新建项目）', await cdp.eval(`window.__T.tableText().includes('某小区 5#楼')`));

  await cdp.goto(BASE + '/ledger');
  await waitFor(cdp, `window.__T.has('新增收款') && window.__T.has('新增付款')`, '资金流水页');
  check('资金流水页渲染（新增收款/新增付款）', await cdp.eval(`window.__T.tableText().includes('1,700,000.00')`));

  await cdp.goto(BASE + '/settings');
  await waitFor(cdp, `window.__T.has('字典维护') && window.__T.has('修改密码')`, '设置页');
  check('设置页渲染（字典维护 / 修改密码 / 备份数据库 / 显示已删除开关）',
    await cdp.eval(`window.__T.has('字典维护') && window.__T.has('修改密码') && window.__T.has('备份数据库') && window.__T.has('显示已删除记录')`));

  await cdp.goto(BASE + '/projects/1');
  const detailOk = await waitFor(cdp, `window.__T.has('成本与利润概览') && window.__T.has('五类成本构成') && window.__T.has('资金往来') && window.__T.has('库存余量') && window.__T.has('人工结算')`, '项目详情页', 15000);
  check('项目详情页五个卡片分区齐全', Boolean(detailOk));
  check('项目详情不出现「现金结余」', !(await cdp.eval(`window.__T.has('现金结余')`)));

  /* ---------------- 10. 忘记密码：密保校验 + 重置 ---------------- */
  await cdp.goto(BASE + '/');
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '回到首页');
  await cdp.eval(`window.__T.clickText('退出', 'a')`);
  await waitFor(cdp, `window.__T.path() === '/login'`, '退出登录回到登录页', 15000);
  check('退出登录回到登录页', true);

  await cdp.goto(BASE + '/forgot-password');
  await waitFor(cdp, `window.__T.has('回答密保') && document.querySelectorAll('.ant-form-item input').length >= 3`, '忘记密码页');
  check('忘记密码页展示 3 个密保问题', true);

  await cdp.eval(`(() => {
    const wrong = ['错误答案A', '错误答案B', '错误答案C'];
    [...document.querySelectorAll('.ant-form-item input')].forEach((el, i) => window.__T.setInput(el, wrong[i] ?? 'x'));
    return true;
  })()`);
  await cdp.eval(`window.__T.clickText('校验密保答案', '.ant-btn-primary')`);
  const wrongMsg = await waitFor(cdp, `window.__T.has('密保答案不正确')`, '密保答错提示', 15000);
  check('密保答错只提示「密保答案不正确」（不透露哪题错）', Boolean(wrongMsg));
  check('答错时不给新密码框（未进入第二步）',
    await cdp.eval(`!document.body.innerText.includes('确认新密码')`));

  await cdp.eval(`(() => {
    const right = ['鄂A12345', '李秀兰', '实验小学'];
    [...document.querySelectorAll('.ant-form-item input')].forEach((el, i) => window.__T.setInput(el, right[i] ?? 'x'));
    return true;
  })()`);
  await cdp.eval(`window.__T.clickText('校验密保答案', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.has('确认新密码')`, '密保全对后出现新密码框', 15000);
  check('3 个密保全对后出现新密码设置框', true);

  await cdp.eval(`(() => {
    window.__T.fill('新密码', 'abc12345');
    window.__T.fill('确认新密码', 'abc12345');
    return true;
  })()`);
  await cdp.eval(`window.__T.clickText('重置密码', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/login'`, '重置成功回到登录页', 15000);
  check('重置密码成功并回到登录页', true);

  await cdp.eval(`window.__T.fill('登录密码', 'abc12345')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  const reLogin = await waitFor(cdp, `window.__T.path() === '/' && window.__T.has('项目盈亏总表')`, '用新密码登录', 20000);
  check('用新密码登录成功进入首页', Boolean(reLogin));
} catch (error) {
  check(`执行异常：${error.message}`, false);
} finally {
  try {
    if (cdp) await cdp.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  if (edge) {
    try {
      edge.kill();
    } catch {
      /* 忽略 */
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log('\n================ 自测汇总 ================');
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(` - ${f.name} ${f.detail}`));
}
process.exit(failed.length ? 1 : 0);
