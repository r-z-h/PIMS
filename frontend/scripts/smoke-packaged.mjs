/**
 * 打包态冒烟测试（start.bat 的真实形态）：后端静态托管 frontend/dist，浏览器直接访问 127.0.0.1:8000。
 * 与 mock/开发态的脚本不同：这里不经过 Vite，验证的是「双击 start.bat 能用」这条路径。
 *
 * 用法：
 *   1) 先构建前端：npm run build
 *   2) 起后端（可用临时库）：uvicorn app.main:app --port 8000 --app-dir backend
 *   3) node scripts/smoke-packaged.mjs    （可用 PIMS_BASE 指向别的实例）
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const BASE = process.env.PIMS_BASE || 'http://127.0.0.1:8000';
const PORT = Number(process.env.PIMS_CDP_PORT || 9227);
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
  has: (t) => window.__T.norm(document.body.innerText).includes(window.__T.norm(t)),
  path: () => location.pathname,
  setInput(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  itemByLabel(root, label) {
    return [...root.querySelectorAll('.ant-form-item')].find((i) =>
      (i.querySelector('.ant-form-item-label')?.innerText || '').trim().startsWith(label));
  },
  fill(label, value, root) {
    const item = window.__T.itemByLabel(root || document, label);
    if (!item) throw new Error('form item not found: ' + label);
    return window.__T.setInput(item.querySelector('input, textarea'), value);
  },
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
  clickText(text, selector, root) {
    const scope = root || document;
    const target = window.__T.norm(text);
    const el = [...scope.querySelectorAll(selector || 'button, a, .ant-tabs-tab, .ant-menu-item')]
      .find((n) => window.__T.norm(n.innerText).includes(target));
    if (!el) throw new Error('clickable not found: ' + text);
    el.click();
    return true;
  },
  clickLayerOk() {
    const m = window.__T.layer();
    if (!m) throw new Error('no layer');
    const btns = [...m.querySelectorAll('.ant-modal-footer button, .ant-drawer-extra button, .ant-drawer-footer button')];
    const ok = btns.find((b) => /确定|保存|提交|确认/.test(b.innerText)) || btns[btns.length - 1];
    if (!ok) throw new Error('ok button not found');
    ok.click();
    return true;
  },
  toastCount: () => document.querySelectorAll('.ant-message-notice').length,
  errorToasts: () => document.querySelectorAll('.ant-message-error').length,
  toastTexts: () => [...document.querySelectorAll('.ant-message-notice')].map((n) => (n.innerText || '').trim()),
  tableText: () => [...document.querySelectorAll('.ant-table')].map((t) => t.innerText).join('\\n'),
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
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
    } catch {
      /* 等 Edge 起来 */
    }
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
    await sleep(250);
  }
  throw new Error(`等待超时：${desc}（${JSON.stringify(last)}）`);
}

/** 菜单项 → 该页必然出现的标志文本（不依赖数据） */
const PAGES = [
  ['首页', '项目盈亏总表'],
  ['项目', '新建项目'],
  ['记账', '筛选条件下'],          // 改名后：五类成本录入页
  ['收/付款', '新增付款'],          // 改名后：资金收付流水页；顶部切换默认停在「付款」（需求 T2）
  ['成本', '成本明细（按类别分组）'],   // 新页：按成本构成汇总（也能录入）
  ['往来', '该收未收合计'],
  ['库存', '材料入库'],
  ['结算', '生成结算预览'],
  ['设置', '字典维护'],
];

