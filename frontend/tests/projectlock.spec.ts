import { expect, test } from '@playwright/test';
import { btn, dismissPaymentModal, field, gotoMenu, layer, login, pickProject, tab } from './helpers';

/**
 * 项目完工锁（2026-10-17 需求）。
 *
 * 口径：
 * - 完工后**所有写操作**都要先解锁
 * - 解锁 = 输**登录密码**；解锁后一直有效，直到手动「重新锁定」
 * - 正在操作时被拦 → 弹密码框 → 解锁 → **自动重试刚才那次操作**
 */
test.describe('项目完工锁', () => {
  test('完工 → 改成本被拦 → 输密码解锁 → 自动重试成功', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');

    // 建一个专门用来完工的项目
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('完工锁测试项目');
    await field(page, '甲方预算', drawer).fill('100000');
    await field(page, '我方成本预算', drawer).fill('80000');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-message').getByText('项目已创建')).toBeVisible({ timeout: 20_000 });

    const row = page.locator('.ant-table-row').filter({ hasText: '完工锁测试项目' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('在建');

    // 点「完工」→ 确认
    await row.getByRole('button', { name: /完\s*工/ }).click();
    const confirm = page.locator('.ant-modal-confirm').first();
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await expect(confirm).toContainText('所有改动都要先输入密码解锁');
    await confirm.getByRole('button', { name: /确认完工/ }).click();
    await expect(page.locator('.ant-message').getByText(/已标记完工/)).toBeVisible({ timeout: 20_000 });

    // 状态标签应变成「完工·已锁」
    await expect(row).toContainText('完工·已锁', { timeout: 20_000 });
    // 操作列也该出现「撤销完工」「解锁」
    await expect(row.getByRole('button', { name: /撤销完工/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /解\s*锁/ })).toBeVisible();

    // 切到该项目，去录一笔成本 → 应弹密码框
    await page.locator('.ant-table-row').filter({ hasText: '完工锁测试项目' }).first().locator('td').first().click();
    await expect(page).toHaveURL(/\/projects\/\d+/, { timeout: 15_000 });
    // 详情页应有锁定提示（靠后端返回的 is_locked）
    await expect(page.getByText(/项目已完工并锁定/).first()).toBeVisible({ timeout: 20_000 });

    // 关键：把当前项目切到"完工锁测试项目"，否则成本会录到别的项目上
    await pickProject(page, '完工锁测试项目');
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const costModal = layer(page);
    await costModal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: /杂\s*费\s*小\s*类/ }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '伙食费' }).first().click();
    await field(page, '金额', costModal).fill('777');
    await btn(costModal, '确定').click();

    // 被锁 → 自动弹密码框（这就是关键链路）
    const pwdModal = page.locator('.ant-modal-content:visible').filter({ hasText: '项目已完工，需要解锁' }).first();
    await expect(pwdModal).toBeVisible({ timeout: 20_000 });
    await expect(pwdModal).toContainText('改完请在项目页点「重新锁定」');

    // 输错密码 → 报错，弹窗留着
    await pwdModal.locator('input[type="password"], input').first().fill('wrong');
    await btn(pwdModal, '解锁并继续').click();
    await expect(page.locator('.ant-message-error')).toBeVisible({ timeout: 20_000 });
    await expect(pwdModal).toBeVisible();

    // 输对密码 → 解锁并**自动重试**刚才那笔新增成本
    await pwdModal.locator('input[type="password"], input').first().fill('123456');
    await btn(pwdModal, '解锁并继续').click();
    await expect(pwdModal).toBeHidden({ timeout: 20_000 });

    // 自动重试成功：成本已写入（777）
    await expect(page.locator('.ant-table-row').filter({ hasText: '777.00' }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('解锁后一直有效；重新锁定后又会被拦', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');

    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('完工锁-重新锁定');
    await field(page, '甲方预算', drawer).fill('100000');
    await field(page, '我方成本预算', drawer).fill('80000');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-message').getByText('项目已创建')).toBeVisible({ timeout: 20_000 });

    const row = page.locator('.ant-table-row').filter({ hasText: '完工锁-重新锁定' }).first();
    await row.getByRole('button', { name: /完\s*工/ }).click();
    await page.locator('.ant-modal-confirm').first().getByRole('button', { name: /确认完工/ }).click();
    await expect(row).toContainText('完工·已锁', { timeout: 20_000 });

    // 先在项目页直接解锁
    await row.getByRole('button', { name: /解\s*锁/ }).click();
    const pwd = page.locator('.ant-modal-content:visible').filter({ hasText: '解锁：' }).first();
    await expect(pwd).toBeVisible({ timeout: 10_000 });
    await pwd.locator('input').first().fill('123456');
    await btn(pwd, '解 锁').click();
    await expect(row).toContainText('完工·已解锁', { timeout: 20_000 });

    // 解锁状态下录成本：不该再弹密码框
    await page.locator('.ant-table-row').filter({ hasText: '完工锁-重新锁定' }).first().locator('td').first().click();
    await expect(page).toHaveURL(/\/projects\/\d+/, { timeout: 15_000 });
    await pickProject(page, '完工锁-重新锁定');
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const costModal = layer(page);
    await costModal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: /杂\s*费\s*小\s*类/ }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '伙食费' }).first().click();
    await field(page, '金额', costModal).fill('888');
    await btn(costModal, '确定').click();
    // 录完成本会自动弹「登记已付」，先关掉，否则挡住左侧菜单
    await dismissPaymentModal(page);
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
    await expect(page.locator('.ant-table-row').filter({ hasText: '888.00' }).first()).toBeVisible({
      timeout: 20_000,
    });

    // 回项目页重新锁定
    await gotoMenu(page, '项目');
    const row2 = page.locator('.ant-table-row').filter({ hasText: '完工锁-重新锁定' }).first();
    await expect(row2).toContainText('完工·已解锁', { timeout: 20_000 });
    await row2.locator('td').first().click();
    await page.locator('.ant-message').getByText('已解锁，改完记得重新锁定').first().waitFor({ state: 'hidden' }).catch(() => undefined);
    await expect(page).toHaveURL(/\/projects\/\d+/, { timeout: 15_000 });
    await btn(page, '重新锁定').click();
    const lockConfirm = page.locator('.ant-modal-confirm').first();
    await expect(lockConfirm).toBeVisible({ timeout: 10_000 });
    await lockConfirm.getByRole('button', { name: /锁\s*定/ }).click();
    await expect(page.getByText(/已重新锁定/)).toBeVisible({ timeout: 20_000 });
    // 锁定后又出现提示
    await expect(page.getByText(/项目已完工并锁定/).first()).toBeVisible({ timeout: 20_000 });
  });

  test('撤销完工需要密码，撤销后不再锁', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');

    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('完工锁-撤销');
    await field(page, '甲方预算', drawer).fill('100000');
    await field(page, '我方成本预算', drawer).fill('80000');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-message').getByText('项目已创建')).toBeVisible({ timeout: 20_000 });

    const row = page.locator('.ant-table-row').filter({ hasText: '完工锁-撤销' }).first();
    await row.getByRole('button', { name: /完\s*工/ }).click();
    await page.locator('.ant-modal-confirm').first().getByRole('button', { name: /确认完工/ }).click();
    await expect(row).toContainText('完工·已锁', { timeout: 20_000 });

    // 撤销完工 → 要密码
    await row.getByRole('button', { name: /撤销完工/ }).click();
    const pwd = page.locator('.ant-modal-content:visible').filter({ hasText: '撤销完工：' }).first();
    await expect(pwd).toBeVisible({ timeout: 10_000 });
    await expect(pwd).toContainText('撤销完工后，项目变回「在建」');

    // 先输错
    await pwd.locator('input').first().fill('bad');
    await btn(pwd, '确认撤销完工').click();
    await expect(page.locator('.ant-message-error')).toBeVisible({ timeout: 20_000 });

    // 再输对
    await pwd.locator('input').first().fill('123456');
    await btn(pwd, '确认撤销完工').click();
    await expect(page.locator('.ant-message').getByText(/已撤销完工/)).toBeVisible({ timeout: 20_000 });

    // 变回在建，不再有「完工·已锁」标签，也不再有撤销按钮
    await expect(row).toContainText('在建', { timeout: 20_000 });
    await expect(row).not.toContainText('完工·已锁');
    await expect(row.getByRole('button', { name: /撤销完工/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /完\s*工/ })).toBeVisible();
  });
});
