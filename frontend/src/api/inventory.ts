/** 库存接口 —— docs/03-接口设计.md 第 8 节 */
import { asList, http } from './client';
import type {
  InventoryBalance,
  InventoryInPayload,
  InventoryOutPayload,
  InventoryOutResult,
  InventoryTxn,
  ListQuery,
  PageResult,
} from '../types/domain';
import { subMoney } from '../utils/money';

export interface InventoryTxnQuery extends ListQuery {
  txn_type?: string;
  material_name?: string;
}

export function normalizeBalance(raw: unknown): InventoryBalance {
  const row = (raw ?? {}) as InventoryBalance;
  return { ...row, balance: row.balance ?? subMoney(row.in_qty, row.out_qty) };
}

export const inventoryApi = {
  /** 库存余量（project_id 必填，体现项目隔离） */
  async balances(projectId: number): Promise<InventoryBalance[]> {
    const data = await http.get<InventoryBalance[] | { items: InventoryBalance[] }>('/inventory', {
      project_id: projectId,
    });
    return asList<InventoryBalance>(data).map(normalizeBalance);
  },

  /** 库存流水 */
  async txns(query: InventoryTxnQuery): Promise<PageResult<InventoryTxn>> {
    const data = await http.get<PageResult<InventoryTxn>>('/inventory/txns', { ...query });
    return { ...data, items: asList<InventoryTxn>(data) };
  },

  /** 手工补录入库（不生成成本） */
  in(payload: InventoryInPayload): Promise<{ txn_id?: number; balance: number; enough: boolean }> {
    return http.post<{ txn_id?: number; balance: number; enough: boolean }>('/inventory/in', payload);
  },

  /** 领用：只减库存，不生成成本；余量不足时 enough=false 但接口仍成功 */
  out(payload: InventoryOutPayload): Promise<InventoryOutResult> {
    return http.post<InventoryOutResult>('/inventory/out', payload);
  },

  updateTxn(id: number, payload: Record<string, unknown>): Promise<InventoryTxn> {
    return http.put<InventoryTxn>(`/inventory/txns/${id}`, payload);
  },

  removeTxn(id: number): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/inventory/txns/${id}`);
  },
};
