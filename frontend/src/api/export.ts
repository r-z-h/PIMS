/** 导出接口 —— docs/03-接口设计.md 第 11 节：单个 xlsx、多工作表，直接返回文件流 */
import { http } from './client';
import { buildExportName, downloadBlob, filenameFromDisposition } from '../utils/download';

export interface ExportQuery {
  project_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface ExportResult {
  filename: string;
  /** Mock 模式返回的是 CSV 预览文件（真实后端为多 Sheet xlsx） */
  mockCsv: boolean;
}

export const exportApi = {
  /** 按筛选条件导出 Excel（项目盈亏 / 资金流水 / 人工 / 材料 / 机械 / 杂费 / 垫付 / 应收 / 应付 / 库存 / 人工结算） */
  async excel(query: ExportQuery = {}): Promise<ExportResult> {
    const response = await http.download('/export/excel', { ...query });
    const headers = response.headers ?? {};
    const disposition = headers['content-disposition'] as string | undefined;
    const mockCsv = headers['x-mock-export'] === 'csv';
    const filename = filenameFromDisposition(disposition, buildExportName(mockCsv ? 'csv' : 'xlsx'));
    const blob = new Blob([response.data], { type: 'application/octet-stream' });
    downloadBlob(blob, filename);
    return { filename, mockCsv };
  },
};
