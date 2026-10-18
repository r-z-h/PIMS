/**
 * 真后端 + 真浏览器验证「结算接账 + 往来跳转」（需求 T6 / T7 / T8）。
 *
 * 与 mock 版测试的区别：这里连的是真 FastAPI + SQLite，
 * 确保后端 labor_service 的联动（生成流水 / 冲销应付单）与前端跳转在真实环境下都对。
 *
 * 用法（后端与前端 dev server 都起好后）：
 *   PIMS_BASE=http://127.0.0.1:5173 PIMS_API=http://127.0.0.1:8033 \
 *   node scripts/checks/verify-settle-link.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:5173';
const API = process.env.PIMS_API || 'http://127.0.0.1:8033';
const PORT = Number(process.env.PIMS_CDP_PORT || 9241);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

let cookie = '';
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) cookie = pair;
  });
  return r.json();
}

let edge;
let ws;
let id = 0;
const pending = new Map();
async function connect(url) {
  ws = new WebSocket(url);
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
  id += 1;
  const cur = id;
  return new Promise((resolve) => {
    pending.set(cur, { resolve });
    ws.send(JSON.stringify({ id: cur, method, params }));
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r?.result?.value;
}
async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1800);
}
async function text() {
  return ev('document.body.innerText');
}
/** 等某个文本出现 */
async function waitText(needle, label, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await text()).includes(needle)) return true;
    await sleep(400);
  }
  throw new Error(`等待「${label ?? needle}」超时`);
}
/** 点包含指定文本的按钮 */
async function clickButton(label) {
  const ok = await ev(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const hit = btns.find((b) => (b.innerText || '').replace(/\\s+/g, '').includes(${JSON.stringify(label.replace(/\s+/g, ''))}));
    if (!hit || hit.disabled) return false;
    hit.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到可点击的按钮：${label}`);
  await sleep(900);
}
/** 点 antd 页签（不是 button，得单独处理） */
async function clickTab(label) {
  const ok = await ev(`(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, '');
    const hit = [...document.querySelectorAll('.ant-tabs-tab')].find((el) => norm(el.innerText).includes(norm(${JSON.stringify(label)})));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到页签：${label}`);
  await sleep(900);
}
/** 在带 label 的 form-item 里填值（受 React 控制，需用 native setter） */
async function fillField(label, value, scope = 'document') {
  const ok = await ev(`(() => {
    const root = ${scope};
    const setV = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const items = [...root.querySelectorAll('.ant-form-item')];
    const hit = items.find((it) => (it.querySelector('.ant-form-item-label')?.innerText || '').replace(/\\s+/g, '').includes(${JSON.stringify(label.replace(/\s+/g, ''))}));
    if (!hit) return false;
    const input = hit.querySelector('input, textarea');
    if (!input) return false;
    setV(input, ${JSON.stringify(String(value))});
    return true;
  })()`);
  if (!ok) throw new Error(`找不到输入项：${label}`);
  await sleep(250);
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

async function main() {
  // ---------- 准备数据（走真后端接口） ----------
  const login = await api('POST', '/api/auth/login', { password: '123456' });
  if (login.code !== 0) throw new Error('登录失败：' + JSON.stringify(login));
  const setup = await api('POST', '/api/auth/security/setup', {
    questions: [
      { question: '联调问题1', answer: '联调答案1' },
      { question: '联调问题2', answer: '联调答案2' },
      { question: '联调问题3', answer: '联调答案3' },
    ],
  });
  check('真后端就绪（登录 + 密保）', setup.code === 0 || String(setup.message).includes('已设置'), setup.message);

  const proj = await api('POST', '/api/projects', {
    name: '结算联调项目',
    client_budget: 1_000_000,
    cost_budget: 800_000,
  });
  const projectId = proj.data.id;
  const worker = '联调张三';
  const labor = await api('POST', '/api/costs/labor', {
    project_id: projectId,
    worker_name: worker,
    work_days: 4,
    day_rate: 250,
    biz_date: '2026-10-01',
  });
  check('录一笔人工（4 工天 × 250 = 1000）', labor.code === 0, `cost_id=${labor.data?.cost_id}`);

  const payables = await api('GET', `/api/arap?project_id=${projectId}&type=payable`);
  const payable = (payables.data?.items ?? []).find((p) => p.biz_type === 'labor');
  check('自动生成人工费应付单（1000 未结）', Boolean(payable) && Number(payable.unsettled) === 1000,
    `arap_id=${payable?.id} unsettled=${payable?.unsettled}`);

  // ---------- 浏览器：往来页应显示「去结算」 ----------
  const profile = mkdtempSync(join(tmpdir(), 'pims-settle-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const t = await pickTarget();
  await connect(t.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  await goto(BASE + '/');
  await sleep(1500);
  // 关键：后端是**单会话**的，浏览器从这里登录会顶掉脚本 API 的会话。
  // 所以只让**浏览器**登录一次，然后把它的会话 cookie 接过来给脚本用，
  // 不再调用 /api/auth/login（否则会把浏览器的会话顶掉）。
  await fillField('登录密码', '123456').catch(async () => {
    await ev(`(() => {
      const i = document.querySelector('input[type="password"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '123456');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  });
  await clickButton('登录');
  await sleep(2500);
  if ((await ev('location.pathname')) === '/security-setup') {
    for (let n = 1; n <= 3; n += 1) {
      await ev(`(() => {
        const card = [...document.querySelectorAll('.ant-card-small')].find((c) =>
          (c.querySelector('.ant-card-head-title')?.innerText || '').includes('密保问题 ${n}'));
        const items = [...card.querySelectorAll('.ant-form-item')];
        const set = (el, v) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(items[0].querySelector('input'), '联调问题${n}');
        set(items[1].querySelector('input'), '联调答案${n}');
        return true;
      })()`);
    }
    await clickButton('保存并进入系统');
    await sleep(2500);
  }
  check('真浏览器登录进入系统', (await ev('location.pathname')) === '/');

  // 把浏览器的会话接到脚本上（后续 api() 都用这个 cookie）。
  // 注意：会话 cookie 是 HttpOnly 的，document.cookie 读不到，必须走 CDP 的 Network.getCookies。
  const cookieList = await send('Network.getCookies', { urls: [BASE] });
  const session = (cookieList?.cookies ?? []).find((c) => c.name === 'pims_session');
  if (session) cookie = `${session.name}=${session.value}`;
  check(
    '脚本复用浏览器会话（避免单会话互顶）',
    Boolean(session),
    session ? '' : `取到的 cookie：${(cookieList?.cookies ?? []).map((c) => c.name).join(',') || '（空）'}`,
  );

  await goto(BASE + '/arap');
  await clickTab('应付单');
  await sleep(1200);
  const arapText = await text();
  check('往来页能查到该人工费应付单', arapText.includes(worker), arapText.includes(worker) ? '' : arapText.slice(0, 120));
  check('T8 人工费行的按钮是「去结算」', arapText.includes('去结算'));

  // ---------- 点「去结算」应跳到结算页并定位到该工人 ----------
  await clickButton('去结算');
  await sleep(2500);
  const url = await ev('location.href');
  check('T7 跳到结算页', url.includes('/labor-settle'), url);
  const settleText = await text();
  check('T8 提示已定位到该工人', settleText.includes(`已从「往来」跳到 ${worker}`));

  // ---------- 结算：生成预览 → 保存 → 登记发放 ----------
  await clickButton('生成结算预览');
  await waitText(worker, '预览出现该工人');
  await clickButton('保存结算单');
  await sleep(2000);
  const afterSave = await text();
  check('保存结算单成功', afterSave.includes(worker) && !afterSave.includes('暂未结算单'), '');
  check('发放前仍未发 1,000', afterSave.includes('1,000.00'));

  await clickButton('登记发放');
  await sleep(1200);
  let filled = await fillField('本次发放金额', '1000').then(() => true).catch(() => false);
  if (!filled) filled = await fillField('发放金额', '1000').then(() => true).catch(() => false);
  if (!filled) throw new Error('发放弹窗里找不到金额输入框');
  await clickButton('确定');
  await sleep(2500);

  const resultText = await text();
  check('T6 发放后提示已生成付款流水并冲销应付单', resultText.includes('已冲销对应应付单') || resultText.includes('付款流水'),
    resultText.includes('已冲销对应应付单') ? '' : resultText.slice(0, 160));
  await clickButton('知道了').catch(() => undefined);
  await sleep(800);

  // ---------- 接口侧交叉核对 ----------
  const flowList = await api('GET', `/api/funds?project_id=${projectId}&direction=out`);
  const flow = (flowList.data?.items ?? []).find((f) => f.biz_type === 'labor');
  check('T6 生成了付款流水（人工费 / 对方=工人 / 1000）',
    Boolean(flow) && Number(flow.amount) === 1000 && flow.partner === worker,
    `flow_id=${flow?.id} partner=${flow?.partner}`);
  check('T6 流水已冲销 1000', Number(flow?.offset_amount) === 1000, `offset=${flow?.offset_amount}`);

  const after = await api('GET', `/api/arap/${payable.id}`);
  check('T6 应付款已结清（未结 0）',
    after.data?.status === 'closed' && Number(after.data?.unsettled) === 0,
    `status=${after.data?.status} unsettled=${after.data?.unsettled}`);

  const overview = await api('GET', `/api/projects/${projectId}/overview`);
  check('T6 发放没有重复计入成本（实际成本仍 1000）',
    Number(overview.data?.metrics?.actual_cost) === 1000, `actual_cost=${overview.data?.metrics?.actual_cost}`);
}

try {
  await main();
} catch (e) {
  check(`执行异常：${e.message}`, false);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n================ 结算接账联调：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项 ================`);
  failed.forEach((f) => console.log('  失败：' + f.name));
  process.exit(failed.length ? 1 : 0);
}
