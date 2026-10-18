/**
 * 浏览器级补充验证：成本删除 → 应付单保留（UI 提示），同时记录删除确认弹窗文案。
 * 前置同 verify-payable-browser.mjs。只读验证，不改源码。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const API = process.env.PIMS_API || 'http://127.0.0.1:8033';
const PORT = Number(process.env.PIMS_CDP_PORT || 9334);
const SHOT_DIR = process.env.PIMS_SHOT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

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
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  modal() {
    const visible = (el) => !!el && el.offsetParent !== null;
    const modals = [...document.querySelectorAll('.ant-modal-wrap')]
      .filter((m) => m.style.display !== 'none')
      .map((m) => m.querySelector('.ant-modal'))
      .filter(visible);
    return modals.length ? modals[modals.length - 1] : null;
  },
  modalText() { const m = window.__T.modal(); return m ? m.innerText : ''; },
  clickText(text, selector, root) {
    const scope = root || document;
    const nodes = [...scope.querySelectorAll(selector || 'button, a, .ant-tabs-tab, li, span')];
    const exact = nodes.find((n) => window.__T.norm(n.innerText) === window.__T.norm(text));
    const hit = exact || nodes.find((n) => window.__T.norm(n.innerText).includes(window.__T.norm(text)));
    if (!hit) throw new Error('clickable not found: ' + text);
    hit.click();
    return true;
  },
  rowButton(rowText, btnText) {
    const row = [...document.querySelectorAll('.ant-table-tbody tr')]
      .find((tr) => window.__T.norm(tr.innerText).includes(window.__T.norm(rowText)));
    if (!row) throw new Error('row not found: ' + rowText);
    const btn = [...row.querySelectorAll('button')]
      .find((b) => window.__T.norm(b.innerText) === window.__T.norm(btnText));
    if (!btn) throw new Error('row button not found: ' + btnText);
    btn.click();
    return true;
  },
  modalFooterButton(text) {
    const m = window.__T.modal();
    if (!m) throw new Error('no modal');
    const btn = [...m.querySelectorAll('.ant-modal-footer button, .ant-modal-confirm-btns button')]
      .find((b) => window.__T.norm(b.innerText) === window.__T.norm(text));
    if (!btn) throw new Error('footer button not found: ' + text);
    btn.click();
    return true;
  },
  tab(name) {
    const t = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => window.__T.norm(x.innerText) === window.__T.norm(name));
    if (!t) throw new Error('tab not found: ' + name);
    t.click();
    return true;
  },
  tableText() { return [...document.querySelectorAll('.ant-table')].map((t) => t.innerText).join('\\n'); },
  setLs(key, value) { localStorage.setItem(key, value); return true; },
};
true;
`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
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
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(700); }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(SHOT_DIR, name);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, desc, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await cdp.eval(expression); if (last) return last; } catch (e) { last = e.message; }
    await sleep(250);
  }
  throw new Error(`等待超时：${desc}（最后结果 ${JSON.stringify(last)}）`);
}
async function gotoAndInject(cdp, url) {
  await cdp.goto(url); await sleep(900); await cdp.eval(HELPERS);
  await waitFor(cdp, `typeof window.__T === 'object'`, '辅助脚本注入');
}

let sessionCookie = '';
async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (sessionCookie) headers.Cookie = sessionCookie;
  const r = await fetch(API + path, { ...init, headers });
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) sessionCookie = pair;
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let edge; let cdp;
try {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (login.body?.code !== 0) throw new Error('API 登录失败：' + JSON.stringify(login.body));
  const login2 = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (login2.body.data.security_ready === false) {
    await api('/api/auth/security/setup', {
      method: 'POST',
      body: JSON.stringify({ questions: [
        { question: '联调问题1', answer: '联调答案1' },
        { question: '联调问题2', answer: '联调答案2' },
        { question: '联调问题3', answer: '联调答案3' }] }),
    });
  }
  const stamp = Date.now().toString().slice(-6);
  const projName = `删除验证项目${stamp}`;
  const proj = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: projName, client_budget: 100000, cost_budget: 90000 }) });
  const pid = proj.body.data.id;
  await api('/api/dict', { method: 'POST', body: JSON.stringify({ dict_type: 'misc_category', name: '伙食费' }) });
  const cost = await api('/api/costs/misc', {
    method: 'POST',
    body: JSON.stringify({ project_id: pid, category: '伙食费', amount: 800, biz_date: '2026-10-15', remark: '待删除' }),
  });
  const costId = cost.body.data.cost_id;
  console.log(`   [信息] 项目 id=${pid}，预置杂费 cost_id=${costId} amount=800`);

  const profile = mkdtempSync(join(tmpdir(), 'pims-edge-del-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1680,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 等 Edge */ }
    if (!target) await sleep(300);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await gotoAndInject(cdp, BASE + '/');
  await waitFor(cdp, `window.__T.path() === '/login'`, '登录页');
  await cdp.eval(`window.__T.setInput(document.querySelector('input[type=password]'), '123456')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/' || window.__T.has('项目盈亏总表') || window.__T.path() === '/security-setup'`, '进入系统', 25000);
  check('C0 真浏览器登录成功', true, await cdp.eval(`window.__T.path()`));

  await cdp.eval(`window.__T.setLs('pims.current_project_id', '${pid}')`);
  await cdp.eval(`window.__T.setLs('pims.date_range', JSON.stringify({ start_date: '2026-01-01', end_date: '2026-12-31' }))`);
  await gotoAndInject(cdp, BASE + '/bookkeeping');
  await cdp.eval(`window.__T.tab('杂费')`);
  await waitFor(cdp, `window.__T.tableText().includes('800.00')`, '杂费列表出现预置成本', 25000);
  await cdp.eval(`window.__T.rowButton('800.00', '删除')`);
  await waitFor(cdp, `window.__T.modalText().includes('删除这条成本记录')`, '删除确认弹窗');
  const confirmText = await cdp.eval(`window.__T.modalText()`);
  const confirmShot = await cdp.shot('10-删除确认弹窗.png');
  check('C1 删除前提示「应付单不会被删除，会保留在往来页」', /应付单[\s\S]*不会被删除[\s\S]*保留/.test(confirmText),
    confirmText.replace(/\n/g, ' / '));
  check('C1b [文案缺陷] 提示里出现 Markdown 星号原文（**不会被删除**）', confirmText.includes('**不会被删除**'),
    (confirmText.match(/\*\*[^*]*\*\*/) || ['未出现'])[0] + '（截图 ' + confirmShot + '）');

  await cdp.eval(`window.__T.modalFooterButton('删除')`);
  const kept = await waitFor(cdp, `window.__T.modalText().includes('成本已删除，但应付单已保留') ? window.__T.modalText() : false`, '删除后「应付单已保留」提示', 20000);
  const keptShot = await cdp.shot('11-删除后应付单保留提示.png');
  check('C2 删除成本后弹出「成本已删除，但应付单已保留」并给出应付单号', /应付单\s*#\d+\s*已保留/.test(kept),
    kept.replace(/\n/g, ' / ').slice(0, 200) + '（截图 ' + keptShot + '）');
  await cdp.eval(`window.__T.modalFooterButton('知道了')`);
  await sleep(800);

  await gotoAndInject(cdp, BASE + '/arap');
  await cdp.eval(`window.__T.tab('应付单')`);
  const arapRow = await waitFor(cdp, `window.__T.tableText().includes('800.00') ? window.__T.tableText() : false`, '应付单仍在往来页', 25000).catch(() => '');
  const shot3 = await cdp.shot('12-删除后应付单仍在.png');
  check('C3 删除成本后应付单仍在 /arap 应付单页签（未结 800.00）',
    String(arapRow).includes('800.00'), String(arapRow).split('\n').filter((l) => l.includes('800.00')).join(' ; ').slice(0, 160) + '（截图 ' + shot3 + '）');
} catch (e) {
  check('补充验证脚本异常', false, e.message);
  if (cdp) console.log('   [失败截图] ' + (await cdp.shot('97-补充验证异常.png').catch(() => '无法截图')));
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 删除保留（浏览器）汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
