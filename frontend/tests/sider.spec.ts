import { expect, test } from '@playwright/test';
import { gotoMenu, login } from './helpers';

/**
 * 侧边栏固定（2026-10-18 用户反馈）。
 *
 * 反馈原话：「帮我把这个侧边栏固定住，不要随着滚轮上下动」。
 *
 * 原来：外层 Layout 是 minHeight:100vh，内容一高整页就变长，
 *       窗口滚动时左侧菜单跟着一起滚走。
 * 现在：侧边栏 position:fixed + height:100vh，滚动只作用于右侧内容，
 *       右侧让出 180px（收起时 64px）。
 */
test.describe('侧边栏固定', () => {
  const cases = [
    ['设置', '/settings'],
    ['项目', '/projects'],
    ['记账', '/bookkeeping'],
  ] as const;

  for (const [menu, path] of cases) {
    test(`${menu}页滚动时，侧边栏不动`, async ({ page }) => {
      await login(page);
      await gotoMenu(page, menu);
      await expect(page).toHaveURL(new RegExp(path));

      const sider = page.locator('.ant-layout-sider');
      await expect(sider).toBeVisible();

      // 必须是固定定位
      expect(await sider.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');

      const before = await sider.boundingBox();
      expect(before).not.toBeNull();

      // 滚下去
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(400);

      const after = await sider.boundingBox();
      expect(after).not.toBeNull();
      // 关键断言：侧边栏的顶部位置一点没变
      expect(Math.abs((after!.y ?? 0) - (before!.y ?? 0))).toBeLessThan(1);
      expect(after!.y).toBeLessThan(1);
      // 也没有横向跑位
      expect(Math.abs((after!.x ?? 0) - (before!.x ?? 0))).toBeLessThan(1);
    });
  }

  test('内容区从侧边栏右边开始，没有被挡住', async ({ page }) => {
    await login(page);
    await gotoMenu(page, '设置');

    const sider = await page.locator('.ant-layout-sider').boundingBox();
    const header = await page.locator('.pims-header').boundingBox();
    expect(sider).not.toBeNull();
    expect(header).not.toBeNull();
    // 顶部条应该从 180px 处开始
    expect(header!.x).toBeGreaterThanOrEqual(179);
    // 侧边栏宽度 180
    expect(Math.round(sider!.width)).toBe(180);
  });
});
