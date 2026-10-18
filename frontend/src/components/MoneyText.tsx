import type { CSSProperties, ReactNode } from 'react';
import { fmtMoney, isNegative } from '../utils/money';
import type { Money } from '../types';

export interface MoneyTextProps {
  value: Money | null | undefined;
  /** 加粗（预计利润 / 结算利润列用） */
  bold?: boolean;
  /** 负数标红（默认开启） */
  colorNegative?: boolean;
  /** 正数标绿（可选） */
  colorPositive?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  style?: CSSProperties;
  emptyText?: string;
}

/** 金额展示：两位小数 + 千分位，负数标红 */
export function MoneyText({
  value,
  bold,
  colorNegative = true,
  colorPositive = false,
  prefix,
  suffix,
  style,
  emptyText = '0.00',
}: MoneyTextProps) {
  const isEmpty = value === null || value === undefined || value === '';
  const negative = !isEmpty && isNegative(value);
  const positive = !isEmpty && !negative;
  return (
    <span
      style={{
        fontVariantNumeric: 'tabular-nums',
        fontWeight: bold ? 600 : undefined,
        color: negative && colorNegative ? '#cf1322' : positive && colorPositive ? '#389e0d' : undefined,
        ...style,
      }}
    >
      {prefix}
      {isEmpty ? emptyText : fmtMoney(value)}
      {suffix}
    </span>
  );
}

export default MoneyText;
