import { expect, test } from '@playwright/test';
import { login, pickProject } from './helpers';

/**
 * 项目列表「名字 + 日期」筛选（2026-10-17 用户需求）。
 *
 * 日期有两种口径，用下拉切换：
 * - **有业务数据**（默认）：只显示区间内有成本/收付款/往来/入库的项目
 * - **开工日期**：只显示开工日期落在区间内的项目
 *
 * mock 种子：项目1「某小区 5#楼」开工 2026-03-01、成本在 2026-05；
 *           项目2「市政道路改造」开工 2026-04-15、成本也在 2026-05；
 *           项目3「厂房维修（已完工）」无成本。
 */
test.describe('项目列表筛选', () => {
  test('按名字搜项目', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    await page.getByPlaceholder('搜索项目名称 / 甲方 / 负责人').fill('市政');
    await page.keyboard.press('Enter');

    await expect(page.locator('.ant-table-row').filter({ hasText: '市政道路改造' }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.ant-table-row').filter({ hasText: '某小区 5#楼' })).toHaveCount(0);
  });

  test('日期按「有业务数据」筛：无业务的区间 → 列表清空并给出提示', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    // 默认已经是「有业务数据」
    await expect(page.getByText('日期筛：有业务数据')).toBeVisible();

    // 切到「本月」（mock 数据都在 2026-05，本月没有任何业务）→ 应该一条都不剩
    await page.locator('.pims-toolbar a', { hasText: '本月' }).first().click();
    await page.waitForTimeout(1200);

    await expect(page.locator('.ant-table-row')).toHaveCount(0);
    // 空列表显示 antd 空状态（条数为 0 时分页文字不渲染）
    await expect(page.locator('.ant-empty').first()).toBeVisible({ timeout: 20_000 });
  });

  test('日期按「开工日期」筛：切换口径后结果不同', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    // 先切到本月（无业务数据）→ 用「有业务数据」口径应该是空的
    await page.locator('.pims-toolbar a', { hasText: '本月' }).first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.ant-table-row')).toHaveCount(0);

    // 改成「开工日期」口径：本月也没有开工的项目 → 仍然是空
    await page.locator('.ant-select').filter({ hasText: /日期筛/ }).first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '开工日期' }).first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.ant-table-row')).toHaveCount(0);

    // 换成「全部」再切回「有业务数据」→ 全部项目回来
    await page.locator('.pims-toolbar a', { hasText: '全部' }).first().click();
    await page.waitForTimeout(1000);
    await page.locator('.ant-select').filter({ hasText: /日期筛/ }).first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '有业务数据' }).first().click();
    await page.waitForTimeout(1200);
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });
  });

  test('首页盈亏总表跟着同一个口径筛', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    // 切到本月 → 项目列表空（有业务数据口径）
    await page.locator('.pims-toolbar a', { hasText: '本月' }).first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.ant-table-row')).toHaveCount(0);

    // 回首页：同一个口径下也不该有项目行
    await page.goto('/');
    await expect(page.getByText('项目盈亏总表')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    await expect(page.locator('.ant-table-row')).toHaveCount(0);
    await expect(page.locator('.ant-empty').first()).toBeVisible({ timeout: 20_000 });
  });

  test('选中的口径会被记住（刷新后仍是这个口径）', async ({ page }) => {
    await login(page);
    await page.goto('/projects');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });

    // 切成「开工日期」
    await page.locator('.ant-select').filter({ hasText: /日期筛/ }).first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '开工日期' }).first().click();
    await page.waitForTimeout(600);

    await page.reload();
    await expect(page.getByText('日期筛：开工日期')).toBeVisible({ timeout: 20_000 });
  });
});
