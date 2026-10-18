import { expect, test } from '@playwright/test';
import { btn, field, gotoMenu, gotoPath, layer, login, loose, pickProject, row, tab, dismissPaymentModal } from './helpers';

test.describe('交互流程', () => {
  test('首页盈亏总表：数字口径 / 合计行 / 行点击进详情', async ({ page }) => {
    await login(page);

    const table = page.locator('.ant-table').first();
    await expect(table.getByText('某小区 5#楼').first()).toBeVisible();
    // 验收 A3/A4 口径
    await expect(table.getByText('4,000,000.00').first()).toBeVisible();
    await expect(table.getByText('500,000.00').first()).toBeVisible(); // 预计利润
    await expect(table.getByText('1,351,500.00').first()).toBeVisible(); // 实际成本
    await expect(table.getByText('2,648,500.00').first()).toBeVisible(); // 结算利润
    // 合计行
    await expect(page.getByText(/合计（\d+ 个项目）/)).toBeVisible();
    await expect(page.getByText('6,000,000.00').first()).toBeVisible();
    // 不出现「现金结余」口径
    await expect(page.locator('body')).not.toContainText('现金结余');

    // 点行 → 项目详情（一览汇总表 + 分区卡片）
    await table.getByText('某小区 5#楼').first().click();
    await expect(page).toHaveURL(/\/projects\/1/);
    for (const title of ['预算与利润', '五类成本构成', '库存余量', '人工结算']) {
      await expect(page.getByText(title).first()).toBeVisible();
    }
    await expect(page.getByText('预算使用率').first()).toBeVisible();
  });

  test('项目档案：新建 / 编辑 / 删除（含二次确认）', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '项目');
    await expect(page.getByText('新建项目').first()).toBeVisible();

    // 新建
    await btn(page, '新建项目').click();
    const drawer = layer(page);
    await expect(drawer).toBeVisible();
    await field(page, '项目名称', drawer).fill('Playwright 项目');
    await field(page, '甲方预算', drawer).fill('1000000');
    await field(page, '我方成本预算', drawer).fill('800000');
    await btn(drawer, '保存').click();
    await expect(page.getByText('Playwright 项目').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ant-table').first().getByText('200,000.00').first()).toBeVisible(); // 预计利润

    // 编辑
    await row(page, 'Playwright 项目').getByRole('button', { name: /编\s*辑/ }).click();
    const editDrawer = layer(page);
    await field(page, '甲方预算', editDrawer).fill('1234567');
    await btn(editDrawer, '保存').click();
    await expect(page.locator('.ant-table').first().getByText('1,234,567.00').first()).toBeVisible({ timeout: 20_000 });

    // 删除（二次确认）
    await row(page, 'Playwright 项目').getByRole('button', { name: /删\s*除/ }).click();
    await expect(page.locator('.ant-modal-confirm')).toBeVisible();
    await expect(page.locator('.ant-modal-confirm')).toContainText('将同时隐藏该项目下的成本与流水');
    await btn(page, '确认删除').click();
    await expect(page.getByText('Playwright 项目')).toHaveCount(0, { timeout: 20_000 });
  });

  test('五类成本：五个页签 + 新增/编辑/修改记录/删除（人工、材料）', async ({ page }) => {
    await login(page);
    await pickProject(page, '某小区 5#楼');
    await gotoMenu(page, '记账');
    await expect(page.getByText(/筛选条件下/).first()).toBeVisible();
    for (const name of ['人工', '材料', '机械', '杂费', '垫付']) {
      await tab(page, name).click();
      await expect(page.getByText(loose(`筛选条件下「${name}」合计`))).toBeVisible();
    }

    // 人工：5 天 × 300 → 金额自动 1,500.00
    await tab(page, '人工').click();
    await btn(page, '新增人工').click();
    const modal = layer(page);
    await field(page, '姓名', modal).fill('测试张三');
    await field(page, '工日数', modal).fill('5');
    await field(page, '日工价', modal).fill('300');
    await expect(field(page, '金额', modal)).toHaveValue('1,500.00');
    await btn(modal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(row(page, '测试张三')).toBeVisible({ timeout: 20_000 });

    // 编辑 → 改日工价 → 金额重算
    await row(page, '测试张三').getByRole('button', { name: /编\s*辑/ }).click();
    const editModal = layer(page);
    await field(page, '日工价', editModal).fill('400');
    await expect(field(page, '金额', editModal)).toHaveValue('2,000.00');
    await btn(editModal, '确定').click();
    await expect(row(page, '测试张三')).toContainText('2,000.00', { timeout: 20_000 });

    // 修改记录时间线
    await row(page, '测试张三').getByRole('button', { name: /修改记录/ }).click();
    await expect(page.getByText('成本修改记录').first()).toBeVisible();
    await expect(page.locator('.ant-timeline-item')).toHaveCount(2); // 新增 + 修改
    await page.locator('.ant-drawer-close').first().click();

    // 删除：成本删除的确认层是**自定义 Modal**（标题「删除这条成本记录？」，
    // 正文额外说明「该成本对应的应付单不会被删除」），并不是 antd 的 Modal.confirm，
    // 所以不能再找 .ant-modal-confirm，确认按钮文案也是「删除」而非「确定」。
    await row(page, '测试张三').getByRole('button', { name: /删\s*除/ }).click();
    const deleteModal = page.locator('.ant-modal-content:visible').filter({ hasText: '删除这条成本记录？' }).first();
    await expect(deleteModal).toBeVisible();
    await expect(deleteModal).toContainText('应付单不会被删除');
    await btn(deleteModal, '删除').click();
    await expect(page.getByText('测试张三')).toHaveCount(0, { timeout: 20_000 });

    // 删除后会弹「成本已删除，但应付单已保留」（口径要求），必须关掉否则挡住后续操作
    const keptModal = page.locator('.ant-modal-content:visible').filter({ hasText: '成本已删除，但应付单已保留' }).first();
    await expect(keptModal).toBeVisible({ timeout: 15_000 });
    await btn(keptModal, '知道了').click();
    await expect(keptModal).toBeHidden({ timeout: 10_000 });

    // 材料：数量 × 单价自动算金额，且提示入库余量
    await tab(page, '材料').click();
    await btn(page, '新增材料').click();
    const materialModal = layer(page);
    await field(page, '数量', materialModal).fill('10');
    await field(page, '单价', materialModal).fill('88.5');
    await expect(field(page, '金额', materialModal)).toHaveValue('885.00');
    await materialModal.locator('.ant-form-item').filter({ hasText: '材料名称' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '水泥' }).first().click();
    await materialModal.locator('.ant-form-item').filter({ hasText: '单位' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '吨' }).first().click();
    await btn(materialModal, '确定').click();
    // 录完成本会自动生成应付单并弹出「登记已付」，先关掉再继续断言
    
await dismissPaymentModal(page);
    await expect(page.locator('.ant-message').getByText(/已入库|当前余量/)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: '885.00' }).first()).toBeVisible();
  });

  test('收/付款：新增收款 → 直接弹预冲窗口 → 冲销 200,000.00 结清', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '收/付款');

    // 顶部切换控件默认停在「付款」，先切到「收款」（需求 T2）
    const seg = page.locator('.ant-segmented').first();
    await expect(seg.locator('.ant-segmented-item-selected')).toContainText('付款');
    await seg.getByText('收款').click();
    await expect(page.getByText('新增收款').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.ant-table').first().getByText('1,700,000.00').first()).toBeVisible();

    await btn(page, '新增收款').click();
    const modal = layer(page);
    // 收 20 万，刚好够冲掉那张 20 万未结的应收单（冲销合计不得超过本次收付金额）
    await field(page, '金额', modal).fill('200000');
    await modal.locator('.ant-form-item').filter({ hasText: '项目' }).locator('.ant-select').click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: '某小区 5#楼' })
      .first()
      .click();
    await btn(modal, '确定').click();

    // 需求 T4：不再问「是否立即冲销？」，而是直接给出预冲方案（已按规则勾好，可自行调整）
    const offsetModal = page.locator('.ant-modal-content:visible').filter({ hasText: '应收冲销 · 收款' }).first();
    await expect(offsetModal).toBeVisible({ timeout: 20_000 });
    await expect(offsetModal).toContainText('已按规则自动勾选');
    await expect(offsetModal).toContainText('待结单据');
    // 自动勾选已带上未结金额
    await expect(offsetModal).toContainText('本次冲销合计：200,000.00', { timeout: 20_000 });
    await btn(offsetModal, '确认冲销').click();

    // 结果窗说明冲了哪几张（需求 T4），关掉继续
    const resultModal = page.locator('.ant-modal-content:visible').filter({ hasText: '冲销完成' }).first();
    await expect(resultModal).toBeVisible({ timeout: 20_000 });
    await expect(resultModal).toContainText('本次共冲销');
    await btn(resultModal, '知道了').click();

    // 应收单状态转已结清
    await gotoMenu(page, '往来');
    await expect(page.locator('.ant-table').first().getByText('已结清').first()).toBeVisible({ timeout: 20_000 });
  });

  test('应收应付：页签 / 汇总 / 冲销历史抽屉', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '往来');
    await expect(page.getByText('该收未收合计').first()).toBeVisible();
    await expect(page.getByText('该付未付合计').first()).toBeVisible();
    const receivable = page.locator('.ant-table').first();
    await expect(receivable.getByText('500,000.00').first()).toBeVisible();
    await expect(receivable.getByText('200,000.00').first()).toBeVisible(); // 未结

    await tab(page, '应付单').click();
    await expect(page.locator('.ant-table').first().getByText('700,000.00').first()).toBeVisible();

    await tab(page, '应收单').click();
    await row(page, '某某置业').getByRole('button', { name: /冲销历史/ }).click();
    const drawer = layer(page);
    await expect(drawer).toContainText('单据金额');
    await expect(drawer).toContainText('冲销记录');
    await expect(drawer).toContainText('300,000.00'); // 已冲销
  });

  test('库存：必须先选项目；余量联动；领用不足标红但允许提交', async ({ page }) => {
    await login(page);
    await gotoPath(page, '/inventory', '请先在顶部选择项目');
    await pickProject(page, '某小区 5#楼');

    // 入库 2,500 / 领用 800 → 余量 1,700
    const cementRow = row(page, '水泥');
    await expect(cementRow).toContainText('2,500');
    await expect(cementRow).toContainText('800');
    await expect(cementRow).toContainText('1,700');

    // 领用超量：标红提示但可提交
    await btn(page, '材料领用').click();
    const modal = layer(page);
    await modal.locator('.ant-form-item').filter({ hasText: '材料名称' }).locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '水泥' }).first().click();
    await field(page, '数量', modal).fill('9999');
    await expect(modal).toContainText('余量不足');
    await btn(modal, '余量不足，仍然提交').click();
    await expect(page.locator('.ant-message').getByText(/余量不足/)).toBeVisible({ timeout: 20_000 });
    // 提交后余量变负 → 红色
    await expect(row(page, '水泥').locator('.ant-typography-danger')).toBeVisible();
  });

  test('人工结算：生成预览 → 保存结算单 → 登记发放', async ({ page }) => {
    await login(page);
    await gotoPath(page, '/labor-settle', '生成结算预览');
    await pickProject(page, '某小区 5#楼');

    // 第一张表是「欠款总览」（一对象一行，累计口径；进来就有数，不用先生成预览）
    const overview = page.locator('.ant-card').filter({ hasText: '欠款总览' });
    await expect(overview.getByText('张三').first()).toBeVisible({ timeout: 20_000 });
    await expect(overview.getByText('1,500.00').first()).toBeVisible();

    // 第二张表是「结算预览」（点按钮才有）
    await btn(page, '生成结算预览').click();
    const previewCard = page.locator('.ant-card').filter({ hasText: '结算预览' });
    await expect(previewCard.getByText('张三').first()).toBeVisible({ timeout: 20_000 });
    await expect(previewCard.getByText('1,500.00').first()).toBeVisible();

    await btn(page, '保存结算单').click();
    await expect(page.locator('.ant-message').getByText(/已保存/)).toBeVisible({ timeout: 20_000 });

    // 第三张表是「本期结算单」（只记这一期该结多少）
    const settles = page.locator('.ant-card').filter({ hasText: '本期结算单' });
    await expect(settles.getByText('张三').first()).toBeVisible();
    await expect(settles.getByText('本期应结').first()).toBeVisible();

    // 发放按钮在「欠款总览」里（那里才有正确的"还欠"上限）
    await overview.getByRole('button', { name: /登记发放/ }).first().click();
    const modal = layer(page);
    await field(page, '本次发放金额', modal).fill('500');
    await btn(modal, '确定').click();
    await expect(page.locator('.ant-message').getByText('发放已登记')).toBeVisible({ timeout: 20_000 });
    // 需求 T6：发放后会弹「已生成付款流水并冲销应付单」的结果窗，且它是阻断式的，先关掉
    const payResult = page.locator('.ant-modal-content:visible').filter({ hasText: '发放已登记' }).first();
    await expect(payResult).toBeVisible({ timeout: 20_000 });
    await btn(payResult, '知道了').click();
    await expect(payResult).toBeHidden({ timeout: 10_000 });

    // 总览立刻反映：已付 500、还欠 1000、状态「部分」
    const row = overview.locator('.ant-table-row').filter({ hasText: '张三' }).first();
    await expect(row).toContainText('1,500.00');
    await expect(row).toContainText('500.00');
    await expect(row).toContainText('1,000.00');
    await expect(row).toContainText('部分');
  });

  test('设置：字典新增 / 显示已删除开关 / 备份数据库 / 导出按钮', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '设置');
    await expect(page.getByText('字典维护').first()).toBeVisible();

    // 字典新增（杂费小类）
    await page.getByPlaceholder('新增杂费小类名称').fill('Playwright 小类');
    await btn(page, '新增').click();
    await expect(page.getByText('Playwright 小类').first()).toBeVisible({ timeout: 20_000 });

    // 显示已删除记录开关
    const dataCard = page.locator('.ant-card').filter({ hasText: '数据与显示' });
    await dataCard.locator('.ant-switch').first().click();
    await expect(page.locator('.ant-message').getByText(/显示已删除记录/)).toBeVisible();

    // 备份数据库
    await btn(page, '备份数据库').click();
    await expect(page.getByText('备份完成').first()).toBeVisible({ timeout: 20_000 });

    // 导出按钮存在且可用
    await expect(btn(page, '导出全部数据（多 Sheet）')).toBeEnabled();
  });

  test('忘记密码：答错只提示「密保答案不正确」，全对后可重置并登录', async ({ page }) => {
    await login(page);
    // 退出登录（会清掉本机登录痕迹）
    await page.getByText('退出', { exact: true }).click();
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 20_000 });

    await page.getByText('忘记密码？').click();
    await expect(page.getByText('回答密保')).toBeVisible();
    const inputs = page.locator('.ant-form-item input');
    for (let i = 0; i < 3; i += 1) await inputs.nth(i).fill('错误答案');
    await btn(page, '校验密保答案').click();
    await expect(page.locator('.ant-message').getByText('密保答案不正确')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('确认新密码');

    for (let i = 0; i < 3; i += 1) await inputs.nth(i).fill(`测试答案${i + 1}`);
    await btn(page, '校验密保答案').click();
    await expect(page.getByText('确认新密码')).toBeVisible({ timeout: 20_000 });
    await field(page, '新密码').fill('abc12345');
    await field(page, '确认新密码').fill('abc12345');
    await btn(page, '重置密码').click();
    // 必须等登录页真正挂载：重置表单里也有 password 输入框，
    // 过早 fill 会写进即将卸载的表单，登录表单又回到默认值。
    await expect(page.getByText('忘记密码？')).toBeVisible({ timeout: 20_000 });

    await page.locator('input[type="password"]').first().fill('abc12345');
    await btn(page, '登录').click();
    await expect(page.getByText('项目盈亏总表').first()).toBeVisible({ timeout: 20_000 });
  });
});