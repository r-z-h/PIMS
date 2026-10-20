import { expect, test, type Page } from '@playwright/test';
import { btn, login, pickProject } from './helpers';

// 这组用例要真后端 + 造数脚本（见文件头）。默认 mock 套件里跳过，
// 否则永远是红的、还会掩盖真正的回归（2026-10-19 记录）。
test.skip(!process.env.PIMS_REAL, '需要 PIMS_REAL=1 + 真后端 + scripts/seed_quick_query_demo.py');

/**
 * 金额排序（用户 2026-10-19 确认的规则）。
 *
 * | 表 | 规则 |
 * |---|---|
 * | 工人未结款 | 按「还欠」降序 |
 * | 往来未结   | 先按「单据日期」升序，同一天再按「未结」降序 |
 * | 成本与预算 | 按「金额」降序，合计行在最后 |
 *
 * 排序在**后端**做（query_service 返回前 sort），前端不排序，
 * 所以这里断言的是"页面显示顺序 == 后端返回顺序"。
 */

const PROJECT = '排序验证项目';

async function openQuery(page: Page) {
  await login(page);
  await pickProject(page, PROJECT);
  await page.goto('/quick-query');
  await expect(page.locator('.ant-checkbox-wrapper').first()).toBeVisible({ timeout: 15_000 });
  await btn(page, '查询').click();
  await expect(page.locator('.ant-card-head-title').filter({ hasText: '工人未结款' })).toBeVisible({
    timeout: 15_000,
  });
}

function card(page: Page, title: string) {
  return page
    .locator('.ant-card')
    .filter({ has: page.locator('.ant-card-head-title', { hasText: title }) })
    .first();
}

/** 取某列（按列标题）在所有数据行里的文本 */
async function columnTexts(page: Page, title: string, columnTitle: string): Promise<string[]> {
  const scope = card(page, title);
  const headers = await scope.locator('.ant-table-thead th').allInnerTexts();
  const index = headers.findIndex((text) => text.trim().startsWith(columnTitle));
  expect(index, `找不到列「${columnTitle}」：${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);

  const rows = scope.locator('.ant-table-tbody tr.ant-table-row');
  const count = await rows.count();
  const values: string[] = [];
  for (let i = 0; i < count; i += 1) {
    values.push((await rows.nth(i).locator('td').nth(index).innerText()).trim());
  }
  return values;
}

const toNum = (text: string) => Number(text.replace(/,/g, '').trim());

test.describe('金额排序', () => {
  test('工人未结款按「还欠」降序', async ({ page }) => {
    await openQuery(page);
    const values = (await columnTexts(page, '工人未结款', '还欠')).map(toNum);
    expect(values.length).toBeGreaterThan(1);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `未降序：${JSON.stringify(values)}`).toBeLessThanOrEqual(values[i - 1]);
    }
  });

  test('成本与预算按「金额」降序，合计行在最后', async ({ page }) => {
    await openQuery(page);
    const scope = card(page, '成本与预算');
    const headers = await scope.locator('.ant-table-thead th').allInnerTexts();
    const index = headers.findIndex((text) => text.trim().startsWith('金额'));
    expect(index).toBeGreaterThanOrEqual(0);

    const rows = scope.locator('.ant-table-tbody tr.ant-table-row');
    const count = await rows.count();
    const labels: string[] = [];
    const amounts: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const cells = rows.nth(i).locator('td');
      labels.push((await cells.nth(0).innerText()).trim());
      amounts.push(toNum(await cells.nth(index).innerText()));
    }

    // 合计行是最后一行
    expect(labels[labels.length - 1]).toBe('合计');
    // 明细按金额降序
    const detail = amounts.slice(0, -1);
    for (let i = 1; i < detail.length; i += 1) {
      expect(detail[i], `未降序：${JSON.stringify(detail)}`).toBeLessThanOrEqual(detail[i - 1]);
    }
  });

  test('往来未结先按日期升序、同日按未结降序', async ({ page }) => {
    await openQuery(page);
    const scope = card(page, '往来未结');
    const headers = await scope.locator('.ant-table-thead th').allInnerTexts();
    const dateIndex = headers.findIndex((text) => text.trim().startsWith('单据日期'));
    const amountIndex = headers.findIndex((text) => text.trim().startsWith('未结'));
    expect(dateIndex).toBeGreaterThanOrEqual(0);
    expect(amountIndex).toBeGreaterThanOrEqual(0);

    const rows = scope.locator('.ant-table-tbody tr.ant-table-row');
    const count = await rows.count();
    const pairs: { date: string; amount: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      const cells = rows.nth(i).locator('td');
      pairs.push({
        date: (await cells.nth(dateIndex).innerText()).trim(),
        amount: toNum(await cells.nth(amountIndex).innerText()),
      });
    }
    expect(pairs.length).toBeGreaterThan(1);

    for (let i = 1; i < pairs.length; i += 1) {
      const prev = pairs[i - 1];
      const cur = pairs[i];
      // 日期升序
      expect(cur.date >= prev.date, `日期未升序：${JSON.stringify(pairs)}`).toBe(true);
      // 同一天 → 金额降序
      if (cur.date === prev.date) {
        expect(cur.amount, `同日未降序：${JSON.stringify(pairs)}`).toBeLessThanOrEqual(prev.amount);
      }
    }
  });

  test('表头不再提供排序按钮（排序由后端决定）', async ({ page }) => {
    await openQuery(page);
    // antd 的排序表头会带 .ant-table-column-sorters
    await expect(card(page, '工人未结款').locator('.ant-table-column-sorters')).toHaveCount(0);
    await expect(card(page, '往来未结').locator('.ant-table-column-sorters')).toHaveCount(0);
  });
});

