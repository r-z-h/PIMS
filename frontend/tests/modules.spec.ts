import { expect, test } from '@playwright/test';
import {
  btn,
  dismissPaymentModal,
  field,
  gotoMenu,
  layer,
  login,
  loose,
  pickProject,
  row,
  tab,
} from './helpers';

/**
 * 模块分工（2026-10-15 需求）：
 *   「记账」  = 五类成本（人工/材料/机械/杂费/垫付）录入，贴近现实账本一笔一笔记
 *   「收/付款」= 资金收付流水（原「记账」页改名）
 *   「成本」  = 按成本构成看汇总（只读视图），**同时也能录入**（与记账同一套表单、同一份数据）
 *
 * 录任何一笔成本，后端都会自动生成一张对应的应付单（「往来」页可见）。
 */

test.describe('模块分工与成本页', () => {
  test('菜单结构与顺序正确（记账 / 收\\/付款 / 成本 各自独立）', async ({ page }) => {
    await login(page);

    const labels = await page.locator('.ant-menu-item').allInnerTexts();
    const normalized = labels.map((t) => t.replace(/\s+/g, ''));
    expect(normalized, `实际菜单：${normalized.join(' | ')}`).toEqual([
      '首页', '项目', '记账', '收/付款', '成本', '往来', '库存', '结算', '快速查询', '设置',
    ]);
  });

  test('「记账」是五类成本录入页，「收/付款」是资金流水页', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 记账：五个成本页签 + 各页签合计
    await gotoMenu(page, '记账');
    await expect(page.getByText(/筛选条件下/).first()).toBeVisible({ timeout: 20_000 });
    for (const name of ['人工', '材料', '机械', '杂费', '垫付']) {
      await tab(page, name).click();
      await expect(page.getByText(loose(`筛选条件下「${name}」合计`))).toBeVisible();
    }

    // 收/付款：收款 / 付款 用一个切换控件区分（需求 T2，不再并排两个按钮）
    await gotoMenu(page, '收/付款');
    const seg = page.locator('.ant-segmented').first();
    await expect(seg).toBeVisible({ timeout: 20_000 });
    await expect(seg.getByText('收款')).toBeVisible();
    await expect(seg.getByText('付款')).toBeVisible();
    // 默认停在「付款」
    await expect(seg.locator('.ant-segmented-item-selected')).toContainText('付款');
    await expect(page.getByText('新增付款').first()).toBeVisible();
    // 切到「收款」→ 列表与新增按钮都跟着切
    await seg.getByText('收款').click();
    await expect(page.getByText('新增收款').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('资金流水只反映钱的进出，不参与利润计算')).toBeVisible();
  });

  test('旧地址 /ledger 自动跳到 /payments（改名不破坏已有书签）', async ({ page }) => {
    await login(page);
    await page.goto('/ledger');
    await expect(page).toHaveURL(/\/payments/, { timeout: 15_000 });
    await expect(page.locator('.ant-segmented').first()).toBeVisible({ timeout: 20_000 });
  });

  test('「成本」页既能看汇总、也能录入五类成本', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    await gotoMenu(page, '成本');
    // 用稳定前缀匹配：横幅措辞为「本页按成本构成看汇总；录入五类成本的两个入口是等价的」
    await expect(page.getByText('本页按成本构成')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('实际成本（五类合计）')).toBeVisible();
    await expect(page.getByText('成本明细（按类别分组）')).toBeVisible();

    // 能录入：右上角「新增成本」下拉五类
    await btn(page, '新增成本').click();
    await expect(page.locator('.ant-dropdown-menu-item').filter({ hasText: loose('新增杂费') }).first()).toBeVisible();
    await page.locator('.ant-dropdown-menu-item').filter({ hasText: loose('新增杂费') }).first().click();
    const modal = layer(page);
    await expect(modal.getByText('新增杂费')).toBeVisible({ timeout: 10_000 });

    // 填一笔并保存
    await modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: loose('杂费小类') }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown .ant-select-item-option').filter({ hasText: '伙食费' }).first().click();
    await field(page, '金额', modal).fill('4321');
    await btn(modal, '确定').click();

    // 录完成本会自动生成应付单并弹「登记已付」——先关掉
    const hadPayModal = await dismissPaymentModal(page);
    expect(hadPayModal, '录完成本应弹出「登记已付」').toBe(true);

    // 成本页立刻看得到这笔（同一份数据）
    await expect(row(page, '伙食费')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('4,321.00').first()).toBeVisible();
  });

  test('录一笔成本会自动在「往来」生成对应付单', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: loose('杂费小类') }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown .ant-select-item-option').filter({ hasText: '转运费' }).first().click();
    await field(page, '金额', modal).fill('777');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 往来页应出现这张自动生成的应付单
    await gotoMenu(page, '往来');
    await expect(page.getByText('该收未收合计').first()).toBeVisible({ timeout: 20_000 });
    await tab(page, '应付单').click();
    await expect(page.locator('.ant-table-row').filter({ hasText: '转运费' }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('777.00').first()).toBeVisible({ timeout: 20_000 });
  });

  test('删除成本 → 明确提示「应付单已保留」，且往来页确实还能查到', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    // 录一笔杂费（会同时自动生成应付单）
    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: loose('杂费小类') }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown .ant-select-item-option').filter({ hasText: '其他' }).first().click();
    await field(page, '金额', modal).fill('2680');
    await btn(modal, '确定').click();
    await dismissPaymentModal(page);

    // 删除确认弹窗要事先说明「应付单会保留」
    const targetRow = page.locator('.ant-table-row').filter({ hasText: '2,680.00' }).first();
    await expect(targetRow).toBeVisible({ timeout: 20_000 });
    await targetRow.getByRole('button', { name: loose('删除') }).click();
    const confirm = page.locator('.ant-modal-content').filter({ hasText: '删除这条成本记录' }).first();
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await expect(confirm).toContainText('不会被删除');
    await btn(confirm, '删除').click();

    // 删除后必须弹出「应付单已保留」的明确提示（本轮口径要求，之前零覆盖）
    const keptModal = page.locator('.ant-modal-content').filter({ hasText: '成本已删除，但应付单已保留' }).first();
    await expect(keptModal).toBeVisible({ timeout: 15_000 });
    await expect(keptModal).toContainText('已保留（未删除）');
    // antd Modal.info 的确认按钮是「知道了」
    await keptModal.locator('button').filter({ hasText: loose('知道了') }).first().click();

    // 该成本从列表消失，但「往来」里那张应付单还在（未结 2,680）
    await expect(
      page.locator('.ant-table-row').filter({ hasText: '2,680.00' }),
    ).toHaveCount(0, { timeout: 15_000 });
    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    await expect(page.locator('.ant-table-row').filter({ hasText: '2,680.00' }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('成本页折叠：只看五类合计 / 展开全部明细', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '成本');
    await expect(page.getByText('成本明细（按类别分组）')).toBeVisible({ timeout: 20_000 });

    // 默认展开：能看到明细行（mock 种子里人工有张三）
    await expect(page.getByText('张三').first()).toBeVisible({ timeout: 20_000 });

    await btn(page, '只看五类合计').click();
    await expect(page.getByText('张三')).toHaveCount(0, { timeout: 10_000 });

    await btn(page, '展开全部明细').click();
    await expect(page.getByText('张三').first()).toBeVisible({ timeout: 10_000 });
  });

  test('「登记已付」：填已付金额 → 应付单未结减少，并生成付款流水', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');

    await gotoMenu(page, '记账');
    await tab(page, '杂费').click();
    await btn(page, '新增杂费').click();
    const modal = layer(page);
    await modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: loose('杂费小类') }) })
      .locator('.ant-select')
      .first()
      .click();
    await page.locator('.ant-select-dropdown .ant-select-item-option').filter({ hasText: '罚款' }).first().click();
    await field(page, '金额', modal).fill('1000');
    await btn(modal, '确定').click();

    // 弹窗里填已付 400
    const payModal = page.locator('.ant-modal-content').filter({ hasText: '登记已付' }).first();
    await expect(payModal).toBeVisible({ timeout: 20_000 });
    await expect(payModal).toContainText('1,000.00'); // 应付单金额＝成本全额
    await field(page, '已付金额', payModal).fill('400');
    await btn(payModal, '登记').click();
    await expect(payModal).toBeHidden({ timeout: 20_000 });

    // 往来页：该应付单未结 600
    await gotoMenu(page, '往来');
    await tab(page, '应付单').click();
    const arapRow = row(page, '罚款');
    await expect(arapRow).toBeVisible({ timeout: 20_000 });
    await expect(arapRow).toContainText('600.00');

    // 收/付款页：生成了一笔 400 的付款流水
    await gotoMenu(page, '收/付款');
    await expect(page.getByText('400.00').first()).toBeVisible({ timeout: 20_000 });
  });
});
