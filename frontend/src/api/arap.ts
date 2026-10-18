/** 应收应付与冲销接口 —— docs/03-接口设计.md 第 6 节 */
import { asList, http } from './client';
import type {
  ArApDetail,
  ArApItem,
  ArApPayload,
  ArApSummary,
  ArApType,
  AutoOffsetPlan,
  ListQuery,
  OffsetPayload,
  PageResult,
} from '../types/domain';
import { subMoney, toScaled } from '../utils/money';

export interface ArApListQuery extends ListQuery {
  type?: ArApType;
  status?: string;
}

/** 容错归一：未结金额 = 金额 − 已冲销（后端未返回时前端按口径算） */
export function normalizeArAp(raw: unknown): ArApItem {
  const item = (raw ?? {}) as ArApItem;
  const settled = item.settled_amount ?? 0;
  const unsettled = item.unsettled ?? subMoney(item.amount, settled);
  const status =
    item.status ??
    (toScaled(settled, 2) <= 0
      ? 'open'
      : toScaled(subMoney(item.amount, settled), 2) <= 0
        ? 'closed'
        : 'partial');
  return { ...item, settled_amount: settled, unsettled, status };
}

export const arapApi = {
  async list(query: ArApListQuery = {}): Promise<PageResult<ArApItem>> {
    const data = await http.get<PageResult<ArApItem>>('/arap', { ...query });
    return { ...data, items: asList<ArApItem>(data).map(normalizeArAp) };
  },

  create(payload: ArApPayload): Promise<ArApItem> {
    return http.post<ArApItem>('/arap', payload);
  },

  async detail(id: number): Promise<ArApDetail> {
    const data = await http.get<ArApDetail>(`/arap/${id}`);
    return { item: normalizeArAp(data.item), offsets: asList(data.offsets) };
  },

  update(id: number, payload: Partial<ArApPayload>): Promise<ArApItem> {
    return http.put<ArApItem>(`/arap/${id}`, payload);
  },

  /** 已有冲销时后端返回 409 */
  remove(id: number): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/arap/${id}`);
  },

  /** 待冲销单据（project_id + type 必填，status <> closed） */
  async pending(projectId: number, type: ArApType): Promise<ArApItem[]> {
    const data = await http.get<ArApItem[] | { items: ArApItem[] }>('/arap/pending', {
      project_id: projectId,
      type,
    });
    return asList<ArApItem>(data).map(normalizeArAp);
  },

  /** 手工冲销：一次可冲多张单据 */
  offset(payload: OffsetPayload): Promise<{ offsets: unknown[]; total_offset?: number }> {
    return http.post<{ offsets: unknown[]; total_offset?: number }>('/arap/offset', payload);
  },

  /** 撤销某条冲销 */
  revokeOffset(id: number): Promise<{ id: number; revoked: boolean }> {
    return http.delete<{ id: number; revoked: boolean }>(`/arap/offset/${id}`);
  },

  /**
   * 自动冲销计划（只算不写，需求 T4）：按「同项目、同业务类型、日期最早优先」
   * 算出打算冲哪几张单、每张多少、还剩多少。弹「预冲窗口」时调用。
   */
  autoOffsetPlan(fundsFlowId: number): Promise<AutoOffsetPlan> {
    return http.get<AutoOffsetPlan>('/arap/auto-offset/plan', { funds_flow_id: fundsFlowId });
  },

  /** 按自动规则直接冲销（用户没改动时用）；无可冲单据时 applied=false，不报错 */
  autoOffsetApply(fundsFlowId: number): Promise<AutoOffsetPlan & { applied: boolean }> {
    return http.post<AutoOffsetPlan & { applied: boolean }>(
      `/arap/auto-offset/apply?funds_flow_id=${fundsFlowId}`,
    );
  },

  /** 该收未收 / 该付未付合计 */
  summary(query: ListQuery = {}): Promise<ArApSummary> {
    return http.get<ArApSummary>('/arap/summary', { ...query });
  },
};
