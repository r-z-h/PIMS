import { useEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import type { InputProps } from 'antd';
import { fmtMoney, toScaled } from '../utils/money';
import type { Money } from '../types';

export interface MoneyInputProps
  extends Omit<InputProps, 'value' | 'onChange' | 'defaultValue' | 'precision'> {
  value?: Money | null;
  /** 传出两位小数数字，空值为 null（提交时无需再去千分位） */
  onChange?: (value: number | null) => void;
  /** 小数位，默认 2（金额） */
  precision?: number;
  allowNegative?: boolean;
}

/** 把用户输入清洗成合法数字文本：允许数字、一个小数点、可选负号 */
function sanitize(raw: string, precision: number, allowNegative: boolean): string {
  let text = raw.replace(/,/g, '').replace(/[^\d.\-]/g, '');
  if (!allowNegative) text = text.replace(/-/g, '');
  const negative = allowNegative && text.startsWith('-');
  text = text.replace(/-/g, '');
  const firstDot = text.indexOf('.');
  if (firstDot >= 0) {
    const intPart = text.slice(0, firstDot);
    const fracPart = text.slice(firstDot + 1).replace(/\./g, '').slice(0, precision);
    text = `${intPart}.${fracPart}`;
  }
  return `${negative ? '-' : ''}${text}`;
}

/** 千分位展示（编辑中也保持千分位） */
function formatLive(text: string, precision: number): string {
  if (!text) return '';
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPartRaw = '', fracPart] = body.split('.');
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const suffix = fracPart === undefined ? '' : `.${fracPart.slice(0, precision)}`;
  return `${negative ? '-' : ''}${grouped}${suffix}`;
}

/**
 * 金额输入框：两位小数 + 千分位显示，onChange 直接给出数字（已去千分位）。
 * 全站金额一律走本组件（docs/03-接口设计.md 第 13 节）。
 */
export function MoneyInput({
  value,
  onChange,
  precision = 2,
  allowNegative = false,
  onBlur,
  onFocus,
  placeholder = '0.00',
  ...rest
}: MoneyInputProps) {
  const [text, setText] = useState<string>(value === null || value === undefined || value === '' ? '' : fmtMoney(value));
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setText(value === null || value === undefined || value === '' ? '' : fmtMoney(value));
  }, [value]);

  return (
    <Input
      {...rest}
      placeholder={placeholder}
      inputMode="decimal"
      value={text}
      onFocus={(event) => {
        focused.current = true;
        onFocus?.(event);
      }}
      onChange={(event) => {
        const clean = sanitize(event.target.value, precision, allowNegative);
        setText(formatLive(clean, precision));
        if (clean === '' || clean === '-' || clean === '.') {
          onChange?.(null);
          return;
        }
        onChange?.(toScaled(clean, precision) / Math.pow(10, precision));
      }}
      onBlur={(event) => {
        focused.current = false;
        const clean = sanitize(event.target.value, precision, allowNegative);
        if (clean === '' || clean === '-' || clean === '.') {
          setText('');
          onChange?.(null);
        } else {
          setText(fmtMoney(toScaled(clean, precision) / Math.pow(10, precision)));
        }
        onBlur?.(event);
      }}
    />
  );
}

export default MoneyInput;
