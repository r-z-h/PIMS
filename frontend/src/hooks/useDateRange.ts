import { useCallback, useMemo } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import { useAppStore } from '../store/app';
import type { DateRange } from '../types';

export interface UseDateRangeResult {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  /** 传给接口的 start_date / end_date */
  query: { start_date?: string; end_date?: string };
  /** RangePicker 用的 dayjs 值 */
  value: [Dayjs, Dayjs] | null;
  setValue: (range: [Dayjs | null, Dayjs | null] | null) => void;
  setPreset: (preset: 'thisMonth' | 'thisQuarter' | 'thisYear' | 'all') => void;
  reset: () => void;
}

/** 时间段筛选：一律按业务发生日期（00-需求冻结 R8） */
export function useDateRange(): UseDateRangeResult {
  const dateRange = useAppStore((s) => s.dateRange);
  const setDateRange = useAppStore((s) => s.setDateRange);

  const value = useMemo<[Dayjs, Dayjs] | null>(() => {
    if (!dateRange.start_date || !dateRange.end_date) return null;
    return [dayjs(dateRange.start_date), dayjs(dateRange.end_date)];
  }, [dateRange]);

  const setValue = useCallback(
    (range: [Dayjs | null, Dayjs | null] | null) => {
      if (!range || !range[0] || !range[1]) {
        setDateRange({});
        return;
      }
      setDateRange({
        start_date: range[0].format('YYYY-MM-DD'),
        end_date: range[1].format('YYYY-MM-DD'),
      });
    },
    [setDateRange],
  );

  const setPreset = useCallback(
    (preset: 'thisMonth' | 'thisQuarter' | 'thisYear' | 'all') => {
      const today = dayjs();
      if (preset === 'all') {
        setDateRange({});
        return;
      }
      if (preset === 'thisMonth') {
        setDateRange({
          start_date: today.startOf('month').format('YYYY-MM-DD'),
          end_date: today.endOf('month').format('YYYY-MM-DD'),
        });
        return;
      }
      if (preset === 'thisQuarter') {
        setDateRange({
          start_date: today.startOf('month').subtract((today.month() % 3), 'month').format('YYYY-MM-DD'),
          end_date: today.endOf('month').format('YYYY-MM-DD'),
        });
        return;
      }
      setDateRange({
        start_date: today.startOf('year').format('YYYY-MM-DD'),
        end_date: today.endOf('year').format('YYYY-MM-DD'),
      });
    },
    [setDateRange],
  );

  const reset = useCallback(() => setDateRange({}), [setDateRange]);

  return {
    dateRange,
    setDateRange,
    query: { start_date: dateRange.start_date, end_date: dateRange.end_date },
    value,
    setValue,
    setPreset,
    reset,
  };
}
