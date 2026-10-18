import { useEffect } from 'react';

/**
 * 全局回车确认（2026-10-16 需求：「任何操作按回车都能直接确认，而不是只能点鼠标」）。
 *
 * 优先级（从上到下，命中即止）：
 * 1. **有弹窗/抽屉/确认框开着** → 触发它的主按钮（确定 / 保存 / 删除 / 确认…）
 * 2. 焦点在**多行文本域**（备注、说明）→ 不拦，回车老老实实换行
 * 3. 焦点在**日期选择器 / 下拉选择** → 回车关闭面板，等于"选好了"
 * 4. 焦点在**搜索框** → 触发搜索（等价于点放大镜）
 * 5. 其余情况 → 不动，避免误触
 *
 * 设计取舍：**不抢 textarea 的回车**（否则备注没法换行），
 * 也不在没有任何弹窗/输入时乱点按钮（避免"我按个回车它把项目删了"）。
 */
const PRIMARY_SELECTOR = [
  // antd 弹窗 / 抽屉的主按钮（放最后，通常是确定的那个）
  '.ant-modal-footer .ant-btn-primary',
  '.ant-drawer-footer .ant-btn-primary',
  // 自己写的弹窗按钮可能不在 footer 里
  '.ant-modal-content .ant-btn-primary',
  '.ant-drawer-content .ant-btn-primary',
  '.ant-modal-confirm-btns .ant-btn-primary',
].join(', ');

function visiblePrimaryButton(): HTMLButtonElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLButtonElement>(PRIMARY_SELECTOR));
  // 取最后一个可见、可用的：弹窗叠加时它是当前这一层的主操作
  const usable = nodes.filter((btn) => {
    if (btn.disabled) return false;
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const layer = btn.closest<HTMLElement>('.ant-modal-content, .ant-drawer-content, .ant-modal-confirm');
    return !layer || layer.offsetParent !== null || layer.getClientRects().length > 0;
  });
  return usable.length > 0 ? usable[usable.length - 1] : null;
}

function hasOpenOverlay(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.ant-modal-content, .ant-drawer-content'),
  ).some((el) => el.getClientRects().length > 0);
}

export function useEnterToConfirm(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      // 带修饰键的不管（Ctrl+Enter 之类留给浏览器/用户）
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();

      // ① 多行文本：保留换行
      if (tag === 'textarea') return;

      // ② 有弹窗开着 → 点主按钮
      if (hasOpenOverlay()) {
        const primary = visiblePrimaryButton();
        if (primary) {
          event.preventDefault();
          primary.click();
        }
        return;
      }

      // ③ 日期选择器的输入框：回车关掉面板（等同于"选好了"）
      if (target?.closest('.ant-picker')) {
        const picker = target.closest<HTMLElement>('.ant-picker');
        if (picker?.classList.contains('ant-picker-focused')) {
          event.preventDefault();
          target.blur(); // antd 在 blur 时确认当前值并收起面板
        }
        return;
      }

      // ④ 下拉选择（含可搜索的 Select）：回车确认当前高亮项，antd 自己处理，不拦
      if (target?.closest('.ant-select')) return;

      // ⑤ 搜索框：回车触发搜索
      const searchInput = target?.closest('.ant-input-search')?.querySelector('input');
      if (searchInput instanceof HTMLInputElement) {
        const wrapper = searchInput.closest<HTMLElement>('.ant-input-search');
        const searchBtn = wrapper?.querySelector<HTMLButtonElement>('.ant-input-search-button');
        if (searchBtn) {
          event.preventDefault();
          searchBtn.click();
        }
        return;
      }

      // ⑥ 普通输入框且没有弹窗：不动作（避免误触页面上的按钮）
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

export default useEnterToConfirm;
