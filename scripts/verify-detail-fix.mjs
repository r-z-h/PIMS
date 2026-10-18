/**
 * 用真实数据验证项目详情崩溃修复（headless Edge + CDP）。
 * 前置：后端 8000 + 前端 dev 5173（VITE_USE_MOCK=false）
 * 用法：node scripts/verify-detail-fix.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000';
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

let cookie = '';
async function api(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(API + path, { ...init, headers });
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) cookie = pair;
  });
  return r.json();
}

async function pickTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 等浏览器 */ }
    await sleep(300);
  }
  throw new Error('找不到 Edge 调试目标');
}

const HELPERS = `
window.__T = {
  fill(label, value) {
    const item = [...document.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
    if (!item) throw new Error('no form item: ' + label);
    const el = item.querySelector('input, textarea');
    Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
    ).set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
};
true;`;

let edge;
let ws;
let msgId = 0;
const pending = new Map();

async function connect(cdpUrl) {
  ws = new WebSocket(cdpUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
    }
  });
}
function send(method, params = {}) {
  msgId += 1;
  const id = msgId;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r?.result?.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1200);
  await evaluate(HELPERS);
  await sleep(300);
}
async function waitFor(expr, desc, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await evaluate(expr);
      if (last) return last;
    } catch (e) { last = e.message; }
    await sleep(300);
  }
  throw new Error(`等待超时：${desc}（最后 ${JSON.stringify(last)}）`);
}

/** 用 CDP 派发真实鼠标点击（antd 下拉对合成事件不响应） */
async function clickSelectorElement(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}

