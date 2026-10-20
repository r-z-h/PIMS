/** 快速查询接口 —— 2026-10-19 需求（按勾选执行，选一个只回一个 block） */
import { http } from './client';
import type { Money } from '../types/domain';

/** 列的前端渲染方式 */
export type QueryColumnType = 'text' | 'money' | 'qty' | 'date' | 'percent' | 'status';

export interface QueryColumn {
  key: string;
  title: string;
  type: QueryColumnType;
  width?: number;
}

/** 结果块里的一行：键随查询类型变化，统一按 unknown 取值 */
export type QueryRow = Record<string, string | number | null | undefined>;

export interface QueryBlock {
  type: string;
  title: string;
  columns: QueryColumn[];
  rows: QueryRow[];
  /** 合计/概要：键随查询类型变化 */
  summary: Record<string, Money | number | boolean | null | undefined>;
  empty_text: string;
  note?: string;
  /** 单个查询失败时存在（不影响其他块） */
  error?: string;
}

export interface QueryTypeInfo {
  code: string;
  name: string;
  description: string;
  needs_project: boolean;
  default_selected: boolean;
}

export interface QueryTypesResult {
  items: QueryTypeInfo[];
  /** 默认勾选的编码（= 全部） */
  default: string[];
  total: number;
}

export interface QuickQueryRunResult {
  blocks: QueryBlock[];
  project_id: number | null;
  range: { start_date: string | null; end_date: string | null };
  selected: string[];
}

export interface QuickQueryRunPayload {
  types: string[];
  project_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

export const queryApi = {
  /** 可查询内容清单（前端据此渲染勾选框，默认全选） */
  types(): Promise<QueryTypesResult> {
    return http.get<QueryTypesResult>('/query/types');
  },

  /**
   * 执行查询。
   * `types` 只传一个 → 返回的 `blocks` 也只有一块，页面就只渲染这一块。
   */
  run(payload: QuickQueryRunPayload): Promise<QuickQueryRunResult> {
    return http.post<QuickQueryRunResult>('/query/run', payload);
  },
};
