import type { ReactNode } from 'react';
import { Space } from 'antd';
import DateRangeBar from './DateRangeBar';
import ProjectSelect from './ProjectSelect';
import ExportButton from './ExportButton';
import { useAppStore } from '../store/app';
import type { DateRange } from '../types';

export interface PageToolbarProps {
  /** 项目筛选（不传 projectId 时自动绑定全局「当前项目」） */
  showProject?: boolean;
  projectId?: number | null;
  onProjectChange?: (id: number | null) => void;
  allowAllProjects?: boolean;
  /** 时间段筛选 */
  showDateRange?: boolean;
  dateRange?: DateRange;
  onDateRangeChange?: (range: DateRange) => void;
  /** 导出按钮 */
  showExport?: boolean;
  exportProjectId?: number | null;
  /** 页面自定义筛选控件（关键字、状态、类型…） */
  extra?: ReactNode;
  /** 右侧操作按钮（新增、生成预览…） */
  actions?: ReactNode;
}

/**
 * 列表页顶部固定控件区：项目筛选 + 时间段筛选 + 导出（docs/01-开发手册.md 第 3 节统一约定）。
 */
export function PageToolbar({
  showProject = false,
  projectId,
  onProjectChange,
  allowAllProjects = true,
  showDateRange = false,
  dateRange,
  onDateRangeChange,
  showExport = false,
  exportProjectId,
  extra,
  actions,
}: PageToolbarProps) {
  const storeProjectId = useAppStore((s) => s.currentProjectId);
  const setStoreProjectId = useAppStore((s) => s.setCurrentProjectId);
  const storeRange = useAppStore((s) => s.dateRange);
  const setStoreRange = useAppStore((s) => s.setDateRange);

  const effectiveProjectId = projectId !== undefined ? projectId : storeProjectId;
  const effectiveRange = dateRange ?? storeRange;

  return (
    <div className="pims-toolbar">
      <Space size={12} wrap>
        {showProject && (
          <ProjectSelect
            value={effectiveProjectId}
            allowAll={allowAllProjects}
            onChange={(id) => {
              if (onProjectChange) onProjectChange(id);
              else setStoreProjectId(id);
            }}
          />
        )}
        {showDateRange && (
          <DateRangeBar
            value={effectiveRange}
            onChange={(range) => {
              if (onDateRangeChange) onDateRangeChange(range);
              else setStoreRange(range);
            }}
          />
        )}
        {extra}
      </Space>
      <Space size={8} wrap>
        {actions}
        {showExport && (
          <ExportButton
            projectId={exportProjectId !== undefined ? exportProjectId : effectiveProjectId}
            dateRange={effectiveRange}
          />
        )}
      </Space>
    </div>
  );
}

export default PageToolbar;
