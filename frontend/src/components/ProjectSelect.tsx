import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { useProjects } from '../hooks/useProject';

export interface ProjectSelectProps extends Omit<SelectProps<number | null>, 'options' | 'value' | 'onChange'> {
  value?: number | null;
  onChange?: (value: number | null) => void;
  /** 是否允许「全部项目」选项（默认允许） */
  allowAll?: boolean;
  allLabel?: string;
  autoLoad?: boolean;
}

/** 项目选择器：选项来自 /api/projects，全站共用一份缓存 */
export function ProjectSelect({
  value,
  onChange,
  allowAll = true,
  allLabel = '全部项目',
  placeholder = '选择项目',
  autoLoad = true,
  ...rest
}: ProjectSelectProps) {
  const { options, loading } = useProjects(autoLoad);
  const merged = allowAll ? [{ value: null, label: allLabel }, ...options] : options;

  return (
    <Select<number | null>
      {...rest}
      showSearch
      allowClear={false}
      loading={loading}
      placeholder={placeholder}
      value={value ?? null}
      optionFilterProp="label"
      // 统一的类名：便于断言「同一个筛选只出现一次」（tests/filtersonce.spec.ts）
      className={['pims-project-select', rest.className].filter(Boolean).join(' ')}
      style={{ minWidth: 180, ...rest.style }}
      options={merged}
      onChange={(next) => onChange?.(next ?? null)}
    />
  );
}

export default ProjectSelect;
