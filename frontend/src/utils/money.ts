/**
 * 金额工具：全部走「整数分」运算，禁止浮点累加。
 * 约定：前端展示两位小数 + 千分位；提交时去掉千分位，传两位小数数字。
 */
import type { Money } from '../types/api';

const POW10 = [1, 10, 100, 1000, 10000, 100000];

/** 任意金额 → 指定小数位的整数（默认分） */
export function toScaled(value: Money | null | undefined, decimals = 2): number {
  if (value === null || value === undefined || value === '') return 0;
  let text = typeof value === 'number' ? String(value) : String(value).trim();
  if (!text) return 0;
  text = text.replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (!text || text === '-' || text === '.') return 0;
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  const [intPart = '0', fracRaw = ''] = text.split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const scaled = Number(intPart || '0') * POW10[decimals] + Number(frac || '0');
  return negative ? -scaled : scaled;
}

/** 分 → 两位小数的数字（用于提交接口） */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** 任意金额 → 两位小数字符串（无千分位，用于提交/比较） */
export function toAmountString(value: Money | null | undefined): string {
  return (toScaled(value, 2) / 100).toFixed(2);
}

/** 加法（整数分，绝不浮点累加） */
export function addMoney(...values: Array<Money | null | undefined>): number {
  const cents = values.reduce<number>((sum, v) => sum + toScaled(v, 2), 0);
  return fromCents(cents);
}

/** 减法 a − b */
export function subMoney(a: Money | null | undefined, b: Money | null | undefined): number {
  return fromCents(toScaled(a, 2) - toScaled(b, 2));
}

/** 乘法（数量 × 单价），结果四舍五入到分 */
export function mulScaled(
  a: Money | null | undefined,
  b: Money | null | undefined,
  scaleA = 3,
  scaleB = 2,
): number {
  const ia = toScaled(a, scaleA);
  const ib = toScaled(b, scaleB);
  const product = ia * ib;
  const divisor = POW10[scaleA + scaleB - 2];
  if (Number.isSafeInteger(product)) {
    return fromCents(Math.round(product / divisor));
  }
  return Math.round(Number(a ?? 0) * Number(b ?? 0) * 100) / 100;
}

/** 数量 × 单价 → 金额 */
export function mulMoney(a: Money | null | undefined, b: Money | null | undefined): number {
  return mulScaled(a, b, 3, 2);
}

/** 比较：a > b */
export function gtMoney(a: Money | null | undefined, b: Money | null | undefined): boolean {
  return toScaled(a, 2) > toScaled(b, 2);
}

/** 是否小于 0 */
export function isNegative(value: Money | null | undefined): boolean {
  return toScaled(value, 2) < 0;
}

/** 千分位 + 两位小数展示 */
export function fmtMoney(value: Money | null | undefined): string {
  const cents = toScaled(value, 2);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const intText = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${intText}.${frac}`;
}

/** 数量展示：最多 3 位小数，去尾零，带千分位 */
export function fmtQty(value: Money | null | undefined, decimals = 3): string {
  const scaled = toScaled(value, decimals);
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const intText = String(Math.floor(abs / POW10[decimals])).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % POW10[decimals])
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${intText}${frac ? `.${frac}` : ''}`;
}

/** 工日等两位小数展示，去尾零 */
export function fmtDecimal(value: Money | null | undefined, decimals = 2): string {
  const scaled = toScaled(value, decimals);
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const intText = String(Math.floor(abs / POW10[decimals]));
  const frac = String(abs % POW10[decimals])
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${intText}${frac ? `.${frac}` : ''}`;
}
