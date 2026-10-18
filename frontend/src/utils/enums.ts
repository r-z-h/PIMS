/**
 * 枚举中文label —— 取值严格对齐 docs/02-数据库设计.md「枚举值一览」。
 * 写库用英文，前端显示中文。
 */
import type {
  ArApStatus,
  ArApType,
  ChangeAction,
  CostType,
  DictType,
  FundBizType,
  FundDirection,
  InvTxnType,
  MachineMeasure,
  PayMethod,
  ProjectStatus,
  SettleStatus,
} from '../types/domain';

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  ongoing: '在建',
  finished: '完工',
};

export const COST_TYPE_LABEL: Record<CostType, string> = {
  labor: '人工',
  material: '材料',
  machine: '机械',
  misc: '杂费',
  advance: '垫付',
};

export const COST_TYPES: CostType[] = ['labor', 'material', 'machine', 'misc', 'advance'];

export const DIRECTION_LABEL: Record<FundDirection, string> = {
  in: '收',
  out: '付',
};

export const FUND_BIZ_TYPE_LABEL: Record<FundBizType, string> = {
  progress: '进度款',
  settle: '结算款',
  advance: '预支',
  material: '材料款',
  labor: '人工费',
  machine: '机械费',
  misc: '杂费',
  advance_pay: '垫付',
  other: '其他',
};

/** 收款可用业务类型 */
export const IN_BIZ_TYPES: FundBizType[] = ['progress', 'settle', 'advance', 'other'];
/** 付款可用业务类型 */
export const OUT_BIZ_TYPES: FundBizType[] = [
  'material',
  'labor',
  'machine',
  'misc',
  'advance_pay',
  'other',
];
/** 应收单业务类型 */
export const RECEIVABLE_BIZ_TYPES: FundBizType[] = ['progress', 'settle'];
/** 应付单业务类型 */
export const PAYABLE_BIZ_TYPES: FundBizType[] = [
  'material',
  'labor',
  'machine',
  'misc',
  'advance_pay',
  'other',
];

export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  cash: '现金',
  wechat: '微信',
  bank_card: '银行卡',
  transfer: '转账',
};

export const PAY_METHODS: PayMethod[] = ['cash', 'wechat', 'bank_card', 'transfer'];

export const ARAP_TYPE_LABEL: Record<ArApType, string> = {
  receivable: '应收',
  payable: '应付',
};

export const ARAP_STATUS_LABEL: Record<ArApStatus, string> = {
  open: '未收付',
  partial: '部分',
  closed: '已结清',
};

export const INV_TXN_TYPE_LABEL: Record<InvTxnType, string> = {
  in: '入库',
  out: '领用',
};

export const MEASURE_LABEL: Record<MachineMeasure, string> = {
  shift: '台班',
  hour: '小时',
};

export const SETTLE_STATUS_LABEL: Record<SettleStatus, string> = {
  unpaid: '未发',
  partial: '部分',
  paid: '已发',
};

export const DICT_TYPE_LABEL: Record<DictType, string> = {
  misc_category: '杂费小类',
  material: '材料',
  unit: '单位',
  partner: '对方',
};

export const CHANGE_ACTION_LABEL: Record<ChangeAction, string> = {
  create: '新增',
  update: '修改',
  delete: '删除',
};

export function labelOf<T extends string>(
  map: Record<string, string>,
  value: T | null | undefined,
): string {
  if (!value) return '-';
  return map[value] ?? String(value);
}

/** 通用下拉选项 */
export function toOptions<T extends string>(map: Record<T, string>, keys?: T[]) {
  const list = (keys ?? (Object.keys(map) as T[])) as T[];
  return list.map((k) => ({ value: k, label: map[k] }));
}
