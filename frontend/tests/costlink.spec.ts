import { expect, test } from '@playwright/test';
import { btn, dismissPaymentModal, field, gotoMenu, layer, login, loose, pickProject, tab } from './helpers';

/**
 * 「关联成本」列（需求 T3）：
 *   库存流水里的「关联成本」原来只显示光秃秃的 `#17`，
 *   现在要显示成 `#17（材料 · 水泥 40,000.00）`，id 可点击跳到该笔成本，悬停能看到摘要。
 *   没有关联成本的行（材料领用 / 手工单据）保持 `-`。
 */
test.describe('关联成本列', () => {
  test('库存流水显示「#id（类别 · 对象 金额）」，悬停有摘要、点击跳到该笔成本', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 先录一笔材料采购（会同时生成入库流水与应付单）
    await gotoMenu(page, '记账');
    await tab(page, '材料').click();
    await btn(page, '新增材料').click();
    const modal = layer(page);
    await modal.locator('.ant-form-item').filter({ hasText: '材料名称' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '水泥' }).first().click();
    await modal.locator('.ant-form-item').filter({ hasText: '单位' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '吨' }).first().click();
    await field(page, '数量', modal).fill('10');
    await field(page, '单价', modal).fill('500');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 到库存页看「关联成本」列。列表按日期倒序，刚录的那笔在最上面
    await gotoMenu(page, '库存');
    await tab(page, '库存流水').click();

    const targetRow = page
      .locator('.ant-table-row')
      .filter({ hasText: '材料 · 水泥 5,000.00' })
      .first();
    await expect(targetRow).toBeVisible({ timeout: 20_000 });

    // ① 不再是光秃秃的 #id，而是带上了类别 · 对象 金额
    const link = targetRow.locator('a.ant-typography').first();
    await expect(link).toBeVisible();
    const costId = (await link.innerText()).trim();
    expect(costId).toMatch(/^#\d+$/);
    await expect(targetRow).toContainText('材料 · 水泥');
    await expect(targetRow).toContainText('5,000.00');

    // ② 悬停显示该笔成本的摘要（类别 / 对象 / 金额 / 日期）
    await link.hover();
    const popover = page.locator('.ant-popover:visible').first();
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await expect(popover).toContainText(`成本 ${costId}`);
    await expect(popover).toContainText('材料');
    await expect(popover).toContainText('水泥');
    await expect(popover).toContainText('5,000.00');

    // ③ 点 id 跳到该笔成本：应落到记账页「材料」页签并高亮那一行
    await link.click();
    await expect(page).toHaveURL(/\/bookkeeping/, { timeout: 15_000 });
    await expect(page.locator('.ant-tabs-tab-active')).toContainText('材料', { timeout: 15_000 });
    await expect(page.locator('tr.pims-row-focus')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('tr.pims-row-focus')).toContainText('水泥');
  });

  test('没有关联成本的行显示「-」，不报错', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '库存');
    await tab(page, '库存流水').click();

    // 领用流水没有关联成本
    const outRow = page.locator('.ant-table-row').filter({ hasText: '领用' }).first();
    await expect(outRow).toBeVisible({ timeout: 20_000 });
    await expect(outRow.locator('a.ant-typography')).toHaveCount(0);
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
  });
});
