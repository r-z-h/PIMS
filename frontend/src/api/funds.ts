/** 资金流水接口 —— docs/03-接口设计.md 第 5 节 */
import { http } from './client';
import type {
  FundsFlow,
  FundsPayload,
  FundsSummary,
  ListQuery,
  PageResult,
} from '../types/domain';

export interface FundsListQuery extends ListQuery {
  direction?: string;
  biz_type?: string;
  pay_method?: string;
}

export const fundsApi = {
  list(query: FundsListQuery = {}): Promise<PageResult<FundsFlow>> {
    return http.get<PageResult<FundsFlow>>('/funds', { ...query });
  },

  create(payload: FundsPayload): Promise<FundsFlow> {
    return http.post<FundsFlow>('/funds', payload);
  },

  /** 详情（含已被冲销的单据列表） */
  detail(id: number): Promise<FundsFlow> {
    return http.get<FundsFlow>(`/funds/${id}`);
  },

  update(id: number, payload: Partial<FundsPayload>): Promise<FundsFlow> {
    return http.put<FundsFlow>(`/funds/${id}`, payload);
  },

  /** 已产生冲销记录时后端返回 409 */
  remove(id: number): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/funds/${id}`);
  },

  /** 传 direction 时只统计该方向（另一方向归零），让合计与列表口径一致 */
  summary(query: FundsListQuery = {}): Promise<FundsSummary> {
    return http.get<FundsSummary>('/funds/summary', { ...query });
  },
};
