import { expect, test } from '@playwright/test';
import { btn, field, gotoMenu, layer, login, loose, pickProject, row } from './helpers';

/**
 * 人工测试反馈（《初步人工测试问题说明.docx》）的验收用例。
 *
 * 覆盖：
 *   1. 右上角「初始密码」徽标已删除
 *   2. 设置页「修改密码」可最小化，字典维护随之铺满整页
 *   3. 字典维护「改名」→「编辑」（可改名称 + 备注；排序/启用留在行内）
 *   4. 项目详情是一览汇总表；长字段截断 + 点击展开
 *   7. 项目详情不再因 overview 未加载完而白屏（Cannot read properties of undefined）
 *   6. 新增收/付款的「对方」可自由输入（不再被迫先建字典）
 */

test.describe('人工测试反馈整改', () => {
  test('1. 顶部不再显示「初始密码」徽标', async ({ page }) => {
    await login(page);
    // 初始密码状态下也不该出现该徽标
    await expect(page.locator('.pims-header')).toBeVisible();
    await expect(page.locator('.pims-header').getByText('初始密码', { exact: true })).toHaveCount(0);
  });

  test('4+7. 项目详情是一览汇总表，长备注可展开；直接进详情不白屏', async ({ page }) => {
    await login(page);

    // 造一个长备注的项目，验证截断 + 展开
    const longRemark = '这是用于验证截断与展开的备注'.repeat(6);
    await gotoMenu(page, '项目');
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await field(page, '项目名称', drawer).fill('详情一览项目');
    await field(page, '甲方预算', drawer).fill('1000000');
    await field(page, '我方成本预算', drawer).fill('800000');
    await field(page, '备注', drawer).fill(longRemark);
    await btn(drawer, '保存').click();
    await expect(row(page, '详情一览项目')).toBeVisible({ timeout: 20_000 });

    // 直接用 URL 进详情（模拟刷新/直达；以前这里会因为 overview 未加载而整页崩）
    const projectId = await page.evaluate(() => {
      const w = window as unknown as { __PIMS_MOCK__?: { db?: { projects?: Array<{ id: number; name: string }> } } };
      const list = w.__PIMS_MOCK__?.db?.projects ?? [];
      return list.find((p) => p.name === '详情一览项目')?.id ?? null;
    });
    expect(projectId, 'mock 库应能查到刚建的项目').not.toBeNull();

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/projects/${projectId}`);

    // 一览表的分组与小节都在
    await expect(page.getByText('项目信息', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('预算与利润', { exact: true })).toBeVisible();
    await expect(page.getByText('实际成本明细（五类）', { exact: true })).toBeVisible();
    await expect(page.getByText('资金收付', { exact: true })).toBeVisible();
    await expect(page.getByText('该收该付', { exact: true })).toBeVisible();
    await expect(page.getByText('库存与人工', { exact: true })).toBeVisible();

    // 两个利润口径都在
    await expect(page.getByText('预计利润', { exact: true })).toBeVisible();
    await expect(page.getByText('结算利润', { exact: true })).toBeVisible();
    await expect(page.getByText('甲方预算 − 我方成本预算')).toBeVisible();

    // 长备注被截断（页面上不应出现完整长文本），点击后弹窗给出全文
    await expect(page.getByText(longRemark, { exact: true })).toHaveCount(0);
    await page.getByText(`${longRemark.slice(0, 28)}…`, { exact: true }).click();
    await expect(page.locator('.ant-modal-content').getByText(longRemark, { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    expect(errors, `详情页不应抛未捕获异常：${errors.join(' | ')}`).toEqual([]);
  });

  test('2+3. 设置页：修改密码可最小化、字典维护可「编辑」名称与备注', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '设置');

    // --- 2. 默认收起 + 收起/展开两个方向都要能用（T1 + T5） ---
    const dictCard = page.locator('.ant-card').filter({ hasText: '字典维护' }).first();
    // 「修改密码」卡片用标题精确定位（内容里的提示文案会随初始密码状态变化，不能拿来定位）
    const pwdCard = page
      .locator('.ant-card')
      .filter({ has: page.locator('.ant-card-head-title', { hasText: loose('修改密码') }) })
      .first();

    // T5：进设置页时默认就是收起状态 → 卡片不存在、字典维护已铺满
    await expect(pwdCard).toHaveCount(0);
    const widthCollapsed = (await dictCard.boundingBox())?.width ?? 0;
    await expect(page.locator('button[aria-label="展开修改密码"]')).toBeVisible();

    // 展开：同一个位置变成「修改密码 −」，卡片出现，字典维护让出右栏
    await page.locator('button[aria-label="展开修改密码"]').click();
    await expect(pwdCard).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button[aria-label="收起修改密码"]')).toBeVisible();
    const widthExpanded = (await dictCard.boundingBox())?.width ?? 0;
    expect(widthCollapsed, `展开后字典维护应变窄（${widthCollapsed} → ${widthExpanded}）`).toBeGreaterThan(
      widthExpanded,
    );

    // 收起：卡片整体消失、字典维护重新铺满
    await page.locator('button[aria-label="收起修改密码"]').click();
    await expect(pwdCard).toHaveCount(0, { timeout: 10_000 });
    const widthAfter = (await dictCard.boundingBox())?.width ?? 0;
    expect(widthAfter, `字典维护应铺满（前 ${widthCollapsed} → 后 ${widthAfter}）`).toBeGreaterThan(
      widthCollapsed - 2,
    );
    // 底部那块重复提示必须已经删掉
    await expect(page.getByText('字典维护已铺满整页')).toHaveCount(0);

    // --- 3. 编辑：名称 + 备注 ---
    const target = row(page, '伙食费');
    await expect(target).toBeVisible();
    await target.getByRole('button', { name: loose('编辑') }).click();
    const modal = layer(page);
    await expect(modal.getByText('编辑「伙食费」')).toBeVisible();

    const nameInput = modal.locator('input').first();
    await expect(nameInput).toHaveValue('伙食费');
    await nameInput.fill('伙食费-改名');
    await modal.locator('textarea').first().fill('测试备注');
    await btn(modal, '保存').click();

    await expect(row(page, '伙食费-改名')).toBeVisible({ timeout: 20_000 });
    await expect(row(page, '伙食费-改名')).toContainText('测试备注');

    // 排序 / 启用仍在表格行内（编辑弹窗里不应出现这两项控件）
    await row(page, '伙食费-改名').getByRole('button', { name: loose('编辑') }).click();
    const modal2 = layer(page);
    await expect(modal2.locator('.ant-switch')).toHaveCount(0);
    await expect(modal2.locator('.ant-input-number')).toHaveCount(0);
    await expect(modal2.getByText('「排序」与「启用」不在这里改')).toBeVisible();
    await btn(modal2, '取消').click();
  });

  test('6. 新增付款的「对方」可以直接输入任意值', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '收/付款');

    // 顶部切换默认停在「付款」（需求 T2）
    const seg = page.locator('.ant-segmented').first();
    await expect(seg.locator('.ant-segmented-item-selected')).toContainText('付款');

    await btn(page, '新增付款').click();
    const modal = layer(page);
    await field(page, '金额', modal).fill('3000');

    // 「对方」应是可输入的 AutoComplete，而不是只能选的下拉
    const partnerItem = modal
      .locator('.ant-form-item')
      .filter({ has: page.locator('.ant-form-item-label', { hasText: loose('对方') }) })
      .first();
    const partnerInput = partnerItem.locator('input').first();
    await partnerInput.click();
    await partnerInput.fill('张三（临时工，不建字典）');

    await btn(modal, '确定').click();
    await expect(row(page, '张三（临时工，不建字典）')).toBeVisible({ timeout: 20_000 });
  });
});
