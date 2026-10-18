/** 五类成本接口 —— docs/03-接口设计.md 第 7 节 */
import { asList, http } from './client';
import type {
  AdvanceCostPayload,
  ChangeLog,
  CostBrief,
  CostItem,
  CostPaymentPayload,
  CostPaymentResult,
  CostPayableSummary,
  CostSummary,
  LaborCostPayload,
  ListQuery,
  MachineCostPayload,
  MaterialCostPayload,
  MaterialCostResult,
  MiscCostPayload,
  PageResult,
} from '../types/domain';

export interface CostListQuery extends ListQuery {
  /** 多选：type=labor,material */
  type?: string;
}

/**
 * 容错归一：后端可能把明细字段平铺在 cost 上，也可能放在 labor/material/machine/advance/detail 子对象里。
 * 只做字段搬运，不改名。
 */
export function normalizeCost(raw: unknown): CostItem {
  const source = (raw ?? {}) as Record<string, unknown>;
  const nested: Record<string, unknown> = {};
  ['labor', 'material', 'machine', 'advance', 'misc', 'detail', 'labor_work', 'material_item', 'machine_item', 'advance_item'].forEach(
    (key) => {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(nested, value as Record<string, unknown>);
      }
    },
  );
  const merged: Record<string, unknown> = { ...nested };
  Object.entries(source).forEach(([key, value]) => {
    if (value !== undefined && value !== null) merged[key] = value;
  });
  return merged as unknown as CostItem;
}

export const costApi = {
  async list(query: CostListQuery = {}): Promise<PageResult<CostItem>> {
    const data = await http.get<PageResult<CostItem>>('/costs', { ...query });
    return { ...data, items: asList<CostItem>(data).map(normalizeCost) };
  },

  summary(query: CostListQuery = {}): Promise<CostSummary> {
    return http.get<CostSummary>('/costs/summary', { ...query });
  },

  /** 录工天：实时计入成本 */
  createLabor(payload: LaborCostPayload): Promise<{ cost_id: number; item?: CostItem }> {
    return http.post<{ cost_id: number; item?: CostItem }>('/costs/labor', payload);
  },

  /** 录材料采购：同时写库存入库 */
  createMaterial(payload: MaterialCostPayload): Promise<MaterialCostResult> {
    return http.post<MaterialCostResult>('/costs/material', payload);
  },

  createMachine(payload: MachineCostPayload): Promise<{ cost_id: number; item?: CostItem }> {
    return http.post<{ cost_id: number; item?: CostItem }>('/costs/machine', payload);
  },

  createMisc(payload: MiscCostPayload): Promise<{ cost_id: number; item?: CostItem }> {
    return http.post<{ cost_id: number; item?: CostItem }>('/costs/misc', payload);
  },

  createAdvance(payload: AdvanceCostPayload): Promise<{ cost_id: number; item?: CostItem }> {
    return http.post<{ cost_id: number; item?: CostItem }>('/costs/advance', payload);
  },

  /** 修改成本（后端按 type 自动同步明细表） */
  update(id: number, payload: Record<string, unknown>): Promise<CostItem> {
    return http.put<CostItem>(`/costs/${id}`, payload);
  },

  /** 软删除成本（材料类同时回冲库存入库流水） */
  remove(id: number): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/costs/${id}`);
  },

  /** 该条成本的修改记录（时间线） */
  async logs(id: number): Promise<ChangeLog[]> {
    const data = await http.get<ChangeLog[] | { items: ChangeLog[] }>(`/costs/${id}/logs`);
    return asList<ChangeLog>(data);
  },

  /**
   * 轻量成本摘要（类别 / 对象 / 金额 / 日期），供「关联成本」列显示与悬停使用。
   * 列表接口已经带回摘要时不必再调这个。
   */
  brief(id: number): Promise<CostBrief> {
    return http.get<CostBrief>(`/costs/${id}/brief`);
  },

  /** 该成本自动生成的应付单（含已付/未结/冲销明细），用于录入后的「登记已付」弹窗 */
  payable(id: number): Promise<CostPayableSummary> {
    return http.get<CostPayableSummary>(`/costs/${id}/payable`);
  },

  /**
   * 登记该成本的已付金额：生成一笔付款流水并自动冲销对应的应付单。
   * 四个字段全部选填；不传 paid_amount（或传 0）则什么都不做，应付单全额挂账。
   */
  pay(id: number, payload: CostPaymentPayload): Promise<CostPaymentResult> {
    return http.post<CostPaymentResult>(`/costs/${id}/pay`, payload);
  },
};
