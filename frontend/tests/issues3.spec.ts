import { expect, test } from '@playwright/test';
import { btn, dismissPaymentModal, field, gotoMenu, layer, login, pickProject, tab } from './helpers';

/**
 * 测试问题说明3（2026-10-16）：
 *   1. 垫付单点「去结算」报参数校验失败 —— 业务类型 advance_pay ≠ 结算类别 advance，要能正确映射
 *   2. 项目列表去掉「详情」按钮，除操作列外整行可点进详情
 *   3. 项目详情页要能编辑与删除
 *   4. 任何弹窗里按回车 = 点主按钮（不用鼠标找「确定」）
 */
test.describe('测试问题说明3', () => {
  test('1. 垫付单点「去结算」不再报参数错，能落在「垫付」页签', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录一笔垫付（会自动生成一张垫付应付单，业务类型是 advance_pay）
    await gotoMenu(page, '记账');
    await tab(page, '垫付').click();
    await btn(page, '新增垫付').click();
    const modal = layer(page);
    await field(page, '垫付人', modal).fill('垫付张三');
    await field(page, '金额', modal).fill('1200');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 往来 → 应付单 → 找到这笔垫付
    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    const row = page.locator('.ant-table-row').filter({ hasText: '垫付张三' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /去\s*结\s*算/ }).click();

    // 关键断言：不出现「参数校验失败」
    await expect(page).toHaveURL(/\/labor-settle/, { timeout: 15_000 });
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
    await expect(page.getByText(/参数校验失败/)).toHaveCount(0);

    // 落在「垫付」页签并定位到该垫付人
    await expect(page.locator('.ant-tabs-tab-active')).toContainText('垫付', { timeout: 20_000 });
    await expect(page.getByText(/已从「往来」跳到「垫付」的 垫付张三/)).toBeVisible({ timeout: 20_000 });

    // 生成预览也不再报错（报错时这里会弹红色提示）
    await btn(page, '生成结算预览').click();
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
  });

  test('2. 项目列表：没有「详情」按钮，点行其他位置进详情', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');

    // 列表里不该再有「详情」按钮
    await expect(page.locator('.ant-table-row').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /详\s*情/ })).toHaveCount(0);

    // 点「项目名称」列（操作列以外的位置）→ 进详情
    const firstRow = page.locator('.ant-table-row').first();
    const nameCell = firstRow.locator('td').first();
    const projectName = (await nameCell.innerText()).trim();
    await nameCell.click();
    await expect(page).toHaveURL(/\/projects\/\d+/, { timeout: 15_000 });
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 20_000 });
  });

  test('3. 项目详情页能编辑、能删除', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');

    // 新建一个专门用来改/删的项目
    await btn(page, '新建项目').click();
    let drawer = layer(page);
    await field(page, '项目名称', drawer).fill('详情页改删项目');
    await field(page, '甲方预算', drawer).fill('100000');
    await field(page, '我方成本预算', drawer).fill('80000');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-message').getByText('项目已创建')).toBeVisible({ timeout: 20_000 });

    // 进详情
    const row = page.locator('.ant-table-row').filter({ hasText: '详情页改删项目' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('td').first().click();
    await expect(page).toHaveURL(/\/projects\/\d+/, { timeout: 15_000 });

    // 详情页有「编辑」和「删除」
    await expect(page.getByRole('button', { name: /编\s*辑/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /删\s*除/ })).toBeVisible();

    // 编辑：改名并保存
    await page.getByRole('button', { name: /编\s*辑/ }).click();
    drawer = layer(page);
    await expect(drawer.getByText('编辑项目：详情页改删项目')).toBeVisible({ timeout: 10_000 });
    await field(page, '项目名称', drawer).fill('详情页改删项目-已改名');
    await btn(drawer, '保存').click();
    await expect(page.locator('.ant-message').getByText('项目已更新')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('详情页改删项目-已改名').first()).toBeVisible({ timeout: 20_000 });

    // 删除：确认后回到列表
    await page.getByRole('button', { name: /删\s*除/ }).click();
    const confirm = page.locator('.ant-modal-confirm').first();
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.getByRole('button', { name: /确认删除/ }).click();
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.locator('.ant-table-row').filter({ hasText: '详情页改删项目-已改名' })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('4. 弹窗里按回车等于点「确定」', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();

    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: /杂\s*费\s*小\s*类/ }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '伙食费' }).first().click();
    await field(page, '金额', modal).fill('3210');

    // 焦点留在金额输入框里，直接按回车（不点「确定」）
    await page.keyboard.press('Enter');

    // 弹窗应被提交：出现「登记已付」弹窗（说明成本已录入成功）
    const payModal = page.locator('.ant-modal-content:visible').filter({ hasText: '登记已付' }).first();
    await expect(payModal).toBeVisible({ timeout: 20_000 });

    // 这个弹窗里也按回车 → 等于点「登记」（而不是必须手动点）
    await page.keyboard.press('Enter');
    await expect(payModal).toBeHidden({ timeout: 20_000 });

    // 该笔已落库
    await expect(page.locator('.ant-table-row').filter({ hasText: '3,210.00' }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
  });

  test('4b. 多行备注里回车必须换行，而不是被当成确认提交', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');
    await btn(page, '新建项目').click();
    const drawer = layer(page);

    // 项目抽屉的「备注」是多行文本域
    const remark = drawer.locator('textarea').first();
    await remark.click();
    await remark.type('第一行');
    await page.keyboard.press('Enter');
    await remark.type('第二行');

    // 还在抽屉里（没被提交），且文本里确实有换行
    await expect(drawer).toBeVisible();
    const value = await remark.inputValue();
    expect(value, `备注内容：${JSON.stringify(value)}`).toContain('\n');
    expect(value).toContain('第一行');
    expect(value).toContain('第二行');
    // 没有被当作「保存」提交掉：不该出现"项目名称必填"这种校验提示，也不该关掉抽屉
    await expect(page.locator('.ant-message').getByText('项目已创建')).toHaveCount(0);
  });
});
