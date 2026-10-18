import { DatePicker, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { DateRange } from '../types';

const { RangePicker } = DatePicker;

export interface DateRangeBarProps {
  /** 时间段值：{ start_date, end_date } */
  value: DateRange;
  /** 传出 start_date / end_date（清空时为 {}） */
  onChange: (range: DateRange) => void;
  allowClear?: boolean;
  style?: React.CSSProperties;
  /** 是否展示快捷选项（本月/本季/今年/全部） */
  showPresets?: boolean;
}

/**
 * 时间段筛选控件：一律按业务发生日期，传出 start_date / end_date
 * （docs/01-开发手册.md 1.3、00-需求冻结 R8）。
 */
export function DateRangeBar({ value, onChange, allowClear = true, style, showPresets = true }: DateRangeBarProps) {
  const pickerValue: [Dayjs, Dayjs] | null =
    value.start_date && value.end_date ? [dayjs(value.start_date), dayjs(value.end_date)] : null;

  const emit = (range: [Dayjs | null, Dayjs | null] | null) => {
    if (!range || !range[0] || !range[1]) {
      onChange({});
      return;
    }
    onChange({ start_date: range[0].format('YYYY-MM-DD'), end_date: range[1].format('YYYY-MM-DD') });
  };

  const applyPreset = (preset: 'thisMonth' | 'thisQuarter' | 'thisYear' | 'all') => {
    const now = dayjs();
    if (preset === 'all') {
      onChange({});
      return;
    }
    if (preset === 'thisMonth') {
      onChange({
        start_date: now.startOf('month').format('YYYY-MM-DD'),
        end_date: now.endOf('month').format('YYYY-MM-DD'),
      });
      return;
    }
    if (preset === 'thisQuarter') {
      onChange({
        start_date: now.subtract(now.month() % 3, 'month').startOf('month').format('YYYY-MM-DD'),
        end_date: now.endOf('month').format('YYYY-MM-DD'),
      });
      return;
    }
    onChange({
      start_date: now.startOf('year').format('YYYY-MM-DD'),
      end_date: now.endOf('year').format('YYYY-MM-DD'),
    });
  };

  return (
    <Space size={8} style={style} wrap>
      <RangePicker
        value={pickerValue}
        allowClear={allowClear}
        placeholder={['开始日期', '结束日期']}
        onChange={(range) => emit(range as [Dayjs | null, Dayjs | null] | null)}
        presets={
          showPresets
            ? [
                { label: '本月', value: [dayjs().startOf('month'), dayjs().endOf('month')] },
                {
                  label: '本季度',
                  value: [
                    dayjs().subtract(dayjs().month() % 3, 'month').startOf('month'),
                    dayjs().endOf('month'),
                  ],
                },
                { label: '今年', value: [dayjs().startOf('year'), dayjs().endOf('year')] },
              ]
            : undefined
        }
      />
      {showPresets && (
        <Space size={4}>
          <a onClick={() => applyPreset('thisMonth')}>本月</a>
          <a onClick={() => applyPreset('thisYear')}>今年</a>
          <a onClick={() => applyPreset('all')}>全部</a>
        </Space>
      )}
    </Space>
  );
}

export default DateRangeBar;