let edge;
let cdp;
try {
  const profile = mkdtempSync(join(tmpdir(), 'pims-smoke-'));
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

  /* 1. 打开首页（后端静态托管的 SPA） */
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2000);
  await cdp.eval(HELPERS);
  const title = await cdp.eval(`document.title`);
  const hasRoot = await cdp.eval(`!!document.getElementById('root')?.children.length`);
  check('后端静态托管的前端页面可打开', Boolean(hasRoot), `title=${title}`);
  await waitFor(cdp, `window.__T.has('登录密码') || window.__T.has('设置密保问题')`, '登录页渲染');
  check('未登录访问 → 登录页（守卫生效）', (await cdp.eval(`window.__T.path()`)) === '/login');

  /* 2. 登录（首次会强制设置密保） */
  await cdp.eval(`window.__T.fill('登录密码', '123456')`);
  await cdp.eval(`window.__T.clickText('登录', '.ant-btn-primary')`);
  await waitFor(cdp, `window.__T.path() === '/security-setup' || window.__T.has('项目盈亏总表')`, '登录后进入密保页或首页');
  if (await cdp.eval(`window.__T.path() === '/security-setup'`)) {
    check('首次登录被强制要求设置密保', true);
    for (let i = 0; i < 3; i += 1) {
      await cdp.eval(`(() => {
        const card = [...document.querySelectorAll('.ant-card')].find((c) => (c.querySelector('.ant-card-head-title')?.innerText || '').includes('密保问题 ${i + 1}'));
        const items = [...card.querySelectorAll('.ant-form-item')];
        window.__T.setInput(items[0].querySelector('input'), '冒烟问题${i + 1}');
        window.__T.setInput(items[1].querySelector('input'), '冒烟答案${i + 1}');
        return true;
      })()`);
    }
    await cdp.eval(`window.__T.clickText('保存并进入系统', '.ant-btn-primary')`);
    await waitFor(cdp, `window.__T.path() === '/'`, '密保保存后进入首页');
    check('密保保存后放行进入首页', true);
  } else {
    check('已设置密保，直接进入首页', true);
  }

  /* 3. 首页渲染 */
  await waitFor(cdp, `window.__T.has('项目盈亏总表')`, '首页盈亏总表渲染');
  check('首页盈亏总表渲染', true);

  /* 4. 走一遍 UI 写入路径：新建项目 → 列表出现 */
  await cdp.eval(`window.__T.clickText('项目', '.ant-menu-item')`);
  await waitFor(cdp, `window.__T.has('新建项目')`, '项目档案页');
  await cdp.eval(`window.__T.clickText('新建项目', '.ant-btn-primary')`);
  await waitFor(cdp, `!!window.__T.layer()`, '新建项目表单');
  await cdp.eval(`(() => {
    const m = window.__T.layer();
    window.__T.fill('项目名称', '冒烟测试项目', m);
    window.__T.fill('甲方预算', '1000000', m);
    window.__T.fill('我方成本预算', '800000', m);
    return true;
  })()`);
  await cdp.eval(`window.__T.clickLayerOk()`);
  const created = await waitFor(cdp, `window.__T.tableText().includes('冒烟测试项目')`, '项目落库并刷新列表', 25000).catch(() => false);
  check('UI 表单提交 → 落库 → 列表刷新', Boolean(created));

  /* 4.5 项目详情页要真能取到数（2026-10-17 故障回归）
   *
   * 故障背景：后端 `GET /api/projects/{id}` 返回扁平结构，而页面按嵌套（overview.project）取数，
   * 结果整页显示 `-` / `0.00`。当时**没被发现**，因为 Playwright 全跑在 mock 上，而 mock 是对的。
   * 这里在**真实后端 + 真实浏览器**下锁住：详情页必须显示刚才建的项目名，不能是 `-`。 */
  const detailOk = await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('.ant-table-row'));
    const row = rows.find((r) => r.textContent.includes('冒烟测试项目'));
    if (!row) return JSON.stringify({ ok: false, why: '列表里没有该项目' });
    row.querySelector('td').click();
    return JSON.stringify({ ok: true });
  })()`);
  const detailParsed = JSON.parse(detailOk);
  if (!detailParsed.ok) {
    check('项目详情页能取到数据（不是整片 - / 0.00）', false, detailParsed.why);
  } else {
    // 断言**预算数字**而不是项目名：项目名在顶部选择器里也有，取不到数时照样能"找到"，会假通过。
    // 建项目时甲方预算是 1,000,000 → 详情页必须显示 1,000,000.00；坏页面这里是 0.00。
    let okay = false;
    try {
      okay = Boolean(
        await waitFor(cdp, `window.__T.has('1,000,000.00')`, '项目详情页预算数字', 15000),
      );
    } catch {
      okay = false;
    }
    const bodyText = await cdp.eval(`document.body.innerText.slice(0, 400)`);
    check(
      '项目详情页能取到数据（不是整片 - / 0.00）',
      okay,
      okay ? '' : `详情页文本片段=${String(bodyText).replace(/\\n/g, ' | ').slice(0, 160)}`,
    );
    await cdp.eval(`window.__T.clickText('项目', '.ant-menu-item')`);
    await waitFor(cdp, `window.__T.has('新建项目')`, '返回项目列表');
  }

  /* 5. 八个页面逐个进入 */
  for (const [menu, marker] of PAGES) {
    await cdp.eval(`window.__T.clickText('${menu}', '.ant-menu-item')`);
    let ok = false;
    try {
      ok = Boolean(await waitFor(cdp, `window.__T.has('${marker}')`, `页面 ${menu}`, 12000));
    } catch {
      ok = false;
    }
    check(`菜单「${menu}」页面可打开（含「${marker}」）`, ok);
  }

  const errToasts = await cdp.eval(`window.__T.errorToasts()`);
  const toastTexts = await cdp.eval(`JSON.stringify(window.__T.toastTexts())`);
  check('全程没有错误提示（.ant-message-error = 0）', errToasts === 0, `error=${errToasts}，当前提示=${toastTexts}`);
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
  console.log('\n================ 打包态冒烟汇总 ================');
  console.log(`通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  failed.forEach((f) => console.log(`  失败：${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  process.exit(failed.length ? 1 : 0);
}
