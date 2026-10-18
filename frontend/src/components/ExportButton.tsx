import { useState } from 'react';
import { Button, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { exportApi } from '../api/export';
import type { DateRange } from '../types';

export interface ExportButtonProps {
  /** 当前筛选条件：项目（不传＝全部项目） */
  projectId?: number | null;
  /** 当前筛选条件：时间段 */
  dateRange?: DateRange;
  label?: string;
  block?: boolean;
  size?: 'small' | 'middle' | 'large';
  type?: 'default' | 'primary' | 'dashed' | 'link' | 'text';
  disabled?: boolean;
}

/**
 * 导出按钮：遵循当前页面筛选条件（项目、时间段），
 * 后端返回单个 xlsx、多工作表文件流（docs/03-接口设计.md 第 11 节）。
 */
export function ExportButton({
  projectId,
  dateRange,
  label = '导出 Excel',
  block,
  size = 'middle',
  type = 'default',
  disabled,
}: ExportButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleExport = async () => {
    setLoading(true);
    try {
      const result = await exportApi.excel({
        project_id: projectId ?? undefined,
        start_date: dateRange?.start_date,
        end_date: dateRange?.end_date,
      });
      if (result.mockCsv) {
        void message.success(`Mock 模式：已导出 ${result.filename}（接入后端后为多 Sheet Excel）`);
      } else {
        void message.success(`已导出 ${result.filename}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      icon={<DownloadOutlined />}
      loading={loading}
      onClick={handleExport}
      block={block}
      size={size}
      type={type}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

export default ExportButton;
