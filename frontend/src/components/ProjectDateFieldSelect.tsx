import { Select, Tooltip } from 'antd';
import { useAppStore, type ProjectDateField } from '../store/app';

/**
 * 「日期按什么筛项目」的下拉（2026-10-17 需求）。
 *
 * 老板的原话：「我需要的是能够通过项目名字和日期对项目进行筛选」。
 * 日期到底筛什么有两种理解，做成可选：
 *
 * - **有业务数据**（默认）：选某区间 → 只出现这个期间里有成本/收付款/往来/入库的项目
 *   （用来回答"这段时间哪些项目在动"）
 * - **开工日期**：选某区间 → 只出现开工日期落在区间内的项目（纯档案属性）
 *
 * 项目列表与首页共用同一个 store 值，所以两处口径永远一致。
 */
export const PROJECT_DATE_FIELD_LABEL: Record<ProjectDateField, string> = {
  activity: '有业务数据',
  start_date: '开工日期',
};

export const PROJECT_DATE_FIELD_OPTIONS = [
  {
    value: 'activity' as ProjectDateField,
    label: '日期筛：有业务数据',
  },
  {
    value: 'start_date' as ProjectDateField,
    label: '日期筛：开工日期',
  },
];

export function ProjectDateFieldSelect({ style }: { style?: React.CSSProperties }) {
  const value = useAppStore((s) => s.projectDateField);
  const setValue = useAppStore((s) => s.setProjectDateField);

  return (
    <Tooltip
      title={
        value === 'activity'
          ? '只显示所选时间段内有成本/收付款/往来/入库的项目'
          : '只显示所选时间段内开工的项目（按开工日期）'
      }
    >
      <Select<ProjectDateField>
        value={value}
        onChange={setValue}
        options={PROJECT_DATE_FIELD_OPTIONS}
        style={{ width: 168, ...style }}
      />
    </Tooltip>
  );
}

export default ProjectDateFieldSelect;
