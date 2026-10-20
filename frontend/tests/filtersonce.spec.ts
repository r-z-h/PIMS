import { expect, test } from '@playwright/test';
import { gotoMenu, login } from './helpers';

/**
 * 筛选入口去重（2026-10-19 用户反馈）。
 *
 * 反馈原话：「你说有用，但我在项目界面之下点击一个项目之后，下面还是显示的全部啊」
 * 以及「你先看一下是不是每个页面都多这一个筛选框啊」。
 *
 * 根因：顶部固定区有「项目 + 日期」，各页面工具栏又各做了一份，**都绑同一份全局状态**，
 * 于是同一维度在同一屏上出现两个可编辑入口，用户自然认为其中一个是废的。
 *
 * 收敛后的规则：
 * - 「项目」只在顶部（跨页面的当前项目身份，项目详情页切换项目也靠它）
 * - 「时间段」只在页面工具栏（sticky，表格滚动后仍可改）
 *
 * 这条测试就是防止以后再长出第二个入口。
 */
const PAGES = [
  ['首页', '/'],
  ['项目', '/projects'],
  ['记账', '/bookkeeping'],
  ['收/付款', '/payments'],
  ['成本', '/costs'],
  ['往来', '/arap'],
  ['库存', '/inventory'],
  ['结算', '/labor-settle'],
  ['快速查询', '/quick-query'],
] as const;

test.describe('筛选入口唯一', () => {
  for (const [menu, path] of PAGES) {
    test(`${menu}页：项目和日期各只有一个入口`, async ({ page }) => {
      await login(page);
      await gotoMenu(page, menu);
      await expect(page).toHaveURL(new RegExp(`${path}$`));

      // 项目选择器：只在顶部，页面工具栏里不许再有一个
      await expect(page.locator('.pims-header .pims-project-select')).toHaveCount(1);
      await expect(page.locator('.pims-toolbar .pims-project-select')).toHaveCount(0);

      // 日期框：只在页面工具栏，顶部不许再有一个
      await expect(page.locator('.pims-toolbar .ant-picker-range')).toHaveCount(1);
      await expect(page.locator('.pims-header .ant-picker-range')).toHaveCount(0);
    });
  }

  test('设置页：本来就不需要日期筛选，不该出现日期框', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '设置');
    await expect(page.locator('.ant-picker-range')).toHaveCount(0);
  });

  test('入口只有一个，但改了仍然生效（不是摆设）', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });
    const before = await page.locator('.ant-table-row').count();
    expect(before).toBeGreaterThan(0);

    // 改成「有业务数据 + 本月」（mock 数据都在 2026-05，本月没有任何业务）
    await page.locator('.pims-toolbar a', { hasText: '本月' }).first().click();
    await page.waitForTimeout(1200);
    await expect(page.locator('.ant-table-row')).toHaveCount(0);
  });
});
