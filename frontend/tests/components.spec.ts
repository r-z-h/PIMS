import { expect, test } from '@playwright/test';
import { btn, field, gotoMenu, gotoPath, layer, login, loose, pickProject, row, tab, dismissPaymentModal } from './helpers';

test.describe('组件行为', () => {
  test('MoneyInput：千分位显示 + 两位小数 + 拒绝非法字符 + 提交去千分位', async ({ page }) => {
    await login(page);
    // 录入表单需要项目：先选顶部当前项目（表单会自动带入）
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '记账');
    await tab(page, '垫付').click();
    await btn(page, '新增垫付').click();
    const modal = layer(page);
    const amount = field(page, '金额', modal);

    // 超两位小数 → 截断为两位；千分位实时显示
    await amount.fill('1234567.8999');
    await expect(amount).toHaveValue('1,234,567.89');
    // 非法字符被拒
    await amount.fill('abc');
    await expect(amount).toHaveValue('');
    // 负号（金额不允许负数）：输入中显示 100，失焦后补两位小数
    await amount.fill('-100');
    await expect(amount).toHaveValue('100');
    await amount.blur();
    await expect(amount).toHaveValue('100.00');

    await field(page, '垫付事由', modal).fill('MoneyInput 校验');
    await amount.fill('1234567.89');
    await btn(modal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(row(page, 'MoneyInput 校验')).toBeVisible({ timeout: 20_000 });

    // 提交的是数字（去掉了千分位），Mock 库里应存 number 1234567.89
    const stored = await page.evaluate(() => {
      const w = window as unknown as {
        __PIMS_MOCK__?: { db?: { costs?: Array<{ purpose?: string; amount?: unknown }> } };
      };
      const found = w.__PIMS_MOCK__?.db?.costs?.find((c) => c.purpose === 'MoneyInput 校验');
      return found ? { type: typeof found.amount, value: found.amount } : null;
    });
    expect(stored, 'Mock 库中应能查到该成本').not.toBeNull();
    expect(stored?.type, '金额应以数字提交（无千分位字符串）').toBe('number');
    expect(stored?.value).toBe(1234567.89);
  });

  test('MoneyText：结算利润为负标红、利润列加粗', async ({ page }) => {
    await login(page);
    // 造一个负数场景：甲方预算 1,000 / 成本预算 0，再记一笔 5,000 杂费 → 结算利润 −4,000
    await gotoMenu(page, '项目');
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('负数项目');
    await field(page, '甲方预算', drawer).fill('1000');
    await field(page, '我方成本预算', drawer).fill('0');
    await btn(drawer, '保存').click();
    await expect(row(page, '负数项目')).toBeVisible({ timeout: 20_000 });

    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await modal.locator('.ant-form-item').filter({ hasText: '项目' }).locator('.ant-select').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '负数项目' })
      .first()
      .click();
    await field(page, '金额', modal).fill('5000');
    await modal.locator('.ant-form-item').filter({ hasText: '杂费小类' }).locator('.ant-select').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '伙食费' })
      .first()
      .click();
    await btn(modal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(page.locator('.ant-message').getByText(/杂费已录入/)).toBeVisible({ timeout: 20_000 });

    // 首页查看负数渲染
    await gotoMenu(page, '首页');
    const negativeCell = page.locator('.ant-table').first().getByText('-4,000.00').first();
    await expect(negativeCell).toBeVisible({ timeout: 20_000 });
    const style = await negativeCell.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, weight: cs.fontWeight };
    });
    expect(style.color, '负数应标红').toBe('rgb(207, 19, 34)');
    expect(Number(style.weight), '利润列应加粗').toBeGreaterThanOrEqual(600);
  });

  test('DateRangeBar：默认今年、可切换全部/自定义时段（start_date/end_date 来源）', async ({ page }) => {
    await login(page);
    const year = new Date().getFullYear();
    const startInput = page.locator('.pims-toolbar .ant-picker-input input').first();
    const endInput = page.locator('.pims-toolbar .ant-picker-input input').nth(1);

    // 默认今年（手册 5.2）
    await expect(startInput).toHaveValue(`${year}-01-01`);
    await expect(endInput).toHaveValue(`${year}-12-31`);

    // 点「全部」→ 清空区间
    await page.locator('.pims-toolbar').getByText('全部', { exact: true }).first().click();
    await expect(startInput).toHaveValue('');
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('pims.date_range'))).toBe('{}');

    // 选自定义区间 → 写入 start_date / end_date
    await startInput.click();
    await startInput.fill('2026-03-01');
    await page.keyboard.press('Enter');
    await endInput.fill('2026-06-30');
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('pims.date_range')))
      .toContain('2026-03-01');
    await expect(startInput).toHaveValue('2026-03-01');
    await expect(endInput).toHaveValue('2026-06-30');
  });

  test('DataTable：默认 20 条/页且展示总数（与后端 page/page_size 对齐）', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '收/付款');
    const pagination = page.locator('.ant-pagination').first();
    await expect(pagination).toBeVisible();
    await expect(pagination.locator('.ant-pagination-options .ant-select-selection-item')).toHaveText('20 条/页');
    await expect(pagination.getByText(/共 \d+ 条/)).toBeVisible();
  });

  test('DictSelect：可现场新增字典项并立即可选', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    const categoryItem = modal.locator('.ant-form-item').filter({ hasText: '杂费小类' });
    // 点「+」新增（新增弹窗叠在表单弹窗之上，按钮必须限定在新增弹窗内点，否则被遮挡）
    await categoryItem.locator('button').first().click();
    const addModal = layer(page);
    await addModal.locator('input').first().fill('Playwright 新小类');
    await btn(addModal, '确定').click();
    await expect(page.locator('.ant-message').getByText('已新增')).toBeVisible({ timeout: 20_000 });

    // 新项出现在下拉里且可选
    await categoryItem.locator('.ant-select').click();
    const option = page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: 'Playwright 新小类' });
    await expect(option.first()).toBeVisible();
    await option.first().click();
    await expect(categoryItem.locator('.ant-select-selection-item')).toHaveText('Playwright 新小类');
  });

  test('OffsetModal：未结金额自动带出、超额提示、合计与剩余实时计算', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '往来');
    await row(page, '某某置业').getByRole('button', { name: /收\s*款/ }).click();
    const modal = layer(page);
    const pending = modal.locator('.ant-table-tbody tr.ant-table-row').first();
    await expect(pending).toContainText('200,000.00');
    await pending.locator('.ant-checkbox-input').check();
    await expect(modal).toContainText('本次冲销合计：200,000.00');

    // 手工改成超过未结金额 → 红字提示（输入中显示千分位，失焦后才补两位小数）
    const offsetInput = pending.locator('input.ant-input').last();
    await offsetInput.fill('300000');
    await expect(pending).toContainText('超过未结金额');
    await expect(offsetInput).toHaveValue('300,000');

    // 改成 50,000 → 合计与剩余同步；「本次收付金额」是上限，显式设回 200,000 后剩余应为 150,000
    await offsetInput.fill('50000');
    await field(page, '本次收付金额', modal).fill('200000');
    await expect(modal).toContainText('本次冲销合计：50,000.00');
    await expect(modal).toContainText('剩余（预收/预付）');
    await expect(modal.getByText('150,000.00').first()).toBeVisible();
  });

  test('ProjectSelect：顶部切换当前项目并持久化，页面跟随过滤', async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.removeItem('pims.current_project_id'));
    await pickProject(page, '市政道路改造');
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('pims.current_project_id')))
      .toBe('2');

    await gotoPath(page, '/inventory', '库存余量');
    await expect(page.locator('.ant-table').first().getByText('砂子').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ant-table').first().getByText('水泥')).toHaveCount(0);
  });

  test('ChangeLogTimeline：五类成本修改留痕（新增 + 修改）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await field(page, '金额', modal).fill('100');
    await modal.locator('.ant-form-item').filter({ hasText: '杂费小类' }).locator('.ant-select').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '罚款' })
      .first()
      .click();
    await btn(modal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(page.locator('.ant-message').getByText(/杂费已录入/)).toBeVisible({ timeout: 20_000 });

    const target = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: loose('罚款') }).first();
    await target.getByRole('button', { name: /修改记录/ }).click();
    await expect(page.locator('.ant-timeline-item')).toHaveCount(1);
    await page.locator('.ant-drawer-close').first().click();

    // 改一次 → 时间线应变成 2 条
    await target.getByRole('button', { name: /编\s*辑/ }).click();
    const editModal = layer(page);
    await field(page, '金额', editModal).fill('200');
    await btn(editModal, '确定').click();
    await expect(page.locator('.ant-message').getByText(/已保存/)).toBeVisible({ timeout: 20_000 });

    const updated = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: loose('罚款') }).first();
    await updated.getByRole('button', { name: /修改记录/ }).click();
    await expect(page.locator('.ant-timeline-item')).toHaveCount(2);
    await expect(page.locator('.ant-drawer-content')).toContainText('金额');
  });
});