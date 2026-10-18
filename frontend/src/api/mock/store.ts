/**
 * Mock 内存库 —— 表结构与 docs/02-数据库设计.md 一致，接口契约见 docs/03-接口设计.md。
 * 仅在 VITE_USE_MOCK=true 时被 src/api/mock/index.ts 动态加载，真实请求路径不引用本文件。
 */
import type {
  ArApItem,
  ArApOffset,
  ChangeAction,
  ChangeLog,
  CostItem,
  DictItem,
  FundsFlow,
  InventoryTxn,
  LaborSettle,
  Project,
} from '../../types/domain';
import { addMoney, mulMoney, subMoney, toScaled } from '../../utils/money';

export interface MockSystem {
  password: string;
  initialPassword: boolean;
  securityReady: boolean;
  questions: Array<{ question: string; answer: string }>;
  sessionToken: string | null;
  sessionExpireAt: string | null;
}

export interface MockDB {
  version: number;
  sys: MockSystem;
  seq: Record<string, number>;
  projects: Project[];
  costs: CostItem[];
  funds: FundsFlow[];
  arap: ArApItem[];
  offsets: ArApOffset[];
  invTxns: InventoryTxn[];
  settles: LaborSettle[];
  dicts: DictItem[];
  logs: ChangeLog[];
}

const STORAGE_KEY = 'pims.mock.db.v1';

/* ------------------------------ 工具 ------------------------------ */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeSeq(): Record<string, number> {
  return {};
}

export function nextId(table: string): number {
  db.seq[table] = (db.seq[table] ?? 0) + 1;
  return db.seq[table];
}

export function bumpSeq(table: string, id: number): void {
  db.seq[table] = Math.max(db.seq[table] ?? 0, id);
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function logChange(
  table: string,
  recordId: number,
  action: ChangeAction,
  before: unknown,
  after: unknown,
): void {
  db.logs.push({
    id: nextId('logs'),
    table_name: table,
    record_id: recordId,
    action,
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
    operator: 'boss',
    created_at: nowStamp(),
  });
}

/** 记录一条软删除：置 deleted=1 并写变更日志 */
export function softDelete<T extends { id: number; deleted?: number }>(
  rows: T[],
  id: number,
  table: string,
): T | null {
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const before = clone(row);
  row.deleted = 1;
  logChange(table, id, 'delete', before, clone(row));
  return row;
}

/* ------------------------------ 派生计算 ------------------------------ */

export function aliveCosts(): CostItem[] {
  return db.costs.filter((c) => !c.deleted);
}

export function actualCost(projectId: number, start?: string | null, end?: string | null): number {
  const rows = aliveCosts().filter(
    (c) =>
      c.project_id === projectId &&
      (!start || c.biz_date >= start) &&
      (!end || c.biz_date <= end),
  );
  return addMoney(...rows.map((r) => r.amount));
}

export function costByType(
  projectId: number,
  start?: string | null,
  end?: string | null,
): Record<string, number> {
  const result: Record<string, number> = {};
  aliveCosts()
    .filter(
      (c) =>
        c.project_id === projectId &&
        (!start || c.biz_date >= start) &&
        (!end || c.biz_date <= end),
    )
    .forEach((c) => {
      result[c.type] = addMoney(result[c.type] ?? 0, c.amount);
    });
  return result;
}

/** 余量（千分位整数），用于比较，避免浮点误差 */
export function invScaled(projectId: number, materialName: string, unit: string): number {
  const rows = db.invTxns.filter(
    (t) => !t.deleted && t.project_id === projectId && t.material_name === materialName && t.unit === unit,
  );
  const inQty = rows
    .filter((r) => r.txn_type === 'in')
    .reduce((s, r) => s + toScaled(r.quantity, 3), 0);
  const outQty = rows
    .filter((r) => r.txn_type === 'out')
    .reduce((s, r) => s + toScaled(r.quantity, 3), 0);
  return inQty - outQty;
}

/** 库存余量 ＝ Σ(in 数量) − Σ(out 数量)，按「项目 + 材料 + 单位」 */
export function inventoryBalanceOf(projectId: number, materialName: string, unit: string): number {
  return invScaled(projectId, materialName, unit) / 1000;
}

export function arapUnsettled(item: ArApItem): number {
  return subMoney(item.amount, item.settled_amount);
}

export function recalcArap(item: ArApItem): void {
  const settled = db.offsets
    .filter((o) => o.ar_ap_id === item.id)
    .reduce((sum, o) => addMoney(sum, o.amount), 0);
  item.settled_amount = settled;
  const left = subMoney(item.amount, settled);
  if (toScaled(settled, 2) <= 0) item.status = 'open';
  else if (toScaled(left, 2) <= 0) item.status = 'closed';
  else item.status = 'partial';
  item.unsettled = left;
}

export function withProjectName<T extends { project_id: number }>(row: T): T & { project_name: string | null } {
  const project = db.projects.find((p) => p.id === row.project_id);
  return { ...row, project_name: project ? project.name : null };
}

/* ------------------------------ 持久化 ------------------------------ */

export function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    /* 存储不可用（隐私模式）时忽略，Mock 退化为内存态 */
  }
}

