import { expect, test, type Page } from '@playwright/test';
import { btn, login, pickProject } from './helpers';

// 这组用例要真后端 + 造数脚本（见文件头）。默认 mock 套件里跳过，
// 否则永远是红的、还会掩盖真正的回归（2026-10-19 记录）。
test.skip(!process.env.PIMS_REAL, '需要 PIMS_REAL=1 + 真后端 + scripts/seed_quick_query_demo.py');

/**
 * 快速查询的卡片内筛选（2026-10-19 需求补充）。
 *
 * 覆盖：
 * - #4 查询按钮在「清空」后面
 * - #2/#3 往来未结：应收/应付切换，另一项隐藏，汇总联动
 * - #5 工人未结款：付款状态 + 工人筛选，汇总联动，三张卡互不影响
 * - #6c/#6d 成本与预算：成本类型筛选 + 「筛选后」行
 * - #6e 工人未结款默认按还欠降序
 */

/** 与排序用例共用同一个造数项目，避免两套测试各自要不同的库 */
const PROJECT = '排序验证项目';

async function openQuery(page: Page) {
  await login(page);
  await pickProject(page, PROJECT);
  await page.goto('/quick-query');
  await expect(page.locator('.ant-checkbox-wrapper').first()).toBeVisible({ timeout: 15_000 });
}

/** 取某张卡（按卡片标题定位） */
function card(page: Page, title: string) {
  return page
    .locator('.ant-card')
    .filter({ has: page.locator('.ant-card-head-title', { hasText: title }) })
    .first();
}

/** 卡片里的数据行 */
function rows(page: Page, title: string) {
  return card(page, title).locator('.ant-table-tbody tr.ant-table-row');
}

/** 卡片内某个 Statistic 的数值 */
async function statValue(page: Page, title: string, label: string): Promise<string> {
  const item = card(page, title)
    .locator('.ant-statistic')
    .filter({ has: page.locator('.ant-statistic-title', { hasText: label }) })
    .first();
  return (await item.locator('.ant-statistic-content-value').innerText()).trim();
}

