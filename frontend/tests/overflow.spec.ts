import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { btn, field, layer, login, menu, pickProject } from './helpers';

/**
 * 溢出 / 视觉收口检查。
 * - 页面级横向溢出（出现横向滚动条）= 视觉缺陷
 * - 元素越出视口左右边界（排除表格/抽屉等"设计内可横滚"容器）= 视觉缺陷
 * - 多分辨率（1280/1440/1680/1920）逐一检查，并输出整页截图供人工复核
 */

const SHOT_DIR = join('test-results', 'screenshots');
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
];

const PAGES: Array<{ path: string; name: string; marker: string }> = [
  { path: '/', name: '首页-盈亏总表', marker: '项目盈亏总表' },
  { path: '/projects', name: '项目档案', marker: '新建项目' },
  { path: '/projects/1', name: '项目详情', marker: '预算与利润' },
  { path: '/bookkeeping', name: '记账（五类成本录入）', marker: '筛选条件下' },
  { path: '/payments', name: '收付款流水', marker: '资金流水只反映钱的进出' },
  // 只取稳定前缀：成本页那句横幅的措辞改过（「本页按成本构成**看**汇总」），
  // 这里当「页面已就绪」的标记用，不必跟着逐字绑定。
  { path: '/costs', name: '成本汇总', marker: '本页按成本构成' },
  { path: '/arap', name: '应收应付', marker: '该收未收合计' },
  { path: '/inventory', name: '库存', marker: '库存余量' },
  { path: '/labor-settle', name: '人工结算', marker: '生成结算预览' },
  { path: '/settings', name: '设置', marker: '字典维护' },
];

interface Violation {
  tag: string;
  cls: string;
  right: number;
  left: number;
  text: string;
}

/** 页面内检查：横向溢出与越界元素 */
async function collectOverflow(
  page: Page,
): Promise<{ pageOverflow: boolean; metrics: string; violations: Violation[] }> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const pageOverflow = doc.scrollWidth > doc.clientWidth + 1;

    // 内部可横滚容器（表格 / 抽屉 / 弹窗 / Tabs）及其后代属于"设计内滚动"，不计为缺陷
    //
    // 2026-10-17（L1 表头吸顶）：还要把**用 overflow:hidden 把超宽内容裁掉**的容器算进来。
    // 吸顶表头是 rc-table 渲染的"表头副本"（`.ant-table-sticky-holder`），
    // 它 overflow:hidden 且内部表格比它宽（宽度跟表格 scroll.x 对齐），
    // 几何上伸出视口，但**被它自己裁住、看不到**，页面实际没有横向滚动条。
    const scrollable = new Set<Element>();
    document.querySelectorAll('*').forEach((el) => {
      const cs = getComputedStyle(el);
      const scrollsX = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      const clipsX = cs.overflowX === 'hidden';
      const overflows = el.scrollWidth > el.clientWidth + 2;
      if ((scrollsX || clipsX) && overflows) scrollable.add(el);
    });

    const violations: Array<{ tag: string; cls: string; right: number; left: number; text: string }> = [];
    document.querySelectorAll('body *').forEach((el) => {
      for (let p: Element | null = el; p; p = p.parentElement) if (scrollable.has(p)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > vw + 2 || r.left < -2) {
        violations.push({
          tag: el.tagName,
          cls: String(el.className ?? '').slice(0, 90),
          right: Math.round(r.right),
          left: Math.round(r.left),
          text: (el.textContent ?? '').trim().slice(0, 30),
        });
      }
    });

    return {
      pageOverflow,
      metrics: `scrollWidth=${doc.scrollWidth} clientWidth=${doc.clientWidth}`,
      violations: violations.slice(0, 12),
    };
  });
}