/**
 * 去掉重复的自动应付单（同一 cost_id 只保留最早一张）。
 *
 * 背景：mock 的"录成本 → 自动生成应付单"早期不是幂等的，开发模式下副作用跑两次会
 * 造出**两张 id 不同、cost_id 相同**的应付单。重复单会让"按 id 找单据"的冲销只更新
 * 其中一份（另一份状态永远停在旧值），界面上就出现"已冲销 1500 / 未结 0 / 状态却是未收付"。
 * 这里在载入时兜底清理，保证内存里的单据不重复。
 */
function dedupeAutoPayables(list: ArApItem[]): ArApItem[] {
  const seenCostIds = new Set<number>();
  return list.filter((item) => {
    if (item.type !== 'payable' || item.cost_id === null || item.cost_id === undefined) return true;
    const key = Number(item.cost_id);
    if (seenCostIds.has(key)) return false;
    seenCostIds.add(key);
    return true;
  });
}

function load(): MockDB | null {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as MockDB;
    if (!parsed || parsed.version !== SEED_VERSION) return null;
    // 兜底去重：旧快照里可能残留重复的自动应付单（见 dedupeAutoPayables 注释）
    parsed.arap = dedupeAutoPayables(parsed.arap ?? []);
    return parsed;
  } catch {
    return null;
  }
}