test.describe('快速查询 - 卡片内筛选', () => {
  test('#4 查询按钮在「清空」后面', async ({ page }) => {
    await openQuery(page);
    const clearBtn = btn(page, '清空');
    const queryBtn = btn(page, '查询');
    await expect(clearBtn).toBeVisible();
    await expect(queryBtn).toBeVisible();

    const clearBox = await clearBtn.boundingBox();
    const queryBox = await queryBtn.boundingBox();
    expect(clearBox).not.toBeNull();
    expect(queryBox).not.toBeNull();
    // 查询在清空右侧，且垂直位置相近（同一行）
    expect(queryBox!.x).toBeGreaterThan(clearBox!.x);
    expect(Math.abs(queryBox!.y - clearBox!.y)).toBeLessThan(20);
  });

  test('#6e 工人未结款默认按还欠降序', async ({ page }) => {
    await openQuery(page);
    await btn(page, '查询').click();
    await expect(card(page, '工人未结款')).toBeVisible({ timeout: 15_000 });

    const list = rows(page, '工人未结款');
    const count = await list.count();
    expect(count).toBeGreaterThan(1);

    const unsettled: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const cells = list.nth(i).locator('td');
      // 列顺序：工人 | 累计应付 | 已付 | 还欠 | 已付构成
      const text = (await cells.nth(3).innerText()).replace(/,/g, '').trim();
      unsettled.push(Number(text));
    }
    for (let i = 1; i < unsettled.length; i += 1) {
      expect(unsettled[i]).toBeLessThanOrEqual(unsettled[i - 1]);
    }
  });

  test('#5 工人未结款：付款状态筛选，汇总联动', async ({ page }) => {
    await openQuery(page);
    await btn(page, '查询').click();
    await expect(card(page, '工人未结款')).toBeVisible({ timeout: 15_000 });

    const allCount = await rows(page, '工人未结款').count();
    const allUnsettled = await statValue(page, '工人未结款', '还欠合计');

    // 打开付款状态下拉，只保留「全部付清」
    const stateSelect = card(page, '工人未结款').locator('.ant-select').first();
    await stateSelect.click();
    const dropdown = page.locator('.ant-select-dropdown:visible').first();
    // 取消「一分没付」「部分已付」
    await dropdown.locator('.ant-select-item-option').filter({ hasText: '一分没付' }).click();
    await dropdown.locator('.ant-select-item-option').filter({ hasText: '部分已付' }).click();
    await page.keyboard.press('Escape');

    const paidCount = await rows(page, '工人未结款').count();
    expect(paidCount).toBeLessThan(allCount);
    // 只留全部付清 → 还欠合计应为 0
    await expect
      .poll(async () => await statValue(page, '工人未结款', '还欠合计'), { timeout: 5000 })
      .toBe('0.00');
    expect(paidCount).toBeGreaterThan(0);
    // 原全量汇总不应是 0（证明筛选确实改变了汇总）
    expect(allUnsettled).not.toBe('0.00');
  });

  test('#2/#3 往来未结：切到应收时应付栏消失，汇总联动', async ({ page }) => {
    await openQuery(page);
    await btn(page, '查询').click();
    await expect(card(page, '往来未结')).toBeVisible({ timeout: 15_000 });

    const arap = card(page, '往来未结');
    // 默认「全部」：应收未收 + 应付未付 两栏都在
    await expect(arap.locator('.ant-statistic-title').filter({ hasText: '应收未收' })).toBeVisible();
    await expect(arap.locator('.ant-statistic-title').filter({ hasText: '应付未付' })).toBeVisible();

    // 选「应收款未收」
    await arap.getByText('应收款未收', { exact: true }).click();
    await expect(arap.locator('.ant-statistic-title').filter({ hasText: '应付未付' })).toHaveCount(0);
    await expect(arap.locator('.ant-statistic-title').filter({ hasText: '应收未收' })).toBeVisible();

    // 明细里不该再有「应付」
    const typeCells = arap.locator('.ant-table-tbody tr.ant-table-row td:first-child');
    const texts = await typeCells.allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    texts.forEach((text) => expect(text.trim()).toBe('应收'));

    // 切到「应付未付」则反之
    await arap.getByText('应付未付', { exact: true }).click();
    await expect(arap.locator('.ant-statistic-title').filter({ hasText: '应收未收' })).toHaveCount(0);
    const payableTexts = await arap.locator('.ant-table-tbody tr.ant-table-row td:first-child').allInnerTexts();
    payableTexts.forEach((text) => expect(text.trim()).toBe('应付'));
  });

  test('#2/#3 未勾选往来未结时，下拉不存在', async ({ page }) => {
    await openQuery(page);
    // 只勾「成本与预算」
    const boxes = page.locator('.ant-checkbox-wrapper');
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await btn(page, '查询').click();
    await expect(card(page, '成本与预算')).toBeVisible({ timeout: 15_000 });
    await expect(card(page, '往来未结')).toHaveCount(0);
    await expect(page.getByText('应收款未收', { exact: true })).toHaveCount(0);
  });

  test('#6c/#6d 成本与预算：筛选后合计跟随，原汇总不变', async ({ page }) => {
    await openQuery(page);
    await btn(page, '查询').click();
    await expect(card(page, '成本与预算')).toBeVisible({ timeout: 15_000 });

    const cost = card(page, '成本与预算');
    const beforeActual = await statValue(page, '成本与预算', '实际成本');
    const beforeFiltered = await statValue(page, '成本与预算', '筛选后合计');
    expect(beforeActual).toBe(beforeFiltered);

    // 只选「人工」
    const typeSelect = cost.locator('.ant-select').first();
    await typeSelect.click();
    const dropdown = page.locator('.ant-select-dropdown:visible').first();
    await dropdown.locator('.ant-select-item-option').filter({ hasText: '人工' }).click();
    await page.keyboard.press('Escape');

    // 原「实际成本」不变
    await expect
      .poll(async () => await statValue(page, '成本与预算', '实际成本'), { timeout: 5000 })
      .toBe(beforeActual);
    // 「筛选后合计」变小
    const afterFiltered = await statValue(page, '成本与预算', '筛选后合计');
    expect(afterFiltered).not.toBe(beforeFiltered);
    // 表格只剩人工 + 合计行（合计行由后端排在数据最后一行）
    const typeCells = cost.locator('.ant-table-tbody tr.ant-table-row td:first-child');
    const texts = (await typeCells.allInnerTexts()).map((t) => t.trim());
    expect(texts).toEqual(['人工', '合计']);
  });

  test('三张卡筛选互相独立', async ({ page }) => {
    await openQuery(page);
    await btn(page, '查询').click();
    await expect(card(page, '工人未结款')).toBeVisible({ timeout: 15_000 });

    const laborCountBefore = await rows(page, '工人未结款').count();
    const arapCountBefore = await rows(page, '往来未结').count();

    // 只动往来卡：切到应收
    await card(page, '往来未结').getByText('应收款未收', { exact: true }).click();

    // 往来变了
    await expect
      .poll(async () => await rows(page, '往来未结').count(), { timeout: 5000 })
      .toBeLessThan(arapCountBefore);
    // 工人卡完全没变
    expect(await rows(page, '工人未结款').count()).toBe(laborCountBefore);
  });
});

