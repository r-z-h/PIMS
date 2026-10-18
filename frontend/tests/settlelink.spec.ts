import { expect, test } from '@playwright/test';
import { btn, dismissPaymentModal, field, gotoMenu, layer, login, pickProject, tab } from './helpers';

/**
 * 结算与往来是同一本账（需求 T6 + T7 + T8）：
 *   T7：往来页**人工费**应付单的付款按钮改成「去结算」，点它跳到结算页（不再直接付）
 *   T8：非人工费（材料/机械/杂费/垫付）仍然在往来页直接付款
 *   T6：结算页「登记发放」会生成付款流水并自动冲销该工人的应付单
 */
test.describe('结算接账与往来跳转', () => {
  test('应付单：往来页显示「去结算」并跳到结算页对应类别；材料费也是跳转', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录一笔人工（会自动生成一张人工费应付单）
    await gotoMenu(page, '记账');
    await tab(page, '人工').click();
    await btn(page, '新增人工').click();
    const modal = layer(page);
    await field(page, '姓名', modal).fill('结算跳转张三');
    await field(page, '工日数', modal).fill('2');
    await field(page, '日工价', modal).fill('300');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 往来 → 应付单
    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    const laborRow = page.locator('.ant-table-row').filter({ hasText: '结算跳转张三' }).first();
    await expect(laborRow).toBeVisible({ timeout: 20_000 });

    // T7（2026-10-16 扩展）：**所有**应付单都是「去结算」，不再有「付款」
    await expect(laborRow.getByRole('button', { name: /去\s*结\s*算/ })).toBeVisible();
    await expect(laborRow.getByRole('button', { name: /付\s*款/ })).toHaveCount(0);

    // 材料款应付单也是「去结算」（以前是「付款」）
    const materialRow = page.locator('.ant-table-row').filter({ hasText: '材料款' }).first();
    if (await materialRow.count()) {
      await expect(materialRow.getByRole('button', { name: /去\s*结\s*算/ }).first()).toBeVisible();
      await expect(materialRow.getByRole('button', { name: /付\s*款/ })).toHaveCount(0);
    }

    // T7：点「去结算」→ 跳到结算页、切到「人工」页签、只看这一个对象
    await laborRow.getByRole('button', { name: /去\s*结\s*算/ }).click();
    await expect(page).toHaveURL(/\/labor-settle/, { timeout: 15_000 });
    await expect(page.getByText(/已从「往来」跳到「人工」的 结算跳转张三/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: '生成结算预览' })).toBeVisible();
    // 页签存在且当前是人工
    await expect(page.locator('.ant-tabs-tab-active')).toContainText('人工');

    // 点「显示全部」可取消筛选
    await btn(page, '显示全部').click();
    await expect(page.getByText(/已从「往来」跳到/)).toHaveCount(0);
  });

  test('材料款应付单跳过去会切到「材料」页签并按供应商定位', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录一笔材料（会自动生成材料款应付单 + 入库）
    await gotoMenu(page, '记账');
    await tab(page, '材料').click();
    await btn(page, '新增材料').click();
    const modal = layer(page);
    await modal.locator('.ant-form-item').filter({ hasText: '材料名称' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '水泥' }).first().click();
    await modal.locator('.ant-form-item').filter({ hasText: '单位' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '吨' }).first().click();
    await field(page, '数量', modal).fill('2');
    await field(page, '单价', modal).fill('500');
    // 填供应商，跳转时要按它定位
    await field(page, '供应商', modal).fill('结算跳转建材商');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    const row = page.locator('.ant-table-row').filter({ hasText: '结算跳转建材商' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /去\s*结\s*算/ }).click();

    await expect(page).toHaveURL(/\/labor-settle/, { timeout: 15_000 });
    // 自动切到「材料」页签，并按供应商定位
    await expect(page.locator('.ant-tabs-tab-active')).toContainText('材料', { timeout: 20_000 });
    await expect(page.getByText(/已从「往来」跳到「材料」的 结算跳转建材商/)).toBeVisible({ timeout: 20_000 });
  });

  test('结算页登记发放 → 生成付款流水并冲销该工人的应付单', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录 5 工天 × 300 = 1500
    await gotoMenu(page, '记账');
    await tab(page, '人工').click();
    await btn(page, '新增人工').click();
    const modal = layer(page);
    await field(page, '姓名', modal).fill('发放联动李四');
    await field(page, '工日数', modal).fill('5');
    await field(page, '日工价', modal).fill('300');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 结算页：预览 → 保存结算单
    await gotoMenu(page, '结算');
    await btn(page, '生成结算预览').click();
    await expect(page.getByText('发放联动李四').first()).toBeVisible({ timeout: 20_000 });
    await btn(page, '保存结算单').click();
    await expect(page.locator('.ant-message').getByText(/结算单|已保存/).first()).toBeVisible({ timeout: 20_000 });

    // 2026-10-16 起：发放按钮在「欠款总览」表（一对象一行，累计口径），不在结算单快照里
    // —— 因为上限要用"真实还欠多少"，那个数只有总览才有
    const overviewTable = page.locator('.ant-table').first();
    await expect(overviewTable).toContainText('欠款总览', { timeout: 20_000 }).catch(() => undefined);
    const overviewRow = overviewTable.locator('.ant-table-row').filter({ hasText: '发放联动李四' }).first();
    await expect(overviewRow).toBeVisible({ timeout: 20_000 });
    // 应付 1500、已付 0、还欠 1500
    await expect(overviewRow).toContainText('1,500.00');
    await overviewRow.getByRole('button', { name: /登记发放/ }).click();

    const payModal = page.locator('.ant-modal-content:visible').filter({ hasText: '登记发放' }).first();
    await expect(payModal).toBeVisible({ timeout: 10_000 });
    // 弹窗里要写清上限
    await expect(payModal).toContainText('最多可发');
    await btn(payModal, '确定').click();

    // T6：发放后明确告知"已生成付款流水并冲销应付单"
    const resultModal = page.locator('.ant-modal-content:visible').filter({ hasText: '已冲销对应应付单' }).first();
    await expect(resultModal).toBeVisible({ timeout: 20_000 });
    await expect(resultModal).toContainText('已生成一笔付款流水');
    await expect(resultModal).toContainText('冲销该对象对应的应付单');
    await btn(resultModal, '知道了').click();

    // 总览立刻反映：已付 1500、还欠 0（默认过滤掉已结清的行，勾选后能看到）
    await expect(overviewRow).toHaveCount(0, { timeout: 20_000 });
    await page.getByLabel('含已结清').check();
    const settledRow = page.locator('.ant-table').first().locator('.ant-table-row').filter({ hasText: '发放联动李四' }).first();
    await expect(settledRow).toBeVisible({ timeout: 20_000 });
    await expect(settledRow).toContainText('已结清');
    // 付款方式构成里应出现「微信」（弹窗里默认选的就是微信）
    await expect(settledRow).toContainText('微信');

    // 往来页：该工人那张应付单应已结清（结算与往来同一本账）
    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    const arapRow = page.locator('.ant-table-row').filter({ hasText: '发放联动李四' }).first();
    await expect(arapRow).toBeVisible({ timeout: 20_000 });
    await expect(arapRow).toContainText('1,500.00');
    await expect(arapRow).toContainText('已结清');
    await expect(arapRow).toContainText('0.00');

    // 收/付款页：能看到这笔发放生成的付款流水（默认停「付款」）
    await gotoMenu(page, '收/付款');
    await expect(
      page.locator('.ant-table-row').filter({ hasText: '发放联动李四' }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('在别处付过一部分后，总览要跟着变，且发放上限收紧（用户实测 bug 回归）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录 15 工天 × 300 = 4500（对应"沈八"那个场景）
    await gotoMenu(page, '记账');
    await tab(page, '人工').click();
    await btn(page, '新增人工').click();
    const modal = layer(page);
    await field(page, '姓名', modal).fill('总览回归王五');
    await field(page, '工日数', modal).fill('15');
    await field(page, '日工价', modal).fill('300');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 从「收/付款」页付 500（这条路径**不碰结算单**，正是原来出 bug 的地方）。
    // 保存后会弹预冲窗口并自动勾选；这里先把自动勾的勾全部取消，只留自己那一笔。
    await gotoMenu(page, '收/付款');
    await btn(page, '新增付款').click();
    const payCreate = layer(page);
    await field(page, '金额', payCreate).fill('500');
    await payCreate.locator('.ant-form-item').filter({ hasText: '对方' }).locator('input').first().fill('总览回归王五');
    await btn(payCreate, '确定').click();

    const preOffset = page.locator('.ant-modal-content:visible').filter({ hasText: '应付冲销 · 付款' }).first();
    await expect(preOffset).toBeVisible({ timeout: 20_000 });
    // 等两行都渲染出来，再动勾选（否则会跟窗口自己的初始化抢）
    const targetRow = preOffset.locator('.ant-table-row').filter({ hasText: '总览回归王五' }).first();
    await expect(targetRow).toBeVisible({ timeout: 20_000 });

    // 取消所有非目标行的勾选（取消后金额框会禁用，不要去填它）
    for (let i = 0; i < (await preOffset.locator('.ant-table-row').count()); i += 1) {
      const r = preOffset.locator('.ant-table-row').nth(i);
      if ((await r.innerText()).includes('总览回归王五')) continue;
      const box = r.locator('.ant-checkbox-input');
      if (await box.isChecked()) await box.uncheck();
      await expect(box).not.toBeChecked();
    }
    // 勾上目标行：系统会自动把金额填成"剩余待冲"（正好 500）
    await targetRow.locator('.ant-checkbox-input').check();
    await expect(targetRow.locator('input.ant-input').first()).toHaveValue('500.00');
    await expect(preOffset).toContainText('本次冲销合计：500.00');
    await btn(preOffset, '确认冲销').click();

    // 冲销完成 → 关掉结果窗（它是阻断式的，不关会挡住左侧菜单点不动）
    const doneModal = page.locator('.ant-modal-content:visible').filter({ hasText: '冲销完成' }).first();
    await expect(doneModal).toBeVisible({ timeout: 20_000 });
    await expect(doneModal).toContainText('合计 500.00');
    await btn(doneModal, '知道了').click();
    await expect(doneModal).toBeHidden({ timeout: 20_000 });

    // 结算页的欠款总览必须与应付单一致：1500 场景改成 4500 / 500 / 4000
    await gotoMenu(page, '结算');
    const overviewRow = page
      .locator('.ant-table')
      .first()
      .locator('.ant-table-row')
      .filter({ hasText: '总览回归王五' })
      .first();
    await expect(overviewRow).toBeVisible({ timeout: 20_000 });
    await expect(overviewRow).toContainText('4,500.00'); // 累计应付
    await expect(overviewRow).toContainText('500.00'); // 累计已付（旧实现这里是 0）
    await expect(overviewRow).toContainText('4,000.00'); // 还欠（旧实现这里是 4500）
    await expect(overviewRow).toContainText('部分');

    // 发放上限也收紧到 4000：填 4500 应被拦住
    await overviewRow.getByRole('button', { name: /登记发放/ }).click();
    const payModal = page.locator('.ant-modal-content:visible').filter({ hasText: '登记发放' }).first();
    await expect(payModal).toContainText('最多可发');
    // 弹窗默认就把"还欠"填进去了（4000，带千分位显示），这里故意改成 4500 试上限
    await expect(payModal.locator('input').first()).toHaveValue('4,000.00');
    await payModal.locator('input').first().fill('4500');
    await btn(payModal, '确定').click();
    // 后端拒绝 → 弹错误提示，弹窗不关
    await expect(page.locator('.ant-message-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/超过未结欠款/).first()).toBeVisible({ timeout: 20_000 });
  });
});
