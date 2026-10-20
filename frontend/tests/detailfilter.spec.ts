import { expect, test } from '@playwright/test';
import { gotoMenu, login, pickProject } from './helpers';

/**
 * 顶部筛选与「项目详情」页的联动（2026-10-17 用户反馈）。
 *
 * 反馈原话：「点进项目详情之后在上方切换项目，但页面不跟着切换，而且换日期也不更新页面」。
 *
 * 实测结论：
 * - **日期是好的**（点「本月」实际成本变 0，点「全部」恢复）——之前看着"没变"是因为
 *   该项目的成本全在同一个月里，"今年"和"本月"算出来一样
 * - **切换项目确实是坏的**：详情页只看 URL，改顶部选择器不影响它（已修）
 */
test.describe('项目详情与顶部筛选', () => {
  test('顶部切换项目 → 详情页跟着跳到该项目', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await page.goto('/projects/1');
    // 等详情页真的渲染出来（用详情页专属的区块标题，别用项目名——它在顶部选择器里也有一份）
    await expect(page.getByText('预算与利润')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/projects\/1/);

    // 顶部选择器切到另一个项目
    await page.locator('.pims-header .ant-select-selector').first().click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '市政道路改造' })
      .first()
      .click();

    // URL 与页面内容都要跟着变
    await expect(page).toHaveURL(/\/projects\/2/, { timeout: 15_000 });
    // 详情页里的项目名称行应显示新项目
    await expect(page.locator('.pims-page-body')).toContainText('市政道路改造', { timeout: 20_000 });
  });

  test('直接打开详情 URL → 顶部选择器同步成这个项目（不错位）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 直接访问项目 2 的详情（当前选中的是项目 1）
    await page.goto('/projects/2');
    await expect(page.getByText('市政道路改造').first()).toBeVisible({ timeout: 20_000 });

    // 顶部选择器应显示市政道路改造，而不是还停在项目 1
    const headerText = await page.locator('.pims-header').innerText();
    expect(headerText).toContain('市政道路改造');

    // 而且不该因为"同步"又被弹回去（URL 仍应是 2）
    await page.waitForTimeout(600);
    await expect(page).toHaveURL(/\/projects\/2/);
  });

  test('改日期会重新取数（本月 → 0，全部 → 恢复）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await page.goto('/projects/1');
    await page.waitForTimeout(800);

    const actualCost = () =>
      page.evaluate(() => {
        const m = document.body.innerText.match(/实际成本（五类之和）\s*([\d,]+\.\d{2})/);
        return m ? m[1] : '(未找到)';
      });

    const before = await actualCost();
    expect(before, '默认应能看到实际成本').not.toBe('(未找到)');
    expect(before).not.toBe('0.00');

    // mock 的项目 1 成本都在 2026-05；点「本月」（now）应筛成 0
    await page.locator('.pims-toolbar a', { hasText: '本月' }).first().click();
    await page.waitForTimeout(1000);
    expect(await actualCost(), '切到本月后应重新取数（mock 数据不在本月，应为 0.00）').toBe('0.00');

    // 点「全部」恢复
    await page.locator('.pims-toolbar a', { hasText: '全部' }).first().click();
    await page.waitForTimeout(1000);
    expect(await actualCost(), '改回全部应恢复全部数据').toBe(before);
  });

  test('项目列表点行进详情时，顶部选择器也同步', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '项目');

    const row = page.locator('.ant-table-row').filter({ hasText: '市政道路改造' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('td').first().click();

    await expect(page).toHaveURL(/\/projects\/2/, { timeout: 15_000 });
    const headerText = await page.locator('.pims-header').innerText();
    expect(headerText).toContain('市政道路改造');
  });
});