export function resetMockDB(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------ 种子数据 ------------------------------ */

/**
 * 改动种子内容时**必须**把版本号 +1，否则浏览器里旧的 localStorage 快照会继续生效。
 *
 * v4：补上项目1 人工费（cost#1 张三 1500）对应的应付单。
 *     旧快照里还残留"同一笔成本生成两张应付单"的重复数据（开发模式 StrictMode
 *     会让副作用跑两次，而 mock 的 create 当时不是幂等的），旧版本号会让它被丢弃。
 */
const SEED_VERSION = 4;

function seedDicts(): DictItem[] {
  const rows: DictItem[] = [];
  let id = 0;
  const push = (dictType: DictItem['dict_type'], names: string[]) => {
    names.forEach((name, index) => {
      id += 1;
      rows.push({ id, dict_type: dictType, name, sort_no: (index + 1) * 10, enabled: 1, remark: null });
    });
  };
  push('misc_category', ['伙食费', '转运费', '招待费', '罚款', '临时工', '其他']);
  push('unit', ['吨', '车', '方', '袋', '米', '根', '件', '个', '套', '桶']);
  push('material', ['水泥', '砂子', '石子', '钢筋', '模板', '砖', '混凝土', '电缆']);
  push('partner', ['某某置业有限公司', '某某建材', '李老板']);
  return rows;
}

function createEmpty(): MockDB {
  return {
    version: SEED_VERSION,
    sys: {
      password: '123456',
      initialPassword: true,
      securityReady: false,
      questions: [],
      sessionToken: null,
      sessionExpireAt: null,
    },
    seq: makeSeq(),
    projects: [],
    costs: [],
    funds: [],
    arap: [],
    offsets: [],
    invTxns: [],
    settles: [],
    dicts: [],
    logs: [],
  };
}

/**
 * 把示例数据灌进目标库。
 * 注意：参数 `db` 遮蔽了模块级 `db` —— 调用时模块级 db 已完成初始化，
 * 因此 logChange / nextId 里的 db 引用是安全的。
 */
function seedInto(db: MockDB): void {
  const created = '2026-05-01T09:00:00';
  db.dicts = seedDicts();

  /* 项目：验收标准 A3 —— 甲方预算 400 万 / 成本预算 350 万 → 预计利润 50 万 */
  db.projects.push(
    {
      id: 1,
      name: '某小区 5#楼',
      client_name: '某某置业有限公司',
      location: '武汉市洪山区',
      manager: '王工',
      start_date: '2026-03-01',
      status: 'ongoing',
      client_budget: 4000000,
      cost_budget: 3500000,
      members: ['王工', '张三', '李四'],
      remark: '主体结构施工中',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 2,
      name: '市政道路改造',
      client_name: '某某市政公司',
      location: '武汉市江夏区',
      manager: '赵工',
      start_date: '2026-04-15',
      status: 'ongoing',
      client_budget: 1200000,
      cost_budget: 1050000,
      members: ['赵工', '李四', '老周'],
      remark: '',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 3,
      name: '厂房维修（已完工）',
      client_name: '某某制造厂',
      location: '武汉市蔡甸区',
      manager: '王工',
      start_date: '2026-01-10',
      status: 'finished',
      client_budget: 800000,
      cost_budget: 700000,
      members: ['王工', '张三'],
      remark: '已结算完毕，材料余量留在项目上',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
  );

  /* 五类成本：验收标准 A4 —— 实际成本 135.15 万 → 结算利润 264.85 万 */
  const costs: CostItem[] = [
    {
      id: 1,
      project_id: 1,
      type: 'labor',
      amount: 1500,
      biz_date: '2026-05-12',
      partner: '张三',
      remark: '5#楼二层支模',
      worker_name: '张三',
      work_days: 5,
      day_rate: 300,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 2,
      project_id: 1,
      type: 'material',
      amount: 1000000,
      biz_date: '2026-05-10',
      partner: '某某建材',
      remark: '主体结构用水泥',
      material_name: '水泥',
      unit: '吨',
      quantity: 2500,
      unit_price: 400,
      supplier: '某某建材',
      inventory_txn_id: 1,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 3,
      project_id: 1,
      type: 'machine',
      amount: 200000,
      biz_date: '2026-05-11',
      partner: '李老板',
      remark: '基础开挖',
      machine_name: '挖机(小松200)',
      measure: 'shift',
      quantity: 10,
      unit_price: 20000,
      lessor: '李老板',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 4,
      project_id: 1,
      type: 'misc',
      amount: 100000,
      biz_date: '2026-05-13',
      category: '伙食费',
      remark: '5 月工地伙食',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 5,
      project_id: 1,
      type: 'advance',
      amount: 50000,
      biz_date: '2026-05-15',
      partner: '老板',
      remark: '',
      payer: '老板',
      purpose: '临时买料',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    /* 项目 2 —— 验收标准 A5：采购 100 吨、领用 80 吨 → 余量 20 吨 */
    {
      id: 6,
      project_id: 2,
      type: 'labor',
      amount: 3500,
      biz_date: '2026-05-20',
      partner: '李四',
      remark: '路面班组',
      worker_name: '李四',
      work_days: 10,
      day_rate: 350,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 7,
      project_id: 2,
      type: 'material',
      amount: 40000,
      biz_date: '2026-05-18',
      partner: '某某建材',
      remark: '垫层用砂',
      material_name: '砂子',
      unit: '吨',
      quantity: 100,
      unit_price: 400,
      supplier: '某某建材',
      inventory_txn_id: 2,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 8,
      project_id: 2,
      type: 'misc',
      amount: 8000,
      biz_date: '2026-05-22',
      category: '转运费',
      remark: '材料转运',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    /* 项目 3 已完工：无新增成本 */
  ];
  db.costs = costs;

  /* 库存流水 */
  db.invTxns = [
    {
      id: 1,
      project_id: 1,
      material_name: '水泥',
      unit: '吨',
      txn_type: 'in',
      quantity: 2500,
      unit_price: 400,
      supplier: '某某建材',
      cost_id: 2,
      biz_date: '2026-05-10',
      remark: '采购入库（采购即成本）',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 2,
      project_id: 2,
      material_name: '砂子',
      unit: '吨',
      txn_type: 'in',
      quantity: 100,
      unit_price: 400,
      supplier: '某某建材',
      cost_id: 7,
      biz_date: '2026-05-18',
      remark: '采购入库（采购即成本）',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 3,
      project_id: 1,
      material_name: '水泥',
      unit: '吨',
      txn_type: 'out',
      quantity: 800,
      unit_price: null,
      supplier: null,
      cost_id: null,
      biz_date: '2026-05-25',
      remark: '5#楼三层砌筑（领用不减成本）',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 4,
      project_id: 2,
      material_name: '砂子',
      unit: '吨',
      txn_type: 'out',
      quantity: 80,
      unit_price: null,
      supplier: null,
      cost_id: null,
      biz_date: '2026-05-28',
      remark: '垫层摊铺（领用不减成本）',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
  ];

  /* 资金流水：已收 200 万 / 已付 160 万 */
  db.funds = [
    {
      id: 1,
      project_id: 1,
      direction: 'in',
      biz_type: 'progress',
      amount: 1700000,
      biz_date: '2026-04-10',
      partner: '某某置业有限公司',
      pay_method: 'transfer',
      remark: '第一次进度款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 2,
      project_id: 1,
      direction: 'in',
      biz_type: 'progress',
      amount: 300000,
      biz_date: '2026-06-20',
      partner: '某某置业有限公司',
      pay_method: 'transfer',
      remark: '第二次进度款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 3,
      project_id: 1,
      direction: 'out',
      biz_type: 'material',
      amount: 1600000,
      biz_date: '2026-05-15',
      partner: '某某建材',
      pay_method: 'transfer',
      remark: '付材料款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 4,
      project_id: 2,
      direction: 'in',
      biz_type: 'progress',
      amount: 500000,
      biz_date: '2026-05-06',
      partner: '某某市政公司',
      pay_method: 'transfer',
      remark: '预付款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 5,
      project_id: 2,
      direction: 'out',
      biz_type: 'material',
      amount: 40000,
      biz_date: '2026-05-19',
      partner: '某某建材',
      pay_method: 'transfer',
      remark: '付砂子款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
  ];

  /* 应收应付：应收 50 万已冲 30 万 → 未收 20 万；应付未结 70 万 */
  db.arap = [
    {
      id: 1,
      project_id: 1,
      type: 'receivable',
      biz_type: 'progress',
      amount: 500000,
      settled_amount: 300000,
      status: 'partial',
      biz_date: '2026-06-01',
      partner: '某某置业有限公司',
      remark: '第三次进度款',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 2,
      project_id: 1,
      type: 'payable',
      biz_type: 'material',
      amount: 700000,
      settled_amount: 0,
      status: 'open',
      biz_date: '2026-06-05',
      partner: '某某建材',
      remark: '欠付材料款',
      cost_id: 2,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 3,
      project_id: 2,
      type: 'receivable',
      biz_type: 'settle',
      amount: 300000,
      settled_amount: 0,
      status: 'open',
      biz_date: '2026-06-10',
      partner: '某某市政公司',
      remark: '结算款待收',
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    {
      id: 4,
      project_id: 2,
      type: 'payable',
      biz_type: 'material',
      amount: 40000,
      settled_amount: 40000,
      status: 'closed',
      biz_date: '2026-05-18',
      partner: '某某建材',
      remark: '砂子款已付清',
      cost_id: 7,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
    // 项目1 的人工费（cost#1 张三 1500）对应的应付单。
    // 真实后端「录一笔成本 → 自动生成一张应付单」，种子里必须保持同样的不变式，
    // 否则结算页的「欠款总览」会缺这一行（曾经因此让一条测试失败）。
    {
      id: 5,
      project_id: 1,
      type: 'payable',
      biz_type: 'labor',
      amount: 1500,
      settled_amount: 0,
      status: 'open',
      biz_date: '2026-05-12',
      partner: '张三',
      remark: '由记账/成本录入自动生成',
      cost_id: 1,
      deleted: 0,
      created_at: created,
      updated_at: created,
    },
  ];

  db.offsets = [
    {
      id: 1,
      ar_ap_id: 1,
      funds_flow_id: 2,
      amount: 300000,
      offset_date: '2026-06-20',
      remark: '冲第三次进度款',
      created_at: created,
    },
    {
      id: 2,
      ar_ap_id: 4,
      funds_flow_id: 5,
      amount: 40000,
      offset_date: '2026-05-19',
      remark: '付清砂子款',
      created_at: created,
    },
  ];

  /* 人工结算：李四已结算部分发放（结算不新增成本） */
  db.settles = [
    {
      id: 1,
      project_id: 2,
      worker_name: '李四',
      total_days: 10,
      amount_due: 3500,
      paid_amount: 2000,
      status: 'partial',
      settle_date: '2026-06-05',
      pay_date: '2026-06-05',
      pay_method: 'wechat',
      remark: '先发 2000',
      created_at: created,
      updated_at: created,
    },
  ];

  /* seq 与变更日志 */
  db.seq = {
    project: 3,
    cost: 8,
    funds: 5,
    arap: 4,
    offsets: 2,
    invTxns: 4,
    settles: 1,
    dicts: db.dicts.length,
    logs: 0,
  };

  db.projects.forEach((p) => logChange('project', p.id, 'create', null, p));
  db.costs.forEach((c) => logChange('cost', c.id, 'create', null, c));
  db.funds.forEach((f) => logChange('funds_flow', f.id, 'create', null, f));
  db.arap.forEach((a) => logChange('ar_ap', a.id, 'create', null, a));
  db.invTxns.forEach((t) => logChange('inventory_txn', t.id, 'create', null, t));
}

const restored = load();

export const db: MockDB = restored ?? createEmpty();

if (!restored) {
  seedInto(db);
}

/** 计算某项目库存总额（余量 × 最近入库单价），用于项目详情「库存金额」 */
export function inventoryAmount(projectId: number): number {
  const keys = new Map<string, { material_name: string; unit: string }>();
  db.invTxns
    .filter((t) => !t.deleted && t.project_id === projectId)
    .forEach((t) => keys.set(`${t.material_name}|${t.unit}`, { material_name: t.material_name, unit: t.unit }));
  let total = 0;
  keys.forEach(({ material_name, unit }) => {
    const balance = inventoryBalanceOf(projectId, material_name, unit);
    const lastIn = db.invTxns
      .filter(
        (t) =>
          !t.deleted &&
          t.project_id === projectId &&
          t.material_name === material_name &&
          t.unit === unit &&
          t.txn_type === 'in',
      )
      .sort((a, b) => (a.biz_date < b.biz_date ? 1 : -1))[0];
    total = addMoney(total, mulMoney(balance, lastIn?.unit_price ?? 0));
  });
  return total;
}
