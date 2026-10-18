import { expect, type Locator, type Page } from '@playwright/test';

/** 转义正则元字符 */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * antd 会在两个汉字之间插入空格（"登 录"），直接用文本匹配会失配。
 * 统一用「字符间允许空白」的宽松正则。
 */
export const loose = (text: string) => new RegExp(text.split('').map(esc).join('\\s*'));

/** 可定位范围：整页或某个弹层 */
type Scope = Page | Locator;

export const btn = (scope: Scope, text: string): Locator =>
  scope.locator('button').filter({ hasText: loose(text) }).first();

export const menu = (scope: Scope, text: string): Locator =>
  scope.locator('.ant-menu-item').filter({ hasText: loose(text) }).first();

export const tab = (scope: Scope, text: string): Locator =>
  scope.locator('.ant-tabs-tab').filter({ hasText: loose(text) }).first();

/** 当前可见的弹层（Modal 或 Drawer） */
export const layer = (page: Page): Locator =>
  page.locator('.ant-modal-content:visible, .ant-drawer-content:visible').last();

/** 表单里按 label 定位输入控件（antd Form.Item） */
export const field = (page: Page, label: string, root?: Locator): Locator => {
  const scope = root ?? page;
  return scope
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: loose(label) }) })
    .locator('input, textarea')
    .first();
};

export const formItem = (page: Page, label: string, root?: Locator): Locator => {
  const scope = root ?? page;
  return scope
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: loose(label) }) })
    .first();
};

/**
 * 表格数据行（antd 会在 tbody 里塞一行 aria-hidden 的 .ant-table-measure-row，
 * 取 `.first()` 会命中它，所以必须限定 .ant-table-row）。
 */
export const row = (page: Page, text: string): Locator =>
  page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: loose(text) }).first();

/** 某个表格容器里的第 N 行数据行 */
export const dataRows = (scope: Scope): Locator => scope.locator('.ant-table-tbody tr.ant-table-row');

/**
 * 密保设置页的第 N 张卡（1-based）。
 *
 * 踩过两个坑：
 *  1) `.ant-card` + hasText 会命中外层 Card（它包着三张内层卡），三次填写都写进第一张；
 *  2) `.ant-card` + `has:` 同样会命中外层卡 —— `has:` 只要"后代里存在"就算匹配，
 *     所以必须先把范围收窄到内层卡（antd 给 size="small" 的卡加了 .ant-card-small），
 *     再按「卡片自己的标题」匹配。
 */
export const securityCard = (page: Page, index: number): Locator =>
  page
    .locator('.ant-card-small')
    .filter({ has: page.locator('.ant-card-head-title', { hasText: loose(`密保问题 ${index}`) }) })
    .first();

/** h1 侧边菜单跳转 */
export async function gotoMenu(page: Page, text: string): Promise<void> {
  await menu(page, text).click();
  await page.waitForTimeout(400);
}

/** 直接按路由进入并等待页面骨架 */
export async function gotoPath(page: Page, path: string, marker: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

export interface LoginOptions {
  password?: string;
  /** 首页标志文本，默认盈亏总表 */
  expectMarker?: string;
}

/**
 * 登录（Mock 下每个用例都是全新库：会走「强制设置密保」）。
 * 结束后停在首页。
 */
export async function login(page: Page, options: LoginOptions = {}): Promise<void> {
  await page.goto('/');
  // 未登录 → 登录页
  await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('input[type="password"]').first().fill(options.password ?? '123456');
  await btn(page, '登录').click();

  // 登录后可能落到「首页」（已设密保）或「密保设置页」（首次）。
  // 必须等其中一种状态真正出现再判断，否则会在 SPA 跳转完成前读到旧 URL 而跳过填写。
  const header = page.locator('.pims-header');
  const firstSecurityCard = securityCard(page, 1);
  await expect(header.or(firstSecurityCard)).toBeVisible({ timeout: 25_000 });

  if (await firstSecurityCard.isVisible()) {
    for (let i = 1; i <= 3; i += 1) {
      const card = securityCard(page, i);
      await card.locator('.ant-form-item').nth(0).locator('input').fill(`测试问题${i}`);
      await card.locator('.ant-form-item').nth(1).locator('input').fill(`测试答案${i}`);
    }
    await btn(page, '保存并进入系统').click();
  }

  // 等「应用骨架出现」这个结果，而不是等某次导航事件：
  // SPA 用 history.pushState 跳转，而且跳转可能发生在调用之前，waitForURL 会一直等下一条导航。
  await expect(page.locator('.pims-header')).toBeVisible({ timeout: 25_000 });
  await expect(page).not.toHaveURL(/security-setup|\/login$/);
  await expect(page.getByText(options.expectMarker ?? '项目盈亏总表').first()).toBeVisible({ timeout: 20_000 });
}

/** 顶部选择当前项目（表格/详情等按项目过滤的页面用） */
export async function pickProject(page: Page, name: string): Promise<void> {
  const select = page.locator('.pims-header .ant-select').first();
  await select.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: loose(name) }).first().click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** 断言没有错误类 toast（成功提示不算） */
export async function expectNoErrorToast(page: Page): Promise<void> {
  await expect(page.locator('.ant-message-error')).toHaveCount(0);
}

/**
 * 录完一笔成本后，后端会自动生成应付单并弹出「登记已付」弹窗。
 * 该弹窗是**阻断式**的（不处理会挡住后续点击），测试里若只想验证录入本身，用它关掉。
 *
 * 时序坑（踩过）：「登记已付」是**紧跟着**成本表单弹出的 —— 成本表单刚 `open=false`
 * 还在淡出时，登记已付就已经挂上来了。所以：
 *   ✗ 不能「先等 `.ant-modal-content:visible` 计数为 0，再等登记已付」：
 *     那一刻计数已经是 1（登记已付自己），这个等待永远不成立，
 *     会白等满 10s 超时（被 catch 吞掉），连带把 3s 就消失的「杂费已录入」等没了。
 *   ✓ 应先等**登记已付这一个**弹层出现，再等**其它**弹层（成本表单）退场后点按钮。
 * 返回 true 表示确实关掉了一个登记已付弹窗。
 */
export async function dismissPaymentModal(page: Page): Promise<boolean> {
  const modal = page.locator('.ant-modal-content:visible').filter({ hasText: '登记已付' }).first();

  const appeared = await modal
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;

  // 成本表单可能还在淡出：等它彻底退场，避免「稍后再说」的点击被正在消失的层拦下。
  // 这里用 hasNotText 把登记已付排除在外，计数才可能归零。
  await expect(page.locator('.ant-modal-content:visible').filter({ hasNotText: '登记已付' }))
    .toHaveCount(0, { timeout: 10_000 })
    .catch(() => undefined);

  await modal.locator('button').filter({ hasText: loose('稍后再说') }).first().click();
  await expect(modal).toBeHidden({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  return true;
}

/** 页面级横向溢出检查：文档不应出现横向滚动条 */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(
    metrics.scrollWidth,
    `页面出现横向溢出：scrollWidth=${metrics.scrollWidth} > clientWidth=${metrics.clientWidth}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}
