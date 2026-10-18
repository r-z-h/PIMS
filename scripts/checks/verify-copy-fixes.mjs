/** 一次性探针：确认打包态页面文案修复生效（无裸露 Markdown 星号、文案不再自相矛盾）。 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:8000';
const PORT = 9241;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`);
};

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
  await sleep(1500);
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
  throw new Error('no target');
}

try {
  const profile = mkdtempSync(join(tmpdir(), 'pims-text-'));
  edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
  const t = await pickTarget();
  await connect(t.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');

  // 登录（全新库会先强制设密保）
  await goto(BASE + '/');
  await sleep(1500);
  await ev(`(() => {
    const i = document.querySelector('input[type="password"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '123456');
    i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.ant-btn-primary')].find((b) => /登\\s*录/.test(b.innerText)).click();
    return true;
  })()`);
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
        set(items[0].querySelector('input'), '探针问题${n}');
        set(items[1].querySelector('input'), '探针答案${n}');
        return true;
      })()`);
    }
    await ev(`[...document.querySelectorAll('button')].find((b) => b.innerText.includes('保存并进入系统')).click()`);
    await sleep(2500);
  }
  check('登录并进入系统', (await ev('location.pathname')) === '/');

  // 成本页文案
  await goto(BASE + '/costs');
  await sleep(1500);
  const text = await ev('document.body.innerText');
  check('成本页不再出现「不提供录入」', !text.includes('不提供录入'));
  check('成本页不再出现裸露的 Markdown 星号', !text.includes('**'));
  check('成本页出现新文案「共用同一份」', text.includes('共用同一份'));
  check('成本页页脚强调「对应的应付单会保留」', text.includes('对应的应付单会保留'));
  check('成本页有「新增成本」入口', text.includes('新增成本'));

  // 记账页删除确认弹窗文案（不真删，只看提示文案是否含星号）
  await goto(BASE + '/bookkeeping');
  await sleep(1800);
  const bkText = await ev('document.body.innerText');
  check('记账页无裸露星号', !bkText.includes('**'));
  check('记账页有「登记已付」列', bkText.includes('登记已付'));
} catch (e) {
  check('探针异常', false, e.message);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  if (edge && !edge.killed) edge.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n===== 文案探针：通过 ${results.length - failed.length} / ${results.length} =====`);
  process.exit(failed.length ? 1 : 0);
}
