/**
 * 把 HTML 渲染成 PNG（headless Edge + CDP，整页截图）。
 * 用法：node scripts/checks/render-html-to-png.mjs <input.html> <output.png>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE = process.env.PIMS_EDGE || join(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe');
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node render-html-to-png.mjs <input.html> <output.png>');
  process.exit(2);
}
const PORT = Number(process.env.PIMS_CDP_PORT || 9250);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'pims-shot-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1400,1200', 'about:blank',
], { stdio: 'ignore' });

async function pickTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 等浏览器起来 */ }
    await sleep(300);
  }
  throw new Error('找不到 Edge 调试目标');
}

let ws;
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  id += 1;
  const cur = id;
  return new Promise((resolve, reject) => {
    pending.set(cur, { resolve, reject });
    ws.send(JSON.stringify({ id: cur, method, params }));
  });
}

try {
  const target = await pickTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });

  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(resolve(input)).href });
  await sleep(1200); // 等字体与布局稳定

  const metrics = await send('Page.getLayoutMetrics');
  const w = Math.ceil(metrics.cssContentSize.width);
  const h = Math.ceil(metrics.cssContentSize.height);
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 2, mobile: false,
  });
  await sleep(400);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: h, scale: 2 },
  });
  writeFileSync(output, Buffer.from(shot.data, 'base64'));
  console.log(`OK  内容尺寸 ${w}x${h}（2x 输出）→ ${output}`);
} catch (e) {
  console.error('渲染失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  edge.kill();
}