test.describe('溢出与视觉收口', () => {
  test('九大页面在 1280/1440/1680/1920 下无横向溢出、无越界元素，并输出截图', async ({ page }) => {
    // 这个用例要跑 9 页 × 4 视口（另加两组截图），共 60 次页面加载，
    // 默认 90 秒不够（结算页加了「欠款总览」后更慢）。超时只放宽时间，不放宽检查内容。
    test.setTimeout(240_000);
    if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });
    await login(page);
    // 库存/结算等页面必须先选项目才有内容（项目隔离），否则页面只有提示语
    await pickProject(page, '某小区 5#楼');

    const problems: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.getByText(p.marker, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(350); // 等表格/图表布局稳定

        const { pageOverflow, metrics, violations } = await collectOverflow(page);
        if (pageOverflow) problems.push(`[${vp.width}px] ${p.name} 出现横向滚动条（${metrics}）`);
        violations.forEach((v) => {
          problems.push(
            `[${vp.width}px] ${p.name} 元素越界 right=${v.right} left=${v.left} <${v.tag} class="${v.cls}"> ${v.text}`,
          );
        });
      }
      // 截图（1440 与 1920 各来一组，便于人工复核）
      if (vp.width === 1440 || vp.width === 1920) {
        for (const p of PAGES) {
          await page.goto(p.path);
          await expect(page.getByText(p.marker, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(SHOT_DIR, `${vp.width}-${p.name}.png`), fullPage: true });
        }
      }
    }

    expect(problems, `发现 ${problems.length} 处溢出/越界：\n${problems.join('\n')}`).toEqual([]);
  });

  test('1440 宽下主要表格完整可见（不被容器内横向滚动截断）', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await pickProject(page, '某小区 5#楼');

    const measure = async () =>
      page.evaluate(() => {
        const holders = [...document.querySelectorAll('.ant-table-content, .ant-table-body')] as HTMLElement[];
        return holders.map((h) => ({ sw: h.scrollWidth, cw: h.clientWidth, scrolls: h.scrollWidth > h.clientWidth + 2 }));
      });

    const problems: string[] = [];
    // 记账页五个页签逐一检查（各页签列宽不同）
    await page.goto('/bookkeeping');
    await expect(page.getByText('筛选条件下').first()).toBeVisible();
    for (const name of ['人工', '材料', '机械', '杂费', '垫付']) {
      await page.locator('.ant-tabs-tab').filter({ hasText: new RegExp(name.split('').join('\\s*')) }).first().click();
      await page.waitForTimeout(400);
      (await measure())
        .filter((m) => m.scrolls)
        .forEach((m) => problems.push(`/bookkeeping(${name}) 表格被截断：${m.sw} > ${m.cw}`));
    }

    // 成本页：默认展开明细，是列最多的那张表
    await page.goto('/costs');
    await page.waitForTimeout(600);
    (await measure())
      .filter((m) => m.scrolls)
      .forEach((m) => problems.push(`/costs 表格被截断：${m.sw} > ${m.cw}`));

    for (const p of ['/', '/payments', '/arap', '/inventory']) {
      await page.goto(p);
      await page.waitForTimeout(600);
      (await measure())
        .filter((m) => m.scrolls)
        .forEach((m) => problems.push(`${p} 表格被截断：${m.sw} > ${m.cw}`));
    }

    expect(problems, `1440 下仍有被截断的表格：\n${problems.join('\n')}`).toEqual([]);
  });

  test('合计行金额不折行（避免 2,500,000.0 / 0 这类断行）', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByText(/合计（\d+ 个项目）/)).toBeVisible();

    const broken = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('.ant-table-summary .ant-table-cell').forEach((cell) => {
        // 量文字本身的高度（单元格含 padding，不能用单元格高度判断）
        const span = cell.querySelector('span');
        if (!span) return;
        const cs = getComputedStyle(span);
        const lineHeight = parseFloat(cs.lineHeight) || 0;
        const h = span.getBoundingClientRect().height;
        if (lineHeight > 0 && h > lineHeight * 1.5) {
          out.push(`${(span.textContent ?? '').trim().slice(0, 20)} (h=${Math.round(h)}, lh=${Math.round(lineHeight)})`);
        }
      });
      return out;
    });
    expect(broken, `合计行出现折行：\n${broken.join('\n')}`).toEqual([]);
  });

  test('表格横向滚动是容器内滚动，不撑破页面（成本页宽表）', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/bookkeeping');
    await expect(page.getByText('筛选条件下').first()).toBeVisible();

    const info = await page.evaluate(() => {
      const holder = document.querySelector('.ant-table-content, .ant-table-body') as HTMLElement | null;
      return {
        holderScrolls: holder ? holder.scrollWidth > holder.clientWidth : false,
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
      };
    });
    expect(info.holderScrolls, '宽表应在容器内滚动').toBe(true);
    expect(info.docScrollWidth).toBeLessThanOrEqual(info.docClientWidth + 1);
  });

  test('固定工具条 + 表头吸顶：滚动时列名一直可见（L1 回归）', async ({ page }) => {
    await login(page);
    // 故意用矮视口，保证页面一定可滚动。
    //
    // 选「成本」页：它内容最长（五类汇总卡片 + 分组树表），520 高下实测内容 1062px、可滚 542px，
    // 而记账 / 收付款 / 库存页在数据较少时恰好装得下（maxScroll=0），拿它们测会假失败。
    await page.setViewportSize({ width: 1440, height: 520 });
    await page.goto('/costs');
    await expect(page.getByText('成本明细（按类别分组）')).toBeVisible({ timeout: 20_000 });

    const toolbar = page.locator('.pims-toolbar').first();

    // 滚到表格中段：工具条已吸附，内容还在继续滚动
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.scrollY), '页面应已滚动').toBeGreaterThan(0);

    // 吸附后仍可见
    await expect(toolbar).toBeVisible();
    const tb = (await toolbar.boundingBox())!;
    expect(tb.y, '工具条应吸附在顶部（sticky top:0）').toBeLessThanOrEqual(1);

    // 吸附后确实"吸住"了：继续滚动，工具条位置不动
    await page.evaluate(() => window.scrollTo(0, 460));
    await page.waitForTimeout(400);
    const tb2 = (await toolbar.boundingBox())!;
    expect(Math.abs(tb2.y - tb.y), '继续滚动时工具条应保持吸附，不能跟着滚走').toBeLessThanOrEqual(1);

    // 工具条不应盖住页面顶部的主内容区标题（成本汇总卡片）
    const card = page.locator('.ant-card').first();
    const cardBox = (await card.boundingBox())!;
    if (cardBox.y > 0) {
      expect(cardBox.y, '主内容不应被工具条压住').toBeGreaterThanOrEqual(tb2.y + tb2.height - 2);
    }

    // 需求 L1（2026-10-17）：**列名也必须可见且不被工具条盖住**
    //
    // 修之前这里是坏的：工具条吸住了，但 `<thead>` 滚上去没了，
    // 于是看到一串数字不知道哪列是哪列。
    // 现在走 antd/rc-table 的 `sticky`（独立 sticky 容器，不依赖 thead 的 position:sticky）。
    const headerBox = await page.evaluate(() => {
      const holder = document.querySelector<HTMLElement>('.ant-table-sticky-holder');
      if (!holder) return null;
      const bar = document.querySelector<HTMLElement>('.pims-toolbar');
      const r = holder.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : 0,
        text: (holder.textContent ?? '').replace(/\s+/g, ''),
      };
    });
    expect(headerBox, '表格应有吸顶表头容器').not.toBeNull();
    expect(headerBox!.text, '吸顶容器里应是列名').toContain('类别/对象');
    expect(headerBox!.top, '列名应贴在工具条下方，不能被盖住').toBeGreaterThanOrEqual(
      headerBox!.barBottom - 1,
    );
    expect(headerBox!.bottom, '列名应仍在视口内（没被滚走）').toBeLessThanOrEqual(520);
    expect(headerBox!.bottom, '列名应完整可见（有高度）').toBeGreaterThan(headerBox!.top);
  });

  test('表头吸顶覆盖所有用共用表格的页面（不只成本页）', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 520 });
    // 库存/结算页必须先选项目才有表格，否则页面只有"请先选择项目"的提示
    await pickProject(page, '某小区 5#楼');

    // L1 是全局问题：列名由共用 `DataTable` 渲染，改一处应全站生效。
    // 这里逐页抽查，确认它们都启用了吸顶容器（不是只有成本页被修）。
    for (const path of ['/', '/projects', '/bookkeeping', '/payments', '/costs', '/arap', '/inventory', '/labor-settle']) {
      await page.goto(path);
      await page.waitForTimeout(500);
      const holders = await page.evaluate(
        () => document.querySelectorAll('.ant-table-sticky-holder').length,
      );
      expect(holders, `${path} 的表格应启用表头吸顶`).toBeGreaterThan(0);
    }
  });

  test('宽表横向滚动时，吸顶表头跟着表体一起滚（列不能错位）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await page.setViewportSize({ width: 1280, height: 800 });

    // 项目档案页列最多（scroll x=1700 而可视宽约 1066），最能体现横向滚动
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    // 滚表体（.ant-table-body 才是真正的横向滚动容器；表头是它的一份"副本"）
    const scrolled = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>('.ant-table-body');
      if (!box) return -1;
      box.scrollLeft = 300;
      return box.scrollLeft;
    });
    expect(scrolled, '宽表应能横向滚动').toBeGreaterThan(0);
    await page.waitForTimeout(300);

    // 表头的每一列都必须和表体对应列左边缘对齐（错位就说明吸顶把横向联动弄坏了）
    const misaligned = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-sticky-holder th'));
      const tds = Array.from(
        document.querySelectorAll<HTMLElement>('.ant-table-body tr:first-child td'),
      );
      const n = Math.min(ths.length, tds.length);
      const bad: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const thLeft = Math.round(ths[i].getBoundingClientRect().left);
        const tdLeft = Math.round(tds[i].getBoundingClientRect().left);
        if (Math.abs(thLeft - tdLeft) > 2) bad.push(`第${i + 1}列 th=${thLeft} td=${tdLeft}`);
      }
      return bad;
    });
    expect(misaligned, `吸顶表头与表体错位：${misaligned.join('；')}`).toEqual([]);
  });

  test('弹层（新建项目抽屉 / 冲销弹窗）在 1280 宽下不越界，操作按钮可见', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 抽屉
    await page.goto('/projects');
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await expect(drawer).toBeVisible();
    // 等滑入动画结束再量尺寸（动画中 transform 会让它暂时越界）
    await page.waitForTimeout(600);
    const dBox = (await drawer.boundingBox())!;
    expect(dBox.x, '抽屉不应越出左边界').toBeGreaterThanOrEqual(0);
    expect(dBox.x + dBox.width, '抽屉不应越出右边界').toBeLessThanOrEqual(1280 + 1);
    await expect(drawer.getByRole('button', { name: /保\s*存/ })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /取\s*消/ })).toBeVisible();
    await drawer.getByRole('button', { name: /取\s*消/ }).click();

    // 冲销弹窗（内容较宽，含表格）
    await page.goto('/arap');
    await page
      .locator('.ant-table-tbody tr.ant-table-row')
      .first()
      .getByRole('button', { name: /收\s*款/ })
      .click();
    const modal = layer(page);
    await expect(modal).toBeVisible();
    await page.waitForTimeout(600); // 等弹窗缩放动画结束
    const mBox = (await modal.boundingBox())!;
    expect(mBox.x).toBeGreaterThanOrEqual(0);
    expect(mBox.x + mBox.width).toBeLessThanOrEqual(1280 + 1);
    await expect(btn(page, '确认冲销')).toBeVisible();
    await expect(modal.getByText('本次冲销合计', { exact: false })).toBeVisible();
  });

  test('侧边菜单在 1280 下不换行、不遮挡内容', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const name of ['首页', '项目', '记账', '收/付款', '成本', '往来', '库存', '结算', '设置']) {
      const item = menu(page, name);
      await expect(item).toBeVisible();
      const box = (await item.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `菜单「${name}」不应越界`).toBeLessThanOrEqual(1280 + 1);
    }
    const content = (await page.locator('.ant-layout-content').boundingBox())!;
    expect(content.x, '内容区应在侧栏右侧').toBeGreaterThanOrEqual(170);
  });

  test('长文本单元格不撑破布局（超长项目名）', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/projects');
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('超长项目名称测试'.repeat(12));
    await field(page, '甲方预算', drawer).fill('1000');
    await field(page, '我方成本预算', drawer).fill('500');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible({ timeout: 20_000 });
    // 等抽屉（含滑出动画）彻底消失再扫描视口：
    // 否则会把「正在滑出的 ant-drawer-panel-motion-right-leave」当成越界元素（实测会报 86 条误报）。
    // 注意要用 hidden 状态判定，不能用 detached —— 元素在动画期间仍留在 DOM 里。
    await expect(page.locator('.ant-drawer-content-wrapper')).toHaveCount(0, { timeout: 15_000 });

    const { pageOverflow, violations } = await collectOverflow(page);
    expect(pageOverflow, '超长项目名不应导致页面横滚').toBe(false);
    expect(
      violations,
      `超长文本导致越界：\n${violations.map((v) => JSON.stringify(v)).join('\n')}`,
    ).toEqual([]);
  });
});
