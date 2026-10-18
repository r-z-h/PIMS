import { expect, test } from '@playwright/test';
import { btn, field, gotoMenu, layer, login, pickProject, tab } from './helpers';

/**
 * 付款后默认自动冲销（需求 T4）：
 *   保存付款 → 直接弹出「预冲窗口」，按「同项目、同业务类型、日期最早优先」预填好要冲哪几张单，
 *   **用户点确认才真冲**；冲完弹结果窗说明冲了哪几张、还剩多少，并给「撤销并重选」。
 *   没有可冲单据时：正常保存流水 + 提示，不报错。
 */
test.describe('付款后自动冲销', () => {
  test('保存付款 → 预冲窗口预填方案 → 确认后弹结果窗并冲销', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '收/付款');

    // 顶部切换默认在「付款」
    const seg = page.locator('.ant-segmented').first();
    await expect(seg.locator('.ant-segmented-item-selected')).toContainText('付款');
    await btn(page, '新增付款').click();

    const modal = layer(page);
    await field(page, '金额', modal).fill('60000');
    await btn(modal, '确定').click();

    // ① 不再是「是否立即冲销？」的是非题，而是直接给出预冲方案
    const planModal = page.locator('.ant-modal-content:visible').filter({ hasText: '应付冲销 · 付款' }).first();
    await expect(planModal).toBeVisible({ timeout: 20_000 });
    await expect(planModal).toContainText('已按规则自动勾选');
    await expect(planModal).toContainText('日期最早优先');
    // 种子里项目 1 有一张 700,000 的材料款应付单，60,000 应全部落在它上面
    await expect(planModal).toContainText('700,000.00');

    // 预填的勾选已经生效：确认按钮可用且本次冲销合计等于付款金额
    await expect(planModal).toContainText('60,000.00');
    await btn(planModal, '确认冲销').click();

    // ② 结果窗：说明冲了几张、每张多少、还剩多少
    const resultModal = page.locator('.ant-modal-content:visible').filter({ hasText: '冲销完成' }).first();
    await expect(resultModal).toBeVisible({ timeout: 20_000 });
    await expect(resultModal).toContainText('本次共冲销');
    await expect(resultModal).toContainText('1 张单据');
    await expect(resultModal).toContainText('60,000.00');
    await expect(resultModal).toContainText('本笔金额已全部冲销');
    await expect(btn(resultModal, '撤销并重选')).toBeVisible();
    await btn(resultModal, '知道了').click();

    // ③ 往来页：那张应付单已冲销 60,000，未结相应减少
    await gotoMenu(page, '往来');
    await expect(page.getByText('该收未收合计').first()).toBeVisible({ timeout: 20_000 });
    await tab(page, '应付单').click();
    const arapRow = page.locator('.ant-table-row').filter({ hasText: '某某建材' }).first();
    await expect(arapRow).toBeVisible({ timeout: 20_000 });
    await expect(arapRow).toContainText('60,000.00');
    await expect(arapRow).toContainText('部分');
  });

  test('没有可冲销单据时：正常保存流水并提示，不报错', async ({ page }) => {
    await login(page);
    // 项目 2（市政道路改造）在种子里只有应收单，没有应付单
    await pickProject(page, '市政道路改造');
    await gotoMenu(page, '收/付款');

    await btn(page, '新增付款').click();
    const modal = layer(page);
    await field(page, '金额', modal).fill('1234');
    await btn(modal, '确定').click();

    // 提示找不到可冲销的应付单，且**不弹**预冲窗口
    await expect(page.locator('.ant-message').getByText(/未找到可冲销的应付单/)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('.ant-modal-content:visible').filter({ hasText: '应付冲销 · 付款' }),
    ).toHaveCount(0);

    // 流水正常记录了（合计付款不含 1234 之外的变化即可，这里只确认没有错误提示）
    await expect(page.locator('.ant-message-error')).toHaveCount(0);
    await expect(page.locator('.ant-table-row').filter({ hasText: '1,234.00' }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
