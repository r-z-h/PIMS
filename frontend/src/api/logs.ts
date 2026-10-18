/** 变更日志接口 —— docs/03-接口设计.md 第 12 节 */
import { asList, http } from './client';
import type { ChangeLog, ListQuery, PageResult } from '../types/domain';

export interface LogListQuery extends ListQuery {
  table_name?: string;
  record_id?: number;
  action?: string;
}

export const logApi = {
  async list(query: LogListQuery = {}): Promise<PageResult<ChangeLog>> {
    const data = await http.get<PageResult<ChangeLog>>('/logs', { ...query });
    return { ...data, items: asList<ChangeLog>(data) };
  },

  /** 某条记录的全部修改历史（详情抽屉的时间线数据源） */
  async history(tableName: string, recordId: number): Promise<ChangeLog[]> {
    const data = await http.get<ChangeLog[] | { items: ChangeLog[] }>(`/logs/${tableName}/${recordId}`);
    return asList<ChangeLog>(data);
  },
};
