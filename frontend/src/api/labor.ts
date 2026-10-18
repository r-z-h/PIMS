/** 结算接口（五类成本共用）—— docs/03-接口设计.md 第 9 节 */
import { asList, http } from './client';
import type {
  LaborPayPayload,
  LaborPreview,
  LaborSettle,
  LaborSettlePayResult,
  ListQuery,
  Money,
  PageResult,
  PayMethod,
  SettleOverview,
  SettleType,
  SettleTypeInfo,
} from '../types/domain';

export interface SettleListQuery extends ListQuery {
  status?: string;
  settle_date?: string;
  /** 只看某一类（人工/材料/机械/杂费/垫付） */
  cost_type?: SettleType;
}

export interface SettlePreviewQuery {
  project_id: number;
  cost_type: SettleType;
  start_date?: string | null;
  end_date?: string | null;
}

export interface SettleCreatePayload {
  project_id: number;
  cost_type: SettleType;
  settle_date?: string;
  remark?: string;
  start_date?: string | null;
  end_date?: string | null;
}

export interface SettleOverviewQuery {
  project_id: number;
  cost_type: SettleType;
  start_date?: string | null;
  end_date?: string | null;
}

export const laborApi = {
  /** 五类结算类别 + 各自的汇总依据名（人工=按工人姓名、材料=按供应商…） */
  async types(): Promise<SettleTypeInfo[]> {
    const data = await http.get<SettleTypeInfo[] | { items: SettleTypeInfo[] }>('/labor/types');
    return asList<SettleTypeInfo>(data);
  },

  /**
   * **欠款总览**（一对象一行，累计口径）—— 结算页上半张表。
   *
   * 「已付」把该对象名下应付单上的**所有冲销记录**加起来，
   * 所以不管钱从哪个入口付的（收/付款页、冲销弹窗、登记已付、结算发放）都对得上；
   * 时间段只决定「显示哪些对象」，不改累计金额。
   */
  overview(query: SettleOverviewQuery): Promise<SettleOverview> {
    return http.get<SettleOverview>('/labor/overview', { ...query });
  },

  /**
   * 结算预览：**按该类别的汇总依据**汇总应发金额（不写库、不新增成本）。
   * 人工还额外带总工天；材料按供应商、机械按出租方、杂费按小类、垫付按垫付人。
   */
  preview(query: SettlePreviewQuery): Promise<LaborPreview> {
    return http.get<LaborPreview>('/labor/preview', { ...query });
  },

  /** 保存结算单（同一项目 + 同类别 + 同对象只有一张，重复生成时覆盖未发放部分） */
  settle(payload: SettleCreatePayload): Promise<{
    items: LaborSettle[];
    total_amount: number;
    created?: number;
    updated?: number;
    note?: string;
  }> {
    return http.post<{ items: LaborSettle[]; total_amount: number; created?: number; updated?: number; note?: string }>(
      '/labor/settle',
      payload,
    );
  },

  /** 结算单列表（可按 cost_type 只看某一类） */
  async settles(query: SettleListQuery = {}): Promise<PageResult<LaborSettle>> {
    const data = await http.get<PageResult<LaborSettle>>('/labor/settles', { ...query });
    return { ...data, items: asList<LaborSettle>(data) };
  },

  /**
   * **按对象发放**（结算页总览表的发放按钮）——发放口径是"该对象还欠多少"，
   * 所以不依赖结算单 id；后端会校验上限（累计应付 − 已付），超了返回 400。
   */
  payByPartner(payload: {
    project_id: number;
    cost_type: SettleType;
    partner: string;
    amount: Money;
    pay_date: string;
    pay_method?: PayMethod | null;
    remark?: string | null;
  }): Promise<LaborSettlePayResult> {
    return http.post<LaborSettlePayResult>('/labor/pay', payload);
  },

  /**
   * 登记发放（按结算单 id，旧入口保留）。
   * 除更新结算单外，还会**生成付款流水并自动冲销该对象的应付单**。
   */
  pay(id: number, payload: LaborPayPayload): Promise<LaborSettlePayResult> {
    return http.post<LaborSettlePayResult>(`/labor/settles/${id}/pay`, payload);
  },

  /** 删除结算单（仅未发放的允许删除） */
  removeSettle(id: number): Promise<{ id: number; deleted: boolean }> {
    return http.delete<{ id: number; deleted: boolean }>(`/labor/settles/${id}`);
  },
};
