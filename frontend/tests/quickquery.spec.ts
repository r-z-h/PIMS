import { expect, test } from '@playwright/test';
import { btn, login, pickProject } from './helpers';

// 这组用例要真后端 + 造数脚本（见文件头）。默认 mock 套件里跳过，
// 否则永远是红的、还会掩盖真正的回归（2026-10-19 记录）。
test.skip(!process.env.PIMS_REAL, '需要 PIMS_REAL=1 + 真后端 + scripts/seed_quick_query_demo.py');

/**
 * 快速查询（2026-10-19 需求）—— 真实后端版本。
 *
 * 运行前提：后端已起在 PIMS_BASE，并执行过 scripts/seed_quick_query_demo.py。
 *   $env:PIMS_BASE='http://127.0.0.1:8899'; $env:PIMS_NO_WEBSERVER='1'
 */

const QUERY_MENU = '快速查询';
/** 三个快速查询用例共用一个造数项目 */
const PROJECT = '排序验证项目';

test.describe('快速查询', () => {
  test('侧边栏有入口，默认全选，只勾一项就只出一张表', async ({ page }) => {
    await login(page);
    await pickProject(page, PROJECT);

    await page.locator('.ant-menu-item').filter({ hasText: QUERY_MENU }).first().click();
    await expect(page).toHaveURL(/quick-query/);

    // 默认全选：三个勾选框都选中
    const boxes = page.locator('.ant-checkbox-wrapper');
    await expect(boxes).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(boxes.nth(i).locator('input')).toBeChecked();
    }

    // 全选状态 → 按钮显示「清空」
    await expect(btn(page, '清空')).toBeVisible();

    // 全选 → 点查询，应出 3 张卡片
    await btn(page, '查询').click();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '工人未结款' })).toBeVisible();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '成本与预算' })).toBeVisible();

    // 清空后按钮变「全选」
    await btn(page, '清空').click();
    await expect(btn(page, '全选')).toBeVisible();
    // 清空后查询按钮禁用
    await expect(btn(page, '查询')).toBeDisabled();

    // 只勾「工人未结款」
    await boxes.nth(0).click();
    await expect(btn(page, '查询')).toBeEnabled();
    await btn(page, '查询').click();

    await expect(page.locator('.ant-card-head-title').filter({ hasText: '工人未结款' })).toBeVisible();
    // 其他两项不渲染
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '成本与预算' })).toHaveCount(0);
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '往来未结' })).toHaveCount(0);
  });

  test('全选查询三张表都在，且无错误提示', async ({ page }) => {
    await login(page);
    await pickProject(page, PROJECT);
    await page.goto('/quick-query');
    await expect(page.locator('.ant-checkbox-wrapper').first()).toBeVisible({ timeout: 15_000 });

    await btn(page, '查询').click();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '工人未结款' })).toBeVisible();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '往来未结' })).toBeVisible();
    await expect(page.locator('.ant-card-head-title').filter({ hasText: '成本与预算' })).toBeVisible();

    await expect(page.locator('.ant-message-error')).toHaveCount(0);
  });

  test('未选项目时提示先选项目', async ({ page }) => {
    await login(page);
    await page.goto('/quick-query');
    await expect(page.locator('.ant-checkbox-wrapper').first()).toBeVisible({ timeout: 15_000 });

    // 顶部切到「全部项目」
    const select = page.locator('.pims-header .ant-select').first();
    await select.click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '全部项目' })
      .first()
      .click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('请先在顶部选择一个项目')).toBeVisible({ timeout: 10_000 });
    await expect(btn(page, '查询')).toBeDisabled();
  });
});