try {
  /* ---- 准备：只用 Node 做一次登录拿项目清单（之后浏览器会登录，覆盖单用户会话，
   *          所以 Node 侧不要在浏览器登录之后再发需要鉴权的请求） ---- */
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: '123456' }) });
  if (login.code !== 0) throw new Error('后端登录失败：' + JSON.stringify(login));
  if (login.data.security_ready === false) {
    await api('/api/auth/security/setup', {
      method: 'POST',
      body: JSON.stringify({ questions: [
        { question: '验证问题1', answer: 'a1' },
        { question: '验证问题2', answer: 'a2' },
        { question: '验证问题3', answer: 'a3' },
      ] }),
    });
  }
  const projects = await api('/api/projects?page=1&page_size=50');
  const items = projects.data?.items ?? [];
  const target = items.find((p) => p.name.includes('宝剑山')) ?? items[0];
  if (!target) throw new Error('数据库里没有项目，无法验证详情页');
  console.log(`   [信息] 用真实项目验证：id=${target.id} name=${target.name}`);
  console.log(`   [信息] 现有项目：${items.map((p) => p.name).join(' / ')}`);
  // 记下验证前的流水条数（只读快照，之后用浏览器里的 fetch 复核）
  const fundsBefore = await api('/api/funds?page=1&page_size=200');
  const beforeCount = (fundsBefore.data?.items ?? []).length;
  console.log(`   [信息] 验证前流水条数：${beforeCount}`);

  /* ---- 启动浏览器 ---- */
  const profile = mkdtempSync(join(tmpdir(), 'pims-verify-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1680,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const t = await pickTarget();
  await connect(t.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');

  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params?.exceptionDetails?.exception?.description ?? 'unknown');
    }
  });

  /* ---- 0. 先在浏览器里真的登录（Node 侧的 Cookie 不会进浏览器） ---- */
  await goto(`${BASE}/`);
  await waitFor(`!!document.querySelector('input[type="password"]')`, '出现登录框');
  await evaluate(`(() => {
    const input = document.querySelector('input[type="password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...document.querySelectorAll('.ant-btn-primary')].find((b) => /登\\s*录/.test(b.innerText));
    button.click();
    return true;
  })()`);
  await sleep(2500);
  if ((await evaluate('location.pathname')) === '/security-setup') {
    await evaluate(HELPERS);
    for (let i = 1; i <= 3; i += 1) {
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('.ant-card-small')].find((c) =>
          (c.querySelector('.ant-card-head-title')?.innerText || '').includes('密保问题 ${i}'));
        const items = [...card.querySelectorAll('.ant-form-item')];
        const set = (el, v) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(items[0].querySelector('input'), '验证问题${i}');
        set(items[1].querySelector('input'), '验证答案${i}');
        return true;
      })()`);
    }
    await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('保存并进入系统')).click()`);
    await sleep(2500);
  }
  await waitFor(`location.pathname === '/'`, '浏览器登录后进入首页', 20000);
  check('浏览器端登录成功（用真实后端）', true);

  /* ---- 1. 直达项目详情（用户截图报错的场景） ---- */
  await goto(`${BASE}/projects/${target.id}`);
  try {
    await waitFor(`document.body.innerText.includes('项目信息')`, '详情页一览表渲染', 12000);
    check('直达项目详情页正常渲染（不再白屏）', true);
  } catch (e) {
    const diag = await evaluate(`JSON.stringify({
      path: location.pathname,
      text: document.body.innerText.slice(0, 400),
      localErrors: (window.__errs || []).slice(0, 3),
    })`);
    check('直达项目详情页正常渲染（不再白屏）', false, `${e.message} 页面=${diag}`);
    throw e;
  }

  const body = await evaluate('document.body.innerText');
  check('不再出现 Unexpected Application Error', !body.includes('Unexpected Application Error'));
  check('不再是 Cannot read properties of undefined', !body.includes('Cannot read properties of undefined'));
  check('一览表包含五个分组', ['项目信息', '预算与利润', '实际成本明细（五类）', '资金收付', '该收该付']
    .every((x) => body.includes(x)), ['项目信息', '预算与利润', '实际成本明细（五类）', '资金收付', '该收该付']
    .filter((x) => !body.includes(x)).join(',') || '全都有');
  check('显示两个利润口径', body.includes('预计利润') && body.includes('结算利润'));
  check('五类成本都在表里', ['人工', '材料', '机械', '杂费', '垫付'].every((x) => body.includes(x)));
  check('运行期无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | ') || '无');

  /* ---- 2. 「对方」可直接输入（真后端） ---- */
  const projRes = await api('/api/projects?page=1&page_size=50');
  void projRes;
  await goto(`${BASE}/ledger`);
  await waitFor(`document.body.innerText.includes('新增收款')`, '记账页渲染');
  // 先在顶部选中一个项目：收款/付款表单的「项目」来自顶部当前项目
  const openedSelect = await clickSelectorElement('.pims-header .ant-select .ant-select-selector');
  check('顶部项目选择器可点击', openedSelect);
  await sleep(900);
  const chose = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')];
    const visible = all.filter((o) => o.offsetParent !== null);
    const opt = visible.find((o) => (o.getAttribute('title') || o.innerText || '').includes('宝剑山')) ?? visible[0];
    if (!opt) return 'NO_OPTION total=' + all.length + ' visible=' + visible.length;
    const r = opt.getBoundingClientRect();
    window.__optPoint = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return 'OK';
  })()`);
  if (chose === 'OK') {
    const point = await evaluate('window.__optPoint');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  check('已选中项目（收付款表单据此带入项目）', chose === 'OK', String(chose));
  await sleep(900);
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /新\\s*增\\s*付\\s*款/.test(b.innerText));
    if (!btn) return [...document.querySelectorAll('button')].map((b) => b.innerText).join(' | ');
    btn.click();
    return true;
  })()`);
  check('找到「新增付款」按钮', opened === true, opened === true ? '' : String(opened).slice(0, 200));
  await waitFor(`!!document.querySelector('.ant-modal-content')`, '付款弹窗');
  await evaluate(`window.__T.fill('金额', '1234')`);
  const typed = `张师傅-直输不建字典-${Date.now()}`;
  await evaluate(`window.__T.fill('金额', '1234')`);
  const fillResult = await evaluate(`(() => {
    const modal = document.querySelector('.ant-modal-content');
    const items = [...modal.querySelectorAll('.ant-form-item')];
    const item = items.find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith('对方'));
    if (!item) return 'NO_PARTNER_ITEM:' + items.map((i) => (i.querySelector('.ant-form-item-label')?.innerText || '?').trim()).join(',');
    const input = item.querySelector('input');
    if (!input) return 'NO_INPUT';
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(typed)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'OK';
  })()`);
  check('「对方」是可直接输入的控件', fillResult === 'OK', String(fillResult).slice(0, 220));

  const okBtn = await evaluate(`(() => {
    const modal = document.querySelector('.ant-modal-content');
    const btns = [...modal.querySelectorAll('.ant-modal-footer button')];
    const target = btns.find((b) => /确\\s*定|保\\s*存|提\\s*交/.test(b.innerText)) || btns[btns.length - 1];
    if (!target) return 'NO_BUTTON:' + btns.map((b) => b.innerText).join('|');
    target.click();
    return 'OK';
  })()`);
  check('付款弹窗可提交', okBtn === 'OK', String(okBtn).slice(0, 220));
  await sleep(2800);
  const ledgerBody = await evaluate('document.body.innerText');
  const modalStillOpen = await evaluate(`!!document.querySelector('.ant-modal-content')`);
  const modalErrors = await evaluate(`(() => {
    const m = document.querySelector('.ant-modal-content');
    return m ? [...m.querySelectorAll('.ant-form-item-explain-error')].map((e) => e.innerText).join(' | ') : '';
  })()`);
  // 用**浏览器自己的会话**（fetch 走页面 Cookie）复核，避免 Node 会话被覆盖导致的假失败
  const verify = await evaluate(`(async () => {
    const r = await fetch('/api/funds?page=1&page_size=200', { credentials: 'include' });
    const j = await r.json();
    const list = j?.data?.items ?? [];
    const hit = list.find((f) => (f.partner ?? '').includes('张师傅-直输不建字典'));
    return { status: r.status, count: list.length, hit: hit ? { id: hit.id, partner: hit.partner, amount: hit.amount } : null };
  })()`);
  check('「对方」可直接输入任意值并保存成功', Boolean(verify?.hit),
    verify?.hit
      ? `后端已存 id=${verify.hit.id} partner=${verify.hit.partner} amount=${verify.hit.amount}`
      : `弹窗仍开=${modalStillOpen} 校验错误=${modalErrors || '无'} 流水条数=${verify?.count}(之前 ${beforeCount}) http=${verify?.status}`);

  /* ---- 3. 收尾：把刚录的这笔测试付款删掉，别留垃圾（用浏览器会话删除） ---- */
  if (verify?.hit) {
    const del = await evaluate(`(async () => {
      const r = await fetch('/api/funds/${verify.hit.id}', { method: 'DELETE', credentials: 'include' });
      const j = await r.json();
      return j.code;
    })()`);
    check('清理验证数据（删除刚录的测试付款）', del === 0, `code=${del}`);
  } else {
    check('清理验证数据（删除刚录的测试付款）', true, '没有产生数据，无需清理');
  }
} catch (e) {
  check('验证脚本异常', false, e.message);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ 真实数据验证汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
