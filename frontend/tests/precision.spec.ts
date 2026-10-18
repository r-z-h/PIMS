import { expect, test } from '@playwright/test';
import { btn, field, gotoMenu, layer, login, pickProject, row, tab, dismissPaymentModal } from './helpers';

/**
 * 第二轮自检：真实尺度数字在「浏览器 ↔ mock 库」往返后是否仍然精确。
 *
 * 为什么单独写：其余用例大量使用「整万」这类好数（如 100 吨 × 400 = 40,000），
 * 会掩盖带小数、三位小数数量、半个工日这些真实场景 —— 而老板一眼就能看出差几分钱。
 * 这里的数字都走 UI 录入，并对 mock 库里的落库值单独断言（避免"显示对、存错"）。
 */

/** 直接读 mock 库里的某条成本（金额必须是 number，且数值精确） */
async function storedCost(page: import('@playwright/test').Page, matcher: (c: Record<string, unknown>) => boolean) {
  return page.evaluate((matcherSource) => {
    const w = window as unknown as { __PIMS_MOCK__?: { db?: { costs?: Array<Record<string, unknown>> } } };
    const list = w.__PIMS_MOCK__?.db?.costs ?? [];
    // eslint-disable-next-line no-new-func
    const fn = new Function('c', `return (${matcherSource})(c)`) as (c: Record<string, unknown>) => boolean;
    const hit = list.find(fn);
    return hit ? { type: typeof hit.amount, value: hit.amount } : null;
  }, matcher.toString());
}

/** 通过 UI 新建项目并经顶部选择器选中（成本表单的「项目」靠顶部当前项目带入） */
async function createProject(page: import('@playwright/test').Page, name: string, clientBudget: string, costBudget: string) {
  await gotoMenu(page, '项目');
  await btn(page, '新建项目').click();
  const drawer = layer(page);
  await field(page, '项目名称', drawer).fill(name);
  await field(page, '甲方预算', drawer).fill(clientBudget);
  await field(page, '我方成本预算', drawer).fill(costBudget);
  await btn(drawer, '保存').click();
  await expect(row(page, name)).toBeVisible({ timeout: 20_000 });
  await pickProject(page, name);
}

/** 在某个成本页签下新增一条，返回弹层 */
async function openCostForm(page: import('@playwright/test').Page, tabName: string, btnText: string) {
  await gotoMenu(page, '记账');
  await tab(page, tabName).click();
  await btn(page, btnText).click();
  return layer(page);
}

/** 下拉字典字段（材料名称、单位等）：点开 select 再选一项 */
async function pickSelectField(
  page: import('@playwright/test').Page,
  modal: import('@playwright/test').Locator,
  label: string,
  option: string,
) {
  await modal
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: label }) })
    .locator('.ant-select')
    .first()
    .click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: option })
    .first()
    .click();
}

test.describe('金额精度与边界（真实尺度数字）', () => {
  test('材料 2.5 吨 × 412.37 → 1,030.93（含落库为数字）', async ({ page }) => {
    await login(page);
    await createProject(page, '精度-材料', '100000', '90000');

    const modal = await openCostForm(page, '材料', '新增材料');
    await pickSelectField(page, modal, '材料名称', '水泥');
    await field(page, '数量', modal).fill('2.5');
    await pickSelectField(page, modal, '单位', '吨');
    await field(page, '单价', modal).fill('412.37');
    // 表单实时算出的金额：2.5 × 412.37 = 1030.925 → 1,030.93
    await expect(field(page, '金额', modal)).toHaveValue('1,030.93');
    await btn(modal, '确定').click();
// 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言

await dismissPaymentModal(page);

    // 界面：千分位 + 两位小数
    await expect(row(page, '水泥')).toContainText('1,030.93', { timeout: 20_000 });

    // 落库：必须是数字且数值精确
    const stored = await storedCost(page, (c) => c.material_name === '水泥' && Number(c.unit_price) === 412.37);
    expect(stored, 'mock 库应能查到该材料成本').not.toBeNull();
    expect(stored?.type, '金额应以数字落库').toBe('number');
    expect(stored?.value).toBeCloseTo(1030.93, 2);
  });

  test('人工 0.5 工日 × 333.33 → 166.67（半个工日常见）', async ({ page }) => {
    await login(page);
    await createProject(page, '精度-人工', '5000', '4000');

    const modal = await openCostForm(page, '人工', '新增人工');
    await field(page, '姓名', modal).fill('精度张三');
    await field(page, '工日数', modal).fill('0.5');
    await field(page, '日工价', modal).fill('333.33');
    await btn(modal, '确定').click();
// 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言

await dismissPaymentModal(page);

    await expect(row(page, '精度张三')).toContainText('166.67', { timeout: 20_000 });
    const stored = await storedCost(page, (c) => c.worker_name === '精度张三');
    expect(stored?.type).toBe('number');
    expect(stored?.value).toBeCloseTo(166.67, 2);
  });

  test('机械按小时 7.5 小时 × 88.88 → 666.60', async ({ page }) => {
    await login(page);
    await createProject(page, '精度-机械', '20000', '15000');

    const modal = await openCostForm(page, '机械', '新增机械');
    await field(page, '设备名称', modal).fill('精度挖机');
    await field(page, '数量', modal).fill('7.5');
    await field(page, '单价', modal).fill('88.88');
    await btn(modal, '确定').click();
// 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言

await dismissPaymentModal(page);

    await expect(row(page, '精度挖机')).toContainText('666.60', { timeout: 20_000 });
    const stored = await storedCost(page, (c) => c.machine_name === '精度挖机');
    expect(stored?.type).toBe('number');
    expect(stored?.value).toBeCloseTo(666.6, 2);
  });

  test('亏本项目：合同额 0 + 成本 1,500 → 首页结算利润 −1,500.00 且标红', async ({ page }) => {
    await login(page);
    await createProject(page, '精度-亏损', '0', '0');

    const modal = await openCostForm(page, '杂费', '新增杂费');
    await pickSelectField(page, modal, '杂费小类', '伙食费');
    await field(page, '金额', modal).fill('1500');
    await btn(modal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(row(page, '伙食费')).toBeVisible({ timeout: 20_000 });

    await gotoMenu(page, '首页');
    const projectRow = row(page, '精度-亏损');
    await expect(projectRow).toContainText('-1,500.00', { timeout: 20_000 });
    // 负数用 MoneyText 标红（rgb(207, 19, 34)）
    const color = await projectRow
      .locator('td', { hasText: '-1,500.00' })
      .first()
      .evaluate((el) => getComputedStyle(el.querySelector('span') ?? el).color);
    expect(color).toBe('rgb(207, 19, 34)');
  });
});