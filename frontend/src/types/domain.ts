/**
 * 业务实体类型 —— 字段名严格对齐 docs/02-数据库设计.md 与 docs/03-接口设计.md。
 * 一律 snake_case，不重命名。
 */
import type { Money } from './api';

export type { Money, ListQuery, PageResult, DateRange } from './api';

/* ------------------------------- 枚举 ------------------------------- */

export type ProjectStatus = 'ongoing' | 'finished';
export type CostType = 'labor' | 'material' | 'machine' | 'misc' | 'advance';
export type FundDirection = 'in' | 'out';
export type FundBizType =
  | 'progress'
  | 'settle'
  | 'advance'
  | 'material'
  | 'labor'
  | 'machine'
  | 'misc'
  | 'advance_pay'
  | 'other';
export type PayMethod = 'cash' | 'wechat' | 'bank_card' | 'transfer';
export type ArApType = 'receivable' | 'payable';
export type ArApStatus = 'open' | 'partial' | 'closed';
export type InvTxnType = 'in' | 'out';
export type MachineMeasure = 'shift' | 'hour';
export type SettleStatus = 'unpaid' | 'partial' | 'paid';
export type DictType = 'misc_category' | 'material' | 'unit' | 'partner';
export type ChangeAction = 'create' | 'update' | 'delete';

/* ------------------------------- 项目 ------------------------------- */

export interface Project {
  id: number;
  name: string;
  client_name?: string | null;
  location?: string | null;
  manager?: string | null;
  start_date?: string | null;
  status: ProjectStatus;
  /** 完工锁（2026-10-17）：完工后默认锁定，所有写操作要先输密码解锁 */
  is_finished?: boolean;
  is_locked?: boolean;
  /** 解锁时间；为空表示已锁定 */
  unlocked_at?: string | null;
  client_budget: Money;
  cost_budget: Money;
  /** JSON 数组 ["王工","张三"] 或逗号分隔文本 */
  members?: string[] | string | null;
  remark?: string | null;
  deleted?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectPayload {
  name: string;
  client_name?: string | null;
  location?: string | null;
  manager?: string | null;
  start_date?: string | null;
  status: ProjectStatus;
  client_budget: Money;
  cost_budget: Money;
  members?: string[];
  remark?: string | null;
}

export interface ProjectMetrics {
  /** 预计利润 = 甲方预算 − 我方成本预算 */
  expect_profit: Money;
  /** 实际成本 = 五类成本之和 */
  actual_cost: Money;
  /** 结算利润 = 甲方预算 − 实际成本 */
  settle_profit: Money;
  /** 成本预算余额 = 我方成本预算 − 实际成本 */
  budget_left: Money;
  /** 预算使用率 %（辅助指标，不参与利润） */
  budget_usage_rate: number;
}

/** GET /api/projects/{id} 与 /api/projects/{id}/overview 的统一形状 */
export interface ProjectOverview {
  project?: Project;
  metrics: ProjectMetrics;
  cost_by_type: Partial<Record<CostType, Money>>;
  ar_ap: {
    receivable_unsettled: Money;
    payable_unsettled: Money;
  };
  funds: {
    total_in: Money;
    total_out: Money;
  };
  inventory_amount?: Money;
}

/* ------------------------------- 首页看板 ------------------------------- */

export interface DashboardRow {
  project_id: number;
  name: string;
  status: ProjectStatus;
  client_budget: Money;
  cost_budget: Money;
  expect_profit: Money;
  actual_cost: Money;
  settle_profit: Money;
  budget_left: Money;
  received: Money;
  unreceived: Money;
  paid: Money;
  unpaid: Money;
}

export interface DashboardTotal {
  client_budget: Money;
  cost_budget?: Money;
  expect_profit: Money;
  actual_cost: Money;
  settle_profit: Money;
  budget_left?: Money;
  received?: Money;
  unreceived?: Money;
  paid?: Money;
  unpaid?: Money;
}

export interface DashboardProjects {
  items: DashboardRow[];
  total: DashboardTotal;
}

export interface RecentActivity {
  id: number;
  kind: string;
  title: string;
  amount?: Money;
  biz_date?: string;
  project_id?: number;
  project_name?: string;
  created_at?: string;
}

export interface CostTrendPoint {
  month: string;
  amount: Money;
}

/* ------------------------------- 资金流水 ------------------------------- */

export interface FundsFlow {
  id: number;
  project_id: number;
  project_name?: string | null;
  direction: FundDirection;
  biz_type: FundBizType;
  amount: Money;
  biz_date: string;
  partner?: string | null;
  pay_method?: PayMethod | null;
  remark?: string | null;
  deleted?: number;
  created_at?: string;
  updated_at?: string;
  /** 详情接口附带：已被冲销的单据列表 */
  offsets?: ArApOffset[];
}

export interface FundsPayload {
  project_id: number;
  direction: FundDirection;
  biz_type: FundBizType;
  amount: Money;
  biz_date: string;
  partner?: string | null;
  pay_method?: PayMethod | null;
  remark?: string | null;
}

export interface FundsSummary {
  total_in: Money;
  total_out: Money;
  net: Money;
  by_project?: Array<{ project_id: number; total_in: Money; total_out: Money; net: Money }>;
}

/* ------------------------------- 应收应付 ------------------------------- */

export interface ArApItem {
  id: number;
  project_id: number;
  project_name?: string | null;
  type: ArApType;
  biz_type: FundBizType;
  amount: Money;
  settled_amount: Money;
  /** 派生值 = amount − settled_amount */
  unsettled?: Money;
  status: ArApStatus;
  biz_date: string;
  partner?: string | null;
  cost_id?: number | null;
  remark?: string | null;
  deleted?: number;
  created_at?: string;
  updated_at?: string;
  /* 后端序列化时附带的中文标签 */
  type_label?: string;
  biz_type_label?: string;
  status_label?: string;
  offset_count?: number;
}

/** 自动冲销结果（付款/收款保存后、结算发放时都可能返回，需求 T4 / T6） */
export interface OffsetOutcome {
  applied: boolean;
  offset_ids: number[];
  /** 本次实际冲销合计 */
  plan_total: Money;
  /** 未能冲销、留在流水上的可冲余额 */
  remaining: Money;
  message?: string;
}

/** 登记发放的返回（需求 T6：发放同时生成付款流水并冲销应付单） */
export interface LaborSettlePayResult extends LaborSettle {
  /** 本次发放生成的付款流水 id */
  funds_flow_id?: number;
  offset?: OffsetOutcome;
  /** 冲销情况的文字说明 */
  offset_hint?: string;
}

/** 自动冲销计划（GET /arap/auto-offset/plan，需求 T4）：只算不写 */
export interface AutoOffsetPlan {
  funds_flow_id: number;
  direction: FundDirection;
  arap_type: ArApType;
  flow_amount: Money;
  already_offset: Money;
  /** 本笔流水还能冲多少 */
  available: Money;
  /** 建议冲销明细（同项目、同业务类型、日期最早优先） */
  plan: Array<{
    ar_ap_id: number;
    biz_date: string;
    biz_type: FundBizType;
    biz_type_label?: string;
    partner?: string | null;
    amount: Money;
    unsettled: Money;
    amount_to_offset: Money;
  }>;
  plan_total: Money;
  /** 冲完仍剩下的可冲余额（留在流水上） */
  remaining: Money;
  has_candidate: boolean;
  message: string;
  /** 是否真的执行了冲销（apply 接口返回） */
  applied?: boolean;
  offset_ids?: number[];
}

/** 某笔成本的轻量摘要（GET /costs/{id}/brief，也随库存流水一起返回） */
export interface CostBrief {
  id: number;
  type: CostType;
  type_label: string;
  /** 对象名：材料名 / 姓名 / 设备名 / 垫付人 / 杂费小类 */
  expense?: string | null;
  /** 与 expense 同义（兼容字段） */
  subject?: string | null;
  /** 往来对象：供应商 / 出租方等 */
  partner?: string | null;
  amount: Money;
  biz_date?: string | null;
  category?: string | null;
  deleted?: number;
  /** 后端拼好的显示文案，如「材料 · 水泥 40000.00」 */
  label?: string | null;
}

/** 某笔成本自动生成的应付单及其冲销情况（GET /costs/{id}/payable） */
export interface CostPayableSummary {
  has_payable: boolean;
  arap?: ArApItem;
  offsets?: Array<{
    id: number;
    funds_flow_id: number;
    amount: Money;
    offset_date: string;
    remark?: string | null;
  }>;
  /** 已付合计 */
  paid_total?: Money;
  /** 未结（还欠多少） */
  unsettled?: Money;
}

/** 录成本后「登记已付」的入参：四个字段全部选填 */
export interface CostPaymentPayload {
  paid_amount?: Money | null;
  pay_method?: PayMethod | null;
  pay_date?: string | null;
  remark?: string | null;
}

export interface CostPaymentResult {
  recorded: boolean;
  reason?: string;
  funds_flow_id?: number;
  offset_ids?: number[];
  paid_amount?: Money;
  flow_unapplied?: Money;
  flow_unapplied_hint?: string;
  arap: ArApItem;
}

export interface ArApPayload {
  project_id: number;
  type: ArApType;
  biz_type: FundBizType;
  amount: Money;
  biz_date: string;
  partner?: string | null;
  cost_id?: number | null;
  remark?: string | null;
}

export interface ArApDetail {
  item: ArApItem;
  offsets: ArApOffset[];
}

export interface ArApOffset {
  id: number;
  ar_ap_id: number;
  funds_flow_id: number;
  amount: Money;
  offset_date: string;
  remark?: string | null;
  created_at?: string;
  /** 列表冗余展示用（后端可能返回） */
  biz_date?: string;
  partner?: string | null;
  biz_type?: FundBizType;
  funds_biz_date?: string;
}

export interface OffsetPayload {
  funds_flow_id: number;
  offsets: Array<{ ar_ap_id: number; amount: Money }>;
  offset_date: string;
  remark?: string | null;
}

export interface ArApSummary {
  receivable_unsettled: Money;
  payable_unsettled: Money;
}

/* ------------------------------- 成本 ------------------------------- */

export interface CostItem {
  id: number;
  project_id: number;
  project_name?: string | null;
  type: CostType;
  category?: string | null;
  amount: Money;
  biz_date: string;
  partner?: string | null;
  remark?: string | null;
  deleted?: number;
  created_at?: string;
  updated_at?: string;
  /* 人工 labor_work */
  worker_name?: string | null;
  work_days?: Money | null;
  day_rate?: Money | null;
  /* 材料 material_item */
  material_name?: string | null;
  unit?: string | null;
  quantity?: Money | null;
  unit_price?: Money | null;
  supplier?: string | null;
  inventory_txn_id?: number | null;
  /* 机械 machine_item */
  machine_name?: string | null;
  measure?: MachineMeasure | null;
  lessor?: string | null;
  /* 垫付 advance_item */
  payer?: string | null;
  purpose?: string | null;
}

export interface CostSummary {
  total: Money;
  by_type: Record<string, Money>;
  by_category?: Array<{ category: string; amount: Money }>;
  by_project?: Array<{ project_id: number; amount: Money }>;
}

export interface LaborCostPayload {
  project_id: number;
  worker_name: string;
  biz_date: string;
  work_days: Money;
  day_rate: Money;
  amount?: Money;
  remark?: string | null;
}

export interface MaterialCostPayload {
  project_id: number;
  material_name: string;
  unit: string;
  quantity: Money;
  unit_price: Money;
  amount?: Money;
  supplier?: string | null;
  biz_date: string;
  remark?: string | null;
}

export interface MaterialCostResult {
  cost_id: number;
  inventory_txn_id: number;
  inventory_balance: Money;
}

export interface MachineCostPayload {
  project_id: number;
  machine_name: string;
  measure: MachineMeasure;
  quantity: Money;
  unit_price: Money;
  amount?: Money;
  lessor?: string | null;
  biz_date: string;
  remark?: string | null;
}

export interface MiscCostPayload {
  project_id: number;
  category: string;
  amount: Money;
  biz_date: string;
  remark?: string | null;
}

export interface AdvanceCostPayload {
  project_id: number;
  payer?: string | null;
  purpose?: string | null;
  amount: Money;
  biz_date: string;
  remark?: string | null;
}

/* ------------------------------- 库存 ------------------------------- */

export interface InventoryBalance {
  id?: number;
  project_id?: number;
  material_name: string;
  unit: string;
  in_qty: Money;
  out_qty: Money;
  /** 余量 = in_qty − out_qty */
  balance?: Money;
}

export interface InventoryTxn {
  id: number;
  project_id: number;
  project_name?: string | null;
  material_name: string;
  unit: string;
  txn_type: InvTxnType;
  quantity: Money;
  unit_price?: Money | null;
  supplier?: string | null;
  cost_id?: number | null;
  /** 关联成本的摘要（后端随列表一起返回，用于「关联成本」列显示，需求 T3） */
  cost?: CostBrief | null;
  cost_label?: string | null;
  biz_date: string;
  remark?: string | null;
  deleted?: number;
  created_at?: string;
  updated_at?: string;
}

export interface InventoryInPayload {
  project_id: number;
  material_name: string;
  unit: string;
  quantity: Money;
  unit_price?: Money | null;
  supplier?: string | null;
  biz_date: string;
  remark?: string | null;
}

export interface InventoryOutPayload {
  project_id: number;
  material_name: string;
  unit: string;
  quantity: Money;
  biz_date: string;
  remark?: string | null;
}

export interface InventoryOutResult {
  balance: Money;
  enough: boolean;
}

/* ------------------------------- 结算（五类成本） ------------------------------- */

/**
 * 结算类别（2026-10-16 起从「人工结算」泛化为五类）。
 * 五类的结算机制相同，只是**汇总依据不同**：
 * labor=工人姓名、material=供应商、machine=出租方、misc=杂费小类、advance=垫付人。
 */
export type SettleType = 'labor' | 'material' | 'machine' | 'misc' | 'advance';

/** 结算类别 + 它的汇总依据名（GET /labor/types） */
export interface SettleTypeInfo {
  cost_type: SettleType;
  cost_type_label: string;
  /** 例如「按供应商」 */
  group_label: string;
}

/** 付款方式构成（欠款总览里用） */
export interface PaidMethodItem {
  pay_method: string;
  pay_method_label: string;
  amount: Money;
}

/** 欠款总览的一行（GET /labor/overview，一对象一行，累计口径） */
export interface SettleOverviewItem {
  partner: string;
  worker_name: string;
  cost_type: SettleType;
  cost_type_label?: string;
  /** 累计应付（该对象名下全部成本） */
  amount_due: Money;
  /** 累计已付（该对象名下应付单的全部冲销记录） */
  paid_amount: Money;
  /** 还欠 = 应付 − 已付（发放的硬上限） */
  unsettled: Money;
  /** 本期该结（时间段内的成本，仅展示） */
  period_amount: Money;
  /** 付款方式构成 */
  paid_methods: PaidMethodItem[];
  status: 'open' | 'partial' | 'closed';
}

export interface SettleOverview {
  project_id?: number;
  project_name?: string | null;
  cost_type?: SettleType;
  cost_type_label?: string;
  group_label?: string;
  items: SettleOverviewItem[];
  total_due: Money;
  total_paid: Money;
  total_unsettled: Money;
  note?: string;
}

export interface LaborPreviewItem {
  worker_name: string;
  /** 汇总依据值（与 worker_name 同值；人工时就是姓名） */
  partner: string;
  cost_type?: SettleType;
  cost_type_label?: string;
  /** 该类下的成本笔数 */
  cost_count?: number;
  total_days: Money;
  amount_due: Money;
  paid_amount?: Money;
  settle_id?: number | null;
  status?: SettleStatus;
}

export interface LaborPreview {
  project_id?: number;
  project_name?: string | null;
  cost_type?: SettleType;
  cost_type_label?: string;
  /** 该类别的汇总依据名，如「按供应商」 */
  group_label?: string;
  items: LaborPreviewItem[];
  total_amount: Money;
  total_days?: Money;
  note?: string;
}

export interface LaborSettle {
  id: number;
  project_id: number;
  project_name?: string | null;
  /** 人工时是姓名；其他类别存同一个汇总依据值 */
  worker_name: string;
  cost_type?: SettleType;
  cost_type_label?: string;
  /** 汇总依据值（材料=供应商、机械=出租方、杂费=小类、垫付=垫付人） */
  partner?: string;
  total_days: Money;
  amount_due: Money;
  paid_amount: Money;
  unpaid_amount?: Money;
  status: SettleStatus;
  status_label?: string;
  settle_date?: string | null;
  pay_date?: string | null;
  pay_method?: PayMethod | null;
  remark?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface LaborPayPayload {
  amount: Money;
  pay_date: string;
  pay_method?: PayMethod | null;
  remark?: string | null;
}

/* ------------------------------- 字典 ------------------------------- */

export interface DictItem {
  id: number;
  dict_type: DictType;
  name: string;
  sort_no: number;
  enabled: number;
  remark?: string | null;
}

export interface DictPayload {
  dict_type: DictType;
  name: string;
  sort_no?: number;
  enabled?: number;
  remark?: string | null;
}

/* ------------------------------- 变更日志 ------------------------------- */

export interface ChangeLog {
  id: number;
  table_name: string;
  record_id: number;
  action: ChangeAction;
  before_json?: string | null;
  after_json?: string | null;
  operator?: string | null;
  created_at: string;
}

/* ------------------------------- 登录 / 系统 ------------------------------- */

export interface AuthStatus {
  logged_in: boolean;
  security_ready: boolean;
  is_initial_password: boolean;
  initialized?: boolean;
}

export interface LoginResult {
  logged_in: boolean;
  security_ready: boolean;
  is_initial_password: boolean;
}

export interface SecurityQuestionItem {
  question: string;
  answer: string;
}

export interface SecurityQuestions {
  questions: string[];
}

export interface SecurityTicket {
  ticket: string;
  expires_in: number;
}

export interface BackupResult {
  path: string;
  file?: string;
  size?: number;
  created_at?: string;
}
