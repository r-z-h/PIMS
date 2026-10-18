/**
 * Mock 接口处理器 —— 路径、字段名、统一响应体、错误码严格对齐 docs/03-接口设计.md。
 * 只在 VITE_USE_MOCK=true 时被加载。
 */
import type {
  ArApItem,
  ArApOffset,
  ArApType,
  CostItem,
  CostType,
  DictType,
  FundsFlow,
  FundBizType,
  FundDirection,
  InventoryTxn,
  LaborSettle,
  MachineMeasure,
  PayMethod,
  Project,
  SettleType,
} from '../../types/domain';
import { addMoney, fmtMoney, mulMoney, subMoney, toScaled } from '../../utils/money';
import {
  actualCost,
  arapUnsettled,
  costByType,
  db,
  invScaled,
  inventoryAmount,
  inventoryBalanceOf,
  logChange,
  nextId,
  nowStamp,
  persist,
  recalcArap,
  softDelete,
  today,
  withProjectName,
} from './store';

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, unknown>;
  body: Record<string, unknown>;
}

export interface MockResult {
  status: number;
  body: unknown;
  /** 文件流标记：body 为 ArrayBuffer，附带 headers */
  file?: { headers: Record<string, string> };
}

/* ------------------------------ 响应助手 ------------------------------ */

const ok = (data: unknown = null): MockResult => ({
  status: 200,
  body: { code: 0, message: 'ok', data },
});

const fail = (code: number, message: string, data: unknown = null): MockResult => ({
  status: code,
  body: { code, message, data },
});

/**
 * 项目完工锁（2026-10-17）：与后端 locks.ensure_mutable 同口径。
 * 已完工且未解锁 → 409 + data.reason='project_locked'，前端据此弹密码框并自动重试。
 */
function ensureMutable(projectId: number): MockResult | null {
  const project = db.projects.find((p) => p.id === projectId && !p.deleted);
  if (!project) return fail(404, '项目不存在');
  if (project.status === 'finished' && !project.unlocked_at) {
    return fail(409, `项目「」已完工并锁定，不能修改。如确需改动，请先输入密码解锁。`, {
      reason: 'project_locked',
      project_id: project.id,
    });
  }
  return null;
}

/* ------------------------------ 取值助手 ------------------------------ */

function pStr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function pNum(value: unknown): number | undefined {
  const text = pStr(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function pBool(value: unknown): boolean {
  const text = pStr(value)?.toLowerCase();
  return text === 'true' || text === '1';
}

function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function nullableText(value: unknown): string | null {
  const t = text(value).trim();
  return t === '' ? null : t;
}

function numOf(value: unknown, fallback: number | string = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number(fallback);
}

function paginate<T>(items: T[], params: Record<string, unknown>) {
  const page = Math.max(1, pNum(params.page) ?? 1);
  const size = Math.min(200, Math.max(1, pNum(params.page_size) ?? 20));
  const start = (page - 1) * size;
  return {
    total: items.length,
    page,
    page_size: size,
    items: items.slice(start, start + size),
  };
}

interface CommonFilter {
  project_id?: number;
  start_date?: string;
  end_date?: string;
  keyword?: string;
  include_deleted?: boolean;
}

function commonFilter(params: Record<string, unknown>): CommonFilter {
  return {
    project_id: pNum(params.project_id),
    start_date: pStr(params.start_date),
    end_date: pStr(params.end_date),
    keyword: pStr(params.keyword),
    include_deleted: pBool(params.include_deleted),
  };
}

function matchCommon(
  row: { project_id?: number; biz_date?: string; deleted?: number },
  filter: CommonFilter,
): boolean {
  if (!filter.include_deleted && row.deleted) return false;
  if (filter.project_id !== undefined && row.project_id !== filter.project_id) return false;
  if (filter.start_date && text(row.biz_date) < filter.start_date) return false;
  if (filter.end_date && text(row.biz_date) > filter.end_date) return false;
  return true;
}

function matchKeyword(keyword: string | undefined, fields: Array<unknown>): boolean {
  if (!keyword) return true;
  const needle = keyword.toLowerCase();
  return fields.some((f) => text(f).toLowerCase().includes(needle));
}

function sortByDateDesc<T extends { biz_date?: string; id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const da = text(a.biz_date);
    const db2 = text(b.biz_date);
    if (da === db2) return b.id - a.id;
    return da < db2 ? 1 : -1;
  });
}

/** 用到即入字典（材料名 / 单位 / 对方名称自动进入候选） */
function ensureDict(dictType: DictType, name: string | null | undefined): void {
  const value = text(name).trim();
  if (!value) return;
  const exists = db.dicts.some((d) => d.dict_type === dictType && d.name === value);
  if (exists) return;
  const id = nextId('dicts');
  db.dicts.push({ id, dict_type: dictType, name: value, sort_no: 900, enabled: 1, remark: '录入自动收录' });
}

function projectName(projectId: number): string | null {
  return db.projects.find((p) => p.id === projectId)?.name ?? null;
}

/* ------------------------------ 认证 ------------------------------ */

const PUBLIC_PATHS = new Set([
  'GET /auth/status',
  'POST /auth/login',
  'GET /auth/security-questions',
  'POST /auth/security/verify',
  'POST /auth/password/reset',
]);

function loggedIn(): boolean {
  const expire = db.sys.sessionExpireAt;
  if (!db.sys.sessionToken) return false;
  if (expire && new Date(expire).getTime() < Date.now()) {
    db.sys.sessionToken = null;
    return false;
  }
  return true;
}

function handleAuth(req: MockRequest): MockResult | null {
  const { method, path, body } = req;

  if (method === 'GET' && path === '/auth/status') {
    return ok({
      logged_in: loggedIn(),
      security_ready: db.sys.securityReady,
      is_initial_password: db.sys.initialPassword,
      initialized: true,
    });
  }

  if (method === 'POST' && path === '/auth/login') {
    const password = text(body.password);
    if (!password) return fail(400, '请输入密码');
    if (password !== db.sys.password) return fail(400, '密码不正确');
    db.sys.sessionToken = `mock_${Date.now().toString(36)}`;
    db.sys.sessionExpireAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    persist();
    return ok({
      logged_in: true,
      security_ready: db.sys.securityReady,
      is_initial_password: db.sys.initialPassword,
    });
  }

  if (method === 'POST' && path === '/auth/logout') {
    db.sys.sessionToken = null;
    db.sys.sessionExpireAt = null;
    persist();
    return ok({ logged_in: false });
  }

  if (method === 'GET' && path === '/auth/security-questions') {
    return ok({ questions: db.sys.questions.map((q) => q.question) });
  }

  if (method === 'POST' && path === '/auth/security/verify') {
    if (!db.sys.securityReady) return fail(400, '尚未设置密保问题');
    const answers = Array.isArray(body.answers) ? body.answers.map((a) => text(a).trim()) : [];
    if (answers.length !== db.sys.questions.length) return fail(403, '密保答案不正确');
    const allRight = db.sys.questions.every((q, i) => q.answer === answers[i]);
    if (!allRight) return fail(403, '密保答案不正确');
    return ok({ ticket: `rst_${Date.now().toString(36)}`, expires_in: 300 });
  }

  if (method === 'POST' && path === '/auth/security/setup') {
    if (!loggedIn()) return fail(401, '未登录或会话已过期');
    const list = Array.isArray(body.questions) ? body.questions : [];
    if (list.length !== 3) return fail(400, '必须填写 3 组密保问题与答案');
    const parsed = list.map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return { question: text(row.question).trim(), answer: text(row.answer).trim() };
    });
    if (parsed.some((p) => !p.question || !p.answer)) return fail(400, '密保问题与答案均为必填');
    db.sys.questions = parsed;
    db.sys.securityReady = true;
    persist();
    return ok({ security_ready: true });
  }

  if (method === 'POST' && path === '/auth/password/change') {
    if (!loggedIn()) return fail(401, '未登录或会话已过期');
    const newPassword = text(body.new_password);
    if (newPassword.length < 6) return fail(400, '新密码至少 6 位');
    // 口径（00-需求冻结 FR-1.3）：必须 3 个密保问题全部答对才允许修改，无其他后门
    const answers = Array.isArray(body.answers) ? body.answers.map((a) => text(a).trim()) : [];
    if (
      !db.sys.securityReady ||
      answers.length !== db.sys.questions.length ||
      !db.sys.questions.every((q, i) => q.answer === answers[i])
    ) {
      return fail(403, '密保答案不正确');
    }
    db.sys.password = newPassword;
    db.sys.initialPassword = false;
    persist();
    return ok({ changed: true });
  }

  if (method === 'POST' && path === '/auth/password/reset') {
    if (!db.sys.securityReady) return fail(400, '尚未设置密保问题');
    const ticket = text(body.ticket);
    const newPassword = text(body.new_password);
    if (!ticket.startsWith('rst_')) return fail(403, '密保校验已失效，请重新验证');
    if (newPassword.length < 6) return fail(400, '新密码至少 6 位');
    db.sys.password = newPassword;
    db.sys.initialPassword = false;
    persist();
    return ok({ reset: true });
  }

  return null;
}

/* ------------------------------ 系统 ------------------------------ */

function handleSystem(req: MockRequest): MockResult | null {
  if (req.method === 'POST' && req.path === '/system/backup') {
    const stamp = today().replace(/-/g, '');
    const path = `backend\\data\\backup\\pims-${stamp}.db`;
    return ok({ path, file: `pims-${stamp}.db`, size: 286720, created_at: nowStamp() });
  }
  return null;
}

/* ------------------------------ 字典 ------------------------------ */

function handleDict(req: MockRequest): MockResult | null {
  const { method, path, body } = req;

  const listMatch = /^\/dict\/([a-z_]+)$/.exec(path);
  if (method === 'GET' && listMatch) {
    const dictType = listMatch[1] as DictType;
    const items = db.dicts
      .filter((d) => d.dict_type === dictType)
      .sort((a, b) => a.sort_no - b.sort_no || a.id - b.id);
    return ok(items);
  }

  if (method === 'POST' && path === '/dict') {
    const dictType = text(body.dict_type) as DictType;
    const name = text(body.name).trim();
    if (!dictType) return fail(400, '缺少 dict_type');
    if (!name) return fail(400, '名称必填');
    if (db.dicts.some((d) => d.dict_type === dictType && d.name === name)) {
      return fail(409, '该名称已存在');
    }
    const row = {
      id: nextId('dicts'),
      dict_type: dictType,
      name,
      sort_no: numOf(body.sort_no, 900),
      enabled: numOf(body.enabled, 1),
      remark: nullableText(body.remark),
    };
    db.dicts.push(row);
    persist();
    return ok(row);
  }

  const idMatch = /^\/dict\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.dicts.find((d) => d.id === id);
    if (!row) return fail(404, '字典项不存在');
    if (method === 'PUT') {
      if (body.name !== undefined) row.name = text(body.name).trim();
      if (body.sort_no !== undefined) row.sort_no = numOf(body.sort_no, row.sort_no);
      if (body.enabled !== undefined) row.enabled = numOf(body.enabled, row.enabled);
      if (body.remark !== undefined) row.remark = nullableText(body.remark);
      persist();
      return ok(row);
    }
    if (method === 'DELETE') {
      // 已使用的名称仅置 enabled=0，不物理删除
      const used =
        db.costs.some((c) => c.category === row.name || c.material_name === row.name || c.unit === row.name) ||
        db.invTxns.some((t) => t.material_name === row.name || t.unit === row.name) ||
        db.funds.some((f) => f.partner === row.name) ||
        db.arap.some((a) => a.partner === row.name);
      if (used) {
        row.enabled = 0;
        persist();
        return ok({ id, enabled: 0, deleted: false });
      }
      db.dicts = db.dicts.filter((d) => d.id !== id);
      persist();
      return ok({ id, deleted: true });
    }
  }

  return null;
}

/* ------------------------------ 项目 ------------------------------ */

function projectMetrics(project: Project, start?: string | null, end?: string | null) {
  const actual = actualCost(project.id, start, end);
  const clientBudget = project.client_budget;
  const costBudget = project.cost_budget;
  const expectProfit = subMoney(clientBudget, costBudget);
  const settleProfit = subMoney(clientBudget, actual);
  const budgetLeft = subMoney(costBudget, actual);
  const budgetUsageRate =
    toScaled(costBudget, 2) > 0 ? (toScaled(actual, 2) / toScaled(costBudget, 2)) * 100 : 0;
  return {
    expect_profit: expectProfit,
    actual_cost: actual,
    settle_profit: settleProfit,
    budget_left: budgetLeft,
    budget_usage_rate: Math.round(budgetUsageRate * 100) / 100,
  };
}

function arApUnsettledOf(projectId: number, type: 'receivable' | 'payable', filter?: CommonFilter) {
  const rows = db.arap.filter(
    (a) =>
      !a.deleted &&
      a.project_id === projectId &&
      a.type === type &&
      a.status !== 'closed' &&
      (!filter || matchCommon(a, filter)),
  );
  return addMoney(...rows.map((r) => arapUnsettled(r)));
}

function fundsTotal(projectId: number, direction: FundDirection, filter?: CommonFilter) {
  const rows = db.funds.filter(
    (f) =>
      !f.deleted && f.project_id === projectId && f.direction === direction && (!filter || matchCommon(f, filter)),
  );
  return addMoney(...rows.map((r) => r.amount));
}

function overviewOf(project: Project, start?: string | null, end?: string | null) {
  const filter: CommonFilter = { start_date: start ?? undefined, end_date: end ?? undefined };
  const byType = costByType(project.id, start, end);
  return {
    project: normalizeProject(project),
    metrics: projectMetrics(project, start, end),
    cost_by_type: {
      labor: byType.labor ?? 0,
      material: byType.material ?? 0,
      machine: byType.machine ?? 0,
      misc: byType.misc ?? 0,
      advance: byType.advance ?? 0,
    },
    ar_ap: {
      receivable_unsettled: arApUnsettledOf(project.id, 'receivable', filter),
      payable_unsettled: arApUnsettledOf(project.id, 'payable', filter),
    },
    funds: {
      total_in: fundsTotal(project.id, 'in', filter),
      total_out: fundsTotal(project.id, 'out', filter),
    },
    inventory_amount: inventoryAmount(project.id),
  };
}

function normalizeProject(project: Project): Project {
  let members: string[] = [];
  if (Array.isArray(project.members)) members = project.members;
  else if (typeof project.members === 'string' && project.members.trim()) {
    try {
      const parsed = JSON.parse(project.members) as unknown;
      members = Array.isArray(parsed) ? parsed.map((m) => text(m)) : text(project.members).split(/[,，]/);
    } catch {
      members = text(project.members).split(/[,，]/);
    }
  }
  return {
    ...project,
    members,
    is_finished: project.status === 'finished',
    is_locked: project.status === 'finished' && !project.unlocked_at,
  };
}

/**
 * 按日期筛项目（2026-10-17 需求）：与后端 `date_field` 同口径。
 *   start_date = 开工日期落在区间内
 *   activity   = 区间内有成本/收付款/往来/入库/结算
 */
function filterByDateField<T extends { id: number; start_date?: string | null }>(
  rows: T[],
  dateField: string | undefined,
  start?: string,
  end?: string,
): T[] {
  if (!dateField || (!start && !end)) return rows;
  if (dateField === 'start_date') {
    return rows.filter((p) => {
      const d = p.start_date;
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }
  if (dateField === 'activity') {
    const active = new Set<number>();
    const hit = (date: string | null | undefined) => {
      if (!date) return false;
      if (start && date < start) return false;
      if (end && date > end) return false;
      return true;
    };
    db.costs.forEach((c) => {
      if (!c.deleted && hit(c.biz_date)) active.add(c.project_id);
    });
    db.funds.forEach((f) => {
      if (!f.deleted && hit(f.biz_date)) active.add(f.project_id);
    });
    db.arap.forEach((a) => {
      if (!a.deleted && hit(a.biz_date)) active.add(a.project_id);
    });
    db.invTxns.forEach((t) => {
      if (!t.deleted && hit(t.biz_date)) active.add(t.project_id);
    });
    db.settles.forEach((s) => {
      if (hit(s.settle_date)) active.add(s.project_id);
    });
    // 刚建的项目也算"有业务数据"（与后端一致）：否则新建项目在录第一笔前会被筛没
    rows.forEach((p) => {
      const created = (p as { created_at?: string }).created_at;
      if (created && hit(created.slice(0, 10))) active.add(p.id);
    });
    return rows.filter((p) => active.has(p.id));
  }
  return rows;
}

function handleProjects(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  if (method === 'GET' && path === '/projects') {
    const filter = commonFilter(params);
    const status = pStr(params.status);
    // 注意：**不能**把日期交给 matchCommon —— 它按 biz_date 过滤，而项目没有这个字段，
    // 会把所有项目都判成"不在区间内"。日期筛选走下面对 filterByDateField 的调用。
    let rows = db.projects.filter((p) =>
      matchCommon(p, { ...filter, start_date: undefined, end_date: undefined }),
    );
    if (status) rows = rows.filter((p) => p.status === status);
    rows = rows.filter((p) => matchKeyword(filter.keyword, [p.name, p.client_name, p.manager, p.location]));
    // 日期筛项目（2026-10-17 需求）：与后端 project_service.list_projects 同口径
    rows = filterByDateField(rows, pStr(params.date_field), filter.start_date, filter.end_date);
    rows = rows.sort((a, b) => b.id - a.id);
    return ok(paginate(rows.map(normalizeProject), params));
  }

  if (method === 'POST' && path === '/projects') {
    const name = text(body.name).trim();
    if (!name) return fail(400, '项目名称必填');
    const clientBudget = numOf(body.client_budget, 0);
    const costBudget = numOf(body.cost_budget, 0);
    if (clientBudget < 0 || costBudget < 0) return fail(400, '预算不能为负数');
    const row: Project = {
      id: nextId('project'),
      name,
      client_name: nullableText(body.client_name),
      location: nullableText(body.location),
      manager: nullableText(body.manager),
      start_date: pStr(body.start_date) ?? null,
      status: text(body.status, 'ongoing') === 'finished' ? 'finished' : 'ongoing',
      client_budget: clientBudget,
      cost_budget: costBudget,
      members: Array.isArray(body.members) ? body.members.map((m) => text(m)) : [],
      remark: nullableText(body.remark),
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.projects.push(row);
    logChange('project', row.id, 'create', null, row);
    persist();
    return ok(normalizeProject(row));
  }

  const overviewMatch = /^\/projects\/(\d+)\/overview$/.exec(path);
  if (method === 'GET' && overviewMatch) {
    const project = db.projects.find((p) => p.id === Number(overviewMatch[1]) && !p.deleted);
    if (!project) return fail(404, '项目不存在');
    return ok(overviewOf(project, pStr(params.start_date), pStr(params.end_date)));
  }

  /* 完工锁（2026-10-17）：完工 / 撤销完工 / 解锁 / 重新锁定 */
  const lockMatch = /^\/projects\/(\d+)\/(finish|reopen|unlock|lock)$/.exec(path);
  if (method === 'POST' && lockMatch) {
    const pid = Number(lockMatch[1]);
    const action = lockMatch[2];
    const project = db.projects.find((p) => p.id === pid && !p.deleted);
    if (!project) return fail(404, '项目不存在');
    const before = JSON.parse(JSON.stringify(project)) as Project;

    if (action === 'finish') {
      if (project.status === 'finished') return fail(400, '该项目已经是完工状态');
      project.status = 'finished';
      project.unlocked_at = null;
    } else if (action === 'reopen') {
      if (project.status !== 'finished') return fail(400, '该项目不是完工状态');
      if (text(body.password) !== text(db.sys.password)) return fail(400, '密码不正确');
      project.status = 'ongoing';
      project.unlocked_at = null;
    } else if (action === 'unlock') {
      if (project.status !== 'finished') return fail(400, '只有已完工的项目需要解锁');
      if (text(body.password) !== text(db.sys.password)) return fail(400, '密码不正确');
      project.unlocked_at = nowStamp();
    } else {
      if (project.status !== 'finished') return fail(400, '只有已完工的项目需要锁定');
      project.unlocked_at = null;
    }

    project.updated_at = nowStamp();
    logChange('project', project.id, 'update', before, project);
    persist();
    return ok(normalizeProject(project));
  }

  const idMatch = /^\/projects\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const project = db.projects.find((p) => p.id === id);
    if (!project || (project.deleted && method !== 'GET')) return fail(404, '项目不存在');

    if (method === 'GET') {
      const start = pStr(params.start_date);
      const end = pStr(params.end_date);
      // 与真实后端一致：**嵌套（project/metrics/...）+ 扁平（id/name/status/...）**两种都在。
      // 前端「项目详情」按嵌套取数；早期脚本/用例按扁平取数。
      return ok({ ...overviewOf(project, start, end), ...normalizeProject(project) });
    }

    if (method === 'PUT') {
      const locked = ensureMutable(id);
      if (locked) return locked;
      const before = JSON.parse(JSON.stringify(project)) as Project;
      if (body.name !== undefined) {
        const name = text(body.name).trim();
        if (!name) return fail(400, '项目名称必填');
        project.name = name;
      }
      if (body.client_name !== undefined) project.client_name = nullableText(body.client_name);
      if (body.location !== undefined) project.location = nullableText(body.location);
      if (body.manager !== undefined) project.manager = nullableText(body.manager);
      if (body.start_date !== undefined) project.start_date = pStr(body.start_date) ?? null;
      if (body.status !== undefined) project.status = text(body.status) === 'finished' ? 'finished' : 'ongoing';
      if (body.client_budget !== undefined) project.client_budget = numOf(body.client_budget, 0);
      if (body.cost_budget !== undefined) project.cost_budget = numOf(body.cost_budget, 0);
      if (body.members !== undefined) {
        project.members = Array.isArray(body.members) ? body.members.map((m) => text(m)) : [];
      }
      if (body.remark !== undefined) project.remark = nullableText(body.remark);
      project.updated_at = nowStamp();
      logChange('project', project.id, 'update', before, project);
      persist();
      return ok(normalizeProject(project));
    }

    if (method === 'DELETE') {
      const locked = ensureMutable(id);
      if (locked) return locked;
      const force = pBool(params.force);
      const hasData =
        db.costs.some((c) => c.project_id === id && !c.deleted) ||
        db.funds.some((f) => f.project_id === id && !f.deleted);
      if (hasData && !force) {
        return fail(409, '该项目下已有成本或流水，继续删除请加 force=true');
      }
      softDelete(db.projects, id, 'project');
      persist();
      return ok({ id, deleted: true });
    }
  }

  return null;
}

/* ------------------------------ 资金流水 ------------------------------ */

const FUND_BIZ_TYPES: FundBizType[] = [
  'progress',
  'settle',
  'advance',
  'material',
  'labor',
  'machine',
  'misc',
  'advance_pay',
  'other',
];

const FUND_BIZ_TYPE_LABEL: Record<string, string> = {
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

function handleFunds(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  if (method === 'GET' && path === '/funds/summary') {
    const filter = commonFilter(params);
    const dir = pStr(params.direction);
    let rows = db.funds.filter((f) => matchCommon(f, filter));
    // 与真实后端一致：传了 direction 就只统计该方向（另一方向归零）
    if (dir) rows = rows.filter((f) => f.direction === dir);
    const projectIds = new Set(rows.map((r) => r.project_id));
    const byProject = Array.from(projectIds)
      .sort((a, b) => a - b)
      .map((projectId) => {
        const totalIn = addMoney(
          ...rows.filter((r) => r.project_id === projectId && r.direction === 'in').map((r) => r.amount),
        );
        const totalOut = addMoney(
          ...rows.filter((r) => r.project_id === projectId && r.direction === 'out').map((r) => r.amount),
        );
        return { project_id: projectId, total_in: totalIn, total_out: totalOut, net: subMoney(totalIn, totalOut) };
      });
    const totalIn = addMoney(...rows.filter((r) => r.direction === 'in').map((r) => r.amount));
    const totalOut = addMoney(...rows.filter((r) => r.direction === 'out').map((r) => r.amount));
    return ok({ total_in: totalIn, total_out: totalOut, net: subMoney(totalIn, totalOut), by_project: byProject });
  }

  if (method === 'GET' && path === '/funds') {
    const filter = commonFilter(params);
    const direction = pStr(params.direction);
    const bizType = pStr(params.biz_type);
    const payMethod = pStr(params.pay_method);
    let rows = db.funds.filter((f) => matchCommon(f, filter));
    if (direction) rows = rows.filter((f) => f.direction === direction);
    if (bizType) rows = rows.filter((f) => f.biz_type === bizType);
    if (payMethod) rows = rows.filter((f) => f.pay_method === payMethod);
    rows = rows.filter((f) => matchKeyword(filter.keyword, [f.partner, f.remark]));
    return ok(paginate(sortByDateDesc(rows).map(withProjectName), params));
  }

  if (method === 'POST' && path === '/funds') {
    const projectId = pNum(body.project_id);
    if (!projectId) return fail(400, '请选择项目');
    const lockedFunds = ensureMutable(projectId);
    if (lockedFunds) return lockedFunds;
    if (!db.projects.some((p) => p.id === projectId && !p.deleted)) return fail(404, '项目不存在');
    const direction = text(body.direction) as FundDirection;
    if (direction !== 'in' && direction !== 'out') return fail(400, '收付方向不合法');
    const bizType = text(body.biz_type) as FundBizType;
    if (!FUND_BIZ_TYPES.includes(bizType)) return fail(400, '业务类型不合法');
    const amount = numOf(body.amount, 0);
    if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
    const bizDate = pStr(body.biz_date);
    if (!bizDate) return fail(400, '日期必填');
    const row: FundsFlow = {
      id: nextId('funds'),
      project_id: projectId,
      direction,
      biz_type: bizType,
      amount,
      biz_date: bizDate,
      partner: nullableText(body.partner),
      pay_method: (pStr(body.pay_method) as PayMethod | undefined) ?? null,
      remark: nullableText(body.remark),
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.funds.push(row);
    ensureDict('partner', row.partner);
    logChange('funds_flow', row.id, 'create', null, row);
    persist();
    return ok(withProjectName(row));
  }

  const idMatch = /^\/funds\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.funds.find((f) => f.id === id);
    if (!row) return fail(404, '流水不存在');

    if (method === 'GET') {
      const offsets = db.offsets
        .filter((o) => o.funds_flow_id === id)
        .map((o) => ({ ...o, biz_type: db.arap.find((a) => a.id === o.ar_ap_id)?.biz_type ?? null }));
      return ok({ ...withProjectName(row), offsets });
    }

    if (method === 'PUT') {
      const before = JSON.parse(JSON.stringify(row)) as FundsFlow;
      if (body.project_id !== undefined) row.project_id = numOf(body.project_id, row.project_id);
      if (body.direction !== undefined) row.direction = text(body.direction) as FundDirection;
      if (body.biz_type !== undefined) row.biz_type = text(body.biz_type) as FundBizType;
      if (body.amount !== undefined) {
        const amount = numOf(body.amount, 0);
        if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
        row.amount = amount;
      }
      if (body.biz_date !== undefined) row.biz_date = pStr(body.biz_date) ?? row.biz_date;
      if (body.partner !== undefined) row.partner = nullableText(body.partner);
      if (body.pay_method !== undefined) row.pay_method = (pStr(body.pay_method) as PayMethod) ?? null;
      if (body.remark !== undefined) row.remark = nullableText(body.remark);
      row.updated_at = nowStamp();
      logChange('funds_flow', row.id, 'update', before, row);
      persist();
      return ok(withProjectName(row));
    }

    if (method === 'DELETE') {
      if (db.offsets.some((o) => o.funds_flow_id === id)) {
        return fail(409, '该流水已产生冲销记录，请先撤销冲销');
      }
      softDelete(db.funds, id, 'funds_flow');
      persist();
      return ok({ id, deleted: true });
    }
  }

  return null;
}

/* ------------------------------ 应收应付与冲销 ------------------------------ */

/**
 * 列表/详情返回的单据：**状态也按冲销记录现算**。
 *
 * 原来只现算 `settled_amount / unsettled`，`status` 直接沿用库里存的值 ——
 * 一旦存的状态没跟上（例如冲销更新落在了另一份对象上），界面就会出现
 * 「已冲销 1500 / 未结 0.00 / 状态却是未收付」这种自相矛盾的行。
 * 真实后端由 `arap_service` 在读写时统一重算，这里与之对齐。
 */
function arapWithDerived(row: ArApItem): ArApItem {
  const settled = addMoney(...db.offsets.filter((o) => o.ar_ap_id === row.id).map((o) => o.amount));
  const left = subMoney(row.amount, settled);
  const status: ArApItem['status'] =
    toScaled(settled, 2) <= 0 ? 'open' : toScaled(left, 2) <= 0 ? 'closed' : 'partial';
  return { ...withProjectName(row), settled_amount: settled, unsettled: left, status };
}

/** 自动冲销计划（需求 T4）：同项目、同业务类型、日期最早优先；只算不写 */
function mockAutoOffsetPlan(fundsFlowId: number): MockResult {
  const flow = db.funds.find((f) => f.id === fundsFlowId && !f.deleted);
  if (!flow) return fail(404, '对应的收款/付款流水不存在');
  const arapType: ArApType = flow.direction === 'in' ? 'receivable' : 'payable';
  const flowAmount = Number(flow.amount ?? 0);
  const already = addMoney(...db.offsets.filter((o) => o.funds_flow_id === flow.id).map((o) => o.amount));
  const available = subMoney(flowAmount, already);

  const base: Record<string, unknown> = {
    funds_flow_id: flow.id,
    direction: flow.direction,
    arap_type: arapType,
    flow_amount: flowAmount,
    already_offset: already,
    available: toScaled(available, 2) > 0 ? available : 0,
    plan: [],
    plan_total: 0,
    remaining: toScaled(available, 2) > 0 ? available : 0,
    has_candidate: false,
    message: '',
  };
  if (toScaled(available, 2) <= 0) {
    base.remaining = 0;
    base.message = '这笔流水的金额已全部用于冲销，没有可再冲的额度。';
    return ok(base);
  }

  const all = db.arap
    .filter(
      (a) =>
        !a.deleted &&
        a.project_id === flow.project_id &&
        a.type === arapType &&
        a.status !== 'closed' &&
        toScaled(arapUnsettled(a), 2) > 0,
    )
    .sort((a, b) => (a.biz_date === b.biz_date ? a.id - b.id : a.biz_date < b.biz_date ? -1 : 1));
  // 候选筛选优先级（与后端 offset_service.auto_offset_plan 同口径）：
  //   ① 对方一致 + 业务类型一致（"我付给李四的钱先冲李四的欠款"）
  //   ② 业务类型一致 ③ 全部未结
  const typed = all.filter((a) => a.biz_type === flow.biz_type);
  const flowPartner = text(flow.partner).trim();
  const samePartner = typed.filter((a) => text(a.partner).trim() === flowPartner);
  const candidates = flowPartner && samePartner.length > 0 ? samePartner : typed.length > 0 ? typed : all;

  let left = available;
  const plan: Array<Record<string, unknown>> = [];
  candidates.forEach((a) => {
    if (toScaled(left, 2) <= 0) return;
    const unsettled = arapUnsettled(a);
    const take = toScaled(unsettled, 2) <= toScaled(left, 2) ? unsettled : left;
    plan.push({
      ar_ap_id: a.id,
      biz_date: a.biz_date,
      biz_type: a.biz_type,
      biz_type_label: FUND_BIZ_TYPE_LABEL[a.biz_type] ?? a.biz_type,
      partner: a.partner ?? null,
      amount: a.amount,
      unsettled,
      amount_to_offset: take,
    });
    left = subMoney(left, take);
  });

  const planTotal = addMoney(...plan.map((p) => Number(p.amount_to_offset)));
  base.plan = plan;
  base.plan_total = planTotal;
  base.remaining = left;
  base.has_candidate = plan.length > 0;
  const label = arapType === 'receivable' ? '应收单' : '应付单';
  if (plan.length === 0) {
    base.message = `本次未找到可冲销的${label}（同一项目下没有未结单据），付款已正常记录。`;
  } else if (toScaled(left, 2) > 0) {
    base.message = `按「同项目、同业务类型、日期最早优先」自动冲销 ${plan.length} 张单，合计 ${fmtMoney(
      planTotal,
    )}；剩余 ${fmtMoney(left)} 留在本笔流水上作为可冲余额。`;
  } else {
    base.message = `按「同项目、同业务类型、日期最早优先」自动冲销 ${plan.length} 张单，合计 ${fmtMoney(planTotal)}。`;
  }
  return ok(base);
}

function handleArAp(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  if (method === 'GET' && path === '/arap/summary') {
    const filter = commonFilter(params);
    const rows = db.arap.filter((a) => matchCommon(a, filter) && a.status !== 'closed');
    return ok({
      receivable_unsettled: addMoney(
        ...rows.filter((r) => r.type === 'receivable').map((r) => arapUnsettled(r)),
      ),
      payable_unsettled: addMoney(...rows.filter((r) => r.type === 'payable').map((r) => arapUnsettled(r))),
    });
  }

  if (method === 'GET' && path === '/arap/pending') {
    const projectId = pNum(params.project_id);
    const type = pStr(params.type);
    if (!projectId) return fail(400, 'project_id 必填');
    if (type !== 'receivable' && type !== 'payable') return fail(400, 'type 必须是 receivable 或 payable');
    const rows = db.arap
      .filter((a) => !a.deleted && a.project_id === projectId && a.type === type && a.status !== 'closed')
      .sort((a, b) => (a.biz_date === b.biz_date ? a.id - b.id : a.biz_date < b.biz_date ? -1 : 1));
    return ok(rows.map(arapWithDerived));
  }

  /* ---------- 自动冲销计划（需求 T4，与后端 offset_service.auto_offset_plan 同口径） ---------- */

  const planMatch = path === '/arap/auto-offset/plan';
  if (method === 'GET' && planMatch) {
    const flowId = pNum(params.funds_flow_id);
    if (!flowId) return fail(400, 'funds_flow_id 必填');
    return mockAutoOffsetPlan(flowId);
  }
  if (method === 'POST' && path === '/arap/auto-offset/apply') {
    const flowId = pNum(params.funds_flow_id);
    if (!flowId) return fail(400, 'funds_flow_id 必填');
    const plan = mockAutoOffsetPlan(flowId);
    if (plan.status !== 200) return plan;
    const data = (plan.body as { data: Record<string, unknown> }).data;
    const list = data.plan as Array<Record<string, unknown>>;
    if (list.length === 0) {
      return ok({ ...data, applied: false, offset_ids: [], result_message: data.message });
    }
    // 直接落库（等价于后端的 auto_offset_apply）
    const flow = db.funds.find((f) => f.id === flowId);
    const createdIds: number[] = [];
    list.forEach((item) => {
      const target = db.arap.find((a) => a.id === Number(item.ar_ap_id));
      if (!target) return;
      const offset: ArApOffset = {
        id: nextId('offsets'),
        ar_ap_id: target.id,
        funds_flow_id: flowId,
        amount: Number(item.amount_to_offset),
        offset_date: flow?.biz_date ?? today(),
        remark: '自动冲销',
        created_at: nowStamp(),
      };
      db.offsets.push(offset);
      createdIds.push(offset.id);
      const before = JSON.parse(JSON.stringify(target)) as ArApItem;
      recalcArap(target);
      logChange('ar_ap', target.id, 'update', before, target);
    });
    persist();
    return ok({ ...data, applied: true, offset_ids: createdIds });
  }

  if (method === 'POST' && path === '/arap/offset') {
    const fundsFlowId = pNum(body.funds_flow_id);
    const flow = db.funds.find((f) => f.id === fundsFlowId && !f.deleted);
    if (!flow) return fail(404, '对应的收款/付款流水不存在');
    const lockedOffset = ensureMutable(flow.project_id);
    if (lockedOffset) return lockedOffset;
    const offsets = Array.isArray(body.offsets) ? body.offsets : [];
    if (offsets.length === 0) return fail(400, '请至少勾选一张待结单据');
    const offsetDate = pStr(body.offset_date) ?? flow.biz_date;
    let total = 0;
    const parsed = offsets.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const arApId = numOf(item.ar_ap_id, 0);
      const amount = numOf(item.amount, 0);
      return { ar_ap_id: arApId, amount };
    });
    for (const item of parsed) {
      const target = db.arap.find((a) => a.id === item.ar_ap_id && !a.deleted);
      if (!target) return fail(404, `单据 ${item.ar_ap_id} 不存在`);
      if (target.project_id !== flow.project_id) return fail(400, '单据与收付款流水不属于同一项目');
      if (toScaled(item.amount, 2) <= 0) return fail(400, '冲销金额必须大于 0');
      const left = arapUnsettled(target);
      if (toScaled(item.amount, 2) > toScaled(left, 2)) {
        return fail(400, `单据 ${target.id} 本次冲销金额超过未结金额`);
      }
      total = addMoney(total, item.amount);
    }
    if (toScaled(total, 2) > toScaled(flow.amount, 2)) {
      return fail(400, '冲销合计不得超过本次收付金额');
    }
    const created: ArApOffset[] = [];
    parsed.forEach((item) => {
      const row: ArApOffset = {
        id: nextId('offsets'),
        ar_ap_id: item.ar_ap_id,
        funds_flow_id: flow.id,
        amount: item.amount,
        offset_date: offsetDate,
        remark: nullableText(body.remark),
        created_at: nowStamp(),
      };
      db.offsets.push(row);
      const target = db.arap.find((a) => a.id === item.ar_ap_id);
      if (target) {
        const before = JSON.parse(JSON.stringify(target)) as ArApItem;
        recalcArap(target);
        logChange('ar_ap', target.id, 'update', before, target);
      }
      created.push(row);
    });
    persist();
    return ok({ offsets: created, total_offset: total });
  }

  const offsetIdMatch = /^\/arap\/offset\/(\d+)$/.exec(path);
  if (method === 'DELETE' && offsetIdMatch) {
    const id = Number(offsetIdMatch[1]);
    const row = db.offsets.find((o) => o.id === id);
    if (!row) return fail(404, '冲销记录不存在');
    db.offsets = db.offsets.filter((o) => o.id !== id);
    const target = db.arap.find((a) => a.id === row.ar_ap_id);
    if (target) {
      const before = JSON.parse(JSON.stringify(target)) as ArApItem;
      recalcArap(target);
      logChange('ar_ap', target.id, 'update', before, target);
    }
    persist();
    return ok({ id, revoked: true });
  }

  if (method === 'GET' && path === '/arap') {
    const filter = commonFilter(params);
    const type = pStr(params.type);
    const status = pStr(params.status);
    let rows = db.arap.filter((a) => matchCommon(a, filter));
    if (type) rows = rows.filter((a) => a.type === type);
    if (status) rows = rows.filter((a) => a.status === status);
    rows = rows.filter((a) => matchKeyword(filter.keyword, [a.partner, a.remark]));
    return ok(paginate(sortByDateDesc(rows.map(arapWithDerived)), params));
  }

  if (method === 'POST' && path === '/arap') {
    const projectId = pNum(body.project_id);
    if (!projectId) return fail(400, '请选择项目');
    const lockedArap = ensureMutable(projectId);
    if (lockedArap) return lockedArap;
    if (!db.projects.some((p) => p.id === projectId && !p.deleted)) return fail(404, '项目不存在');
    const type = text(body.type);
    if (type !== 'receivable' && type !== 'payable') return fail(400, 'type 必须是 receivable 或 payable');
    const bizType = text(body.biz_type) as FundBizType;
    if (!FUND_BIZ_TYPES.includes(bizType)) return fail(400, '业务类型不合法');
    if (type === 'receivable' && !['progress', 'settle'].includes(bizType)) {
      return fail(400, '应收单业务类型只能是进度款或结算款');
    }
    const amount = numOf(body.amount, 0);
    if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
    const bizDate = pStr(body.biz_date);
    if (!bizDate) return fail(400, '日期必填');
    const row: ArApItem = {
      id: nextId('arap'),
      project_id: projectId,
      type,
      biz_type: bizType,
      amount,
      settled_amount: 0,
      status: 'open',
      biz_date: bizDate,
      partner: nullableText(body.partner),
      cost_id: pNum(body.cost_id) ?? null,
      remark: nullableText(body.remark),
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.arap.push(row);
    ensureDict('partner', row.partner);
    logChange('ar_ap', row.id, 'create', null, row);
    persist();
    return ok(arapWithDerived(row));
  }

  const idMatch = /^\/arap\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.arap.find((a) => a.id === id);
    if (!row) return fail(404, '单据不存在');

    if (method === 'GET') {
      const offsets = db.offsets
        .filter((o) => o.ar_ap_id === id)
        .map((o) => {
          const flow = db.funds.find((f) => f.id === o.funds_flow_id);
          return {
            ...o,
            funds_biz_date: flow?.biz_date ?? null,
            partner: flow?.partner ?? null,
            biz_type: row.biz_type,
          };
        });
      return ok({ item: arapWithDerived(row), offsets });
    }

    if (method === 'PUT') {
      const before = JSON.parse(JSON.stringify(row)) as ArApItem;
      if (body.amount !== undefined) {
        const amount = numOf(body.amount, 0);
        if (toScaled(amount, 2) < toScaled(row.settled_amount, 2)) {
          return fail(400, '金额不得小于已冲销额');
        }
        if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
        row.amount = amount;
      }
      if (body.biz_type !== undefined) row.biz_type = text(body.biz_type) as FundBizType;
      if (body.biz_date !== undefined) row.biz_date = pStr(body.biz_date) ?? row.biz_date;
      if (body.partner !== undefined) row.partner = nullableText(body.partner);
      if (body.remark !== undefined) row.remark = nullableText(body.remark);
      row.updated_at = nowStamp();
      recalcArap(row);
      logChange('ar_ap', row.id, 'update', before, row);
      persist();
      return ok(arapWithDerived(row));
    }

    if (method === 'DELETE') {
      if (db.offsets.some((o) => o.ar_ap_id === id)) return fail(409, '该单据已有冲销记录，请先撤销冲销');
      softDelete(db.arap, id, 'ar_ap');
      persist();
      return ok({ id, deleted: true });
    }
  }

  return null;
}

/* ------------------------------ 五类成本 ------------------------------ */

const COST_TYPES: CostType[] = ['labor', 'material', 'machine', 'misc', 'advance'];

const COST_TYPE_LABEL: Record<string, string> = {
  labor: '人工',
  material: '材料',
  machine: '机械',
  misc: '杂费',
  advance: '垫付',
};

/** 从变更日志快照里安全读取 cost_id */
function afterCostId(json: string | null | undefined): number | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const value = Number(parsed.cost_id);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function ensureProject(projectId: number | undefined): MockResult | null {
  if (!projectId) return fail(400, '请选择项目');
  if (!db.projects.some((p) => p.id === projectId && !p.deleted)) return fail(404, '项目不存在');
  return null;
}

/** 成本轻量摘要（与后端 cost_service.cost_brief 口径一致，需求 T3） */
function mockCostBrief(costId: number): Record<string, unknown> | null {
  const cost = db.costs.find((c) => c.id === costId);
  if (!cost) return null;
  const typeLabel = COST_TYPE_LABEL[cost.type] ?? cost.type;
  const expense =
    cost.type === 'misc'
      ? cost.category
      : cost.type === 'material'
        ? cost.material_name
        : cost.type === 'labor'
          ? cost.worker_name
          : cost.type === 'machine'
            ? cost.machine_name
            : (cost.payer ?? cost.partner);
  return {
    id: cost.id,
    type: cost.type,
    type_label: typeLabel,
    expense: expense ?? null,
    subject: expense ?? null,
    partner: cost.partner ?? null,
    amount: cost.amount,
    biz_date: cost.biz_date,
    category: cost.category ?? null,
    deleted: cost.deleted,
    label: expense ? `${typeLabel} · ${expense} ${fmtMoney(cost.amount)}` : `${typeLabel} ${fmtMoney(cost.amount)}`,
  };
}

function handleCosts(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  /* ---------- 成本 ↔ 应付单联动（与后端 payable_service 口径一致） ---------- */

  const briefMatch = /^\/costs\/(\d+)\/brief$/.exec(path);
  if (method === 'GET' && briefMatch) {
    const brief = mockCostBrief(Number(briefMatch[1]));
    if (!brief) return fail(404, '成本记录不存在');
    return ok(brief);
  }

  /** 取某笔成本自动生成的应付单 */
  const payableSummary = (costId: number): MockResult => {
    const cost = db.costs.find((c) => c.id === costId && !c.deleted);
    if (!cost) return fail(404, '成本不存在或已删除');
    const row = db.arap.find((a) => a.cost_id === costId && !a.deleted);
    if (!row) return ok({ has_payable: false });
    const offsets = db.offsets
      .filter((o) => o.ar_ap_id === row.id)
      .map((o) => ({
        id: o.id,
        funds_flow_id: o.funds_flow_id,
        amount: o.amount,
        offset_date: o.offset_date,
        remark: o.remark,
      }));
    return ok({
      has_payable: true,
      arap: arapWithDerived(row),
      offsets,
      paid_total: addMoney(...offsets.map((o) => o.amount)),
      unsettled: arapUnsettled(row),
    });
  };

  const payableMatch = /^\/costs\/(\d+)\/payable$/.exec(path);
  if (method === 'GET' && payableMatch) {
    return payableSummary(Number(payableMatch[1]));
  }

  /** 登记已付：生成付款流水 + 自动冲销该成本的应付单（四项全选填） */
  const payMatch = /^\/costs\/(\d+)\/pay$/.exec(path);
  if (method === 'POST' && payMatch) {
    const costId = Number(payMatch[1]);
    const cost = db.costs.find((c) => c.id === costId && !c.deleted);
    if (!cost) return fail(404, '成本不存在或已删除');
    const row = db.arap.find((a) => a.cost_id === costId && !a.deleted);
    if (!row) return fail(400, '该成本没有对应的应付单');

    const rawPaid = body.paid_amount;
    const paid = rawPaid === undefined || rawPaid === null || rawPaid === '' ? 0 : numOf(rawPaid, 0);
    if (toScaled(paid, 2) < 0) return fail(400, '已付金额不能为负数');
    if (toScaled(paid, 2) === 0) {
      return ok({ recorded: false, reason: '未填已付金额，应付单全额挂账', arap: arapWithDerived(row) });
    }
    const unsettled = arapUnsettled(row);
    if (toScaled(paid, 2) > toScaled(unsettled, 2)) {
      return fail(400, `已付金额 ${paid} 超过该应付单未结金额 ${unsettled}；请先到「往来」页核对。`);
    }
    const payDate = pStr(body.pay_date) ?? today();
    const flow: FundsFlow = {
      id: nextId('funds'),
      project_id: row.project_id,
      direction: 'out',
      biz_type: row.biz_type,
      amount: paid,
      biz_date: payDate,
      partner: row.partner ?? null,
      pay_method: (pStr(body.pay_method) as PayMethod | undefined) ?? null,
      remark: nullableText(body.remark) ?? `登记成本 #${costId} 的已付款`,
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.funds.push(flow);
    logChange('funds_flow', flow.id, 'create', null, flow);

    const offset: ArApOffset = {
      id: nextId('offsets'),
      ar_ap_id: row.id,
      funds_flow_id: flow.id,
      amount: paid,
      offset_date: payDate,
      remark: `登记成本 #${costId} 已付款`,
      created_at: nowStamp(),
    };
    db.offsets.push(offset);
    const before = JSON.parse(JSON.stringify(row)) as ArApItem;
    recalcArap(row);
    logChange('ar_ap', row.id, 'update', before, row);
    persist();
    return ok({
      recorded: true,
      funds_flow_id: flow.id,
      offset_ids: [offset.id],
      paid_amount: paid,
      flow_unapplied: 0,
      flow_unapplied_hint: `本次付款 ${paid} 已全部用于冲销应付单。`,
      arap: arapWithDerived(row),
    });
  }

  if (method === 'GET' && path === '/costs/summary') {
    const filter = commonFilter(params);
    const types = pStr(params.type)?.split(',').filter(Boolean) as CostType[] | undefined;
    const rows = db.costs.filter(
      (c) => matchCommon(c, filter) && (!types || types.length === 0 || types.includes(c.type)),
    );
    const byType: Record<string, number> = {};
    COST_TYPES.forEach((t) => {
      byType[t] = addMoney(...rows.filter((r) => r.type === t).map((r) => r.amount));
    });
    const categories = new Map<string, number>();
    rows
      .filter((r) => r.type === 'misc' && r.category)
      .forEach((r) => categories.set(text(r.category), addMoney(categories.get(text(r.category)) ?? 0, r.amount)));
    const projects = new Map<number, number>();
    rows.forEach((r) => projects.set(r.project_id, addMoney(projects.get(r.project_id) ?? 0, r.amount)));
    return ok({
      total: addMoney(...rows.map((r) => r.amount)),
      by_type: byType,
      by_category: Array.from(categories.entries()).map(([category, amount]) => ({ category, amount })),
      by_project: Array.from(projects.entries()).map(([project_id, amount]) => ({ project_id, amount })),
    });
  }

  if (method === 'GET' && path === '/costs') {
    const filter = commonFilter(params);
    const types = pStr(params.type)?.split(',').filter(Boolean) as CostType[] | undefined;
    let rows = db.costs.filter(
      (c) => matchCommon(c, filter) && (!types || types.length === 0 || types.includes(c.type)),
    );
    rows = rows.filter((c) =>
      matchKeyword(filter.keyword, [
        c.worker_name,
        c.material_name,
        c.machine_name,
        c.category,
        c.supplier,
        c.payer,
        c.partner,
        c.remark,
      ]),
    );
    return ok(paginate(sortByDateDesc(rows.map(withProjectName)), params));
  }

  const createMatch = /^\/costs\/(labor|material|machine|misc|advance)$/.exec(path);
  if (method === 'POST' && createMatch) {
    const costType = createMatch[1] as CostType;
    const projectId = pNum(body.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const lockedCost = ensureMutable(projectId as number);
    if (lockedCost) return lockedCost;
    const pid = projectId as number;
    const bizDate = pStr(body.biz_date);
    if (!bizDate) return fail(400, '日期必填');

    const base: CostItem = {
      id: nextId('cost'),
      project_id: pid,
      type: costType,
      amount: 0,
      biz_date: bizDate,
      partner: null,
      remark: nullableText(body.remark),
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    let extra: Partial<CostItem> = {};
    let inventoryTxnId: number | null = null;

    if (costType === 'labor') {
      const workerName = text(body.worker_name).trim();
      if (!workerName) return fail(400, '姓名必填');
      const workDays = numOf(body.work_days, 0);
      const dayRate = numOf(body.day_rate, 0);
      if (workDays <= 0) return fail(400, '工日数必须大于 0');
      if (dayRate <= 0) return fail(400, '日工价必须大于 0');
      const amount = body.amount === undefined || body.amount === null || body.amount === ''
        ? mulMoney(workDays, dayRate)
        : numOf(body.amount, 0);
      if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
      base.amount = amount;
      base.partner = workerName;
      extra = { worker_name: workerName, work_days: workDays, day_rate: dayRate };
    } else if (costType === 'material') {
      const materialName = text(body.material_name).trim();
      const unit = text(body.unit).trim();
      const quantity = numOf(body.quantity, 0);
      const unitPrice = numOf(body.unit_price, 0);
      if (!materialName) return fail(400, '材料名称必填');
      if (!unit) return fail(400, '单位必填');
      if (quantity <= 0) return fail(400, '数量必须大于 0');
      if (unitPrice <= 0) return fail(400, '单价必须大于 0');
      const amount = body.amount === undefined || body.amount === null || body.amount === ''
        ? mulMoney(quantity, unitPrice)
        : numOf(body.amount, 0);
      base.amount = amount;
      base.partner = nullableText(body.supplier);
      // 采购即成本 + 同时写库存入库（同一事务）
      const txn: InventoryTxn = {
        id: nextId('invTxns'),
        project_id: pid,
        material_name: materialName,
        unit,
        txn_type: 'in',
        quantity,
        unit_price: unitPrice,
        supplier: nullableText(body.supplier),
        cost_id: base.id,
        biz_date: bizDate,
        remark: '材料采购自动入库',
        deleted: 0,
        created_at: nowStamp(),
        updated_at: nowStamp(),
      };
      db.invTxns.push(txn);
      inventoryTxnId = txn.id;
      logChange('inventory_txn', txn.id, 'create', null, txn);
      ensureDict('material', materialName);
      ensureDict('unit', unit);
      ensureDict('partner', txn.supplier);
      extra = {
        material_name: materialName,
        unit,
        quantity,
        unit_price: unitPrice,
        supplier: nullableText(body.supplier),
        inventory_txn_id: inventoryTxnId,
      };
    } else if (costType === 'machine') {
      const machineName = text(body.machine_name).trim();
      const measure = text(body.measure) as MachineMeasure;
      const quantity = numOf(body.quantity, 0);
      const unitPrice = numOf(body.unit_price, 0);
      if (!machineName) return fail(400, '设备名称必填');
      if (measure !== 'shift' && measure !== 'hour') return fail(400, '计量方式必须是台班或小时');
      if (quantity <= 0) return fail(400, '数量必须大于 0');
      if (unitPrice <= 0) return fail(400, '单价必须大于 0');
      const amount = body.amount === undefined || body.amount === null || body.amount === ''
        ? mulMoney(quantity, unitPrice)
        : numOf(body.amount, 0);
      base.amount = amount;
      base.partner = nullableText(body.lessor);
      extra = { machine_name: machineName, measure, quantity, unit_price: unitPrice, lessor: nullableText(body.lessor) };
      ensureDict('partner', base.partner);
    } else if (costType === 'misc') {
      const category = text(body.category).trim();
      if (!category) return fail(400, '杂费小类必填');
      const amount = numOf(body.amount, 0);
      if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
      base.amount = amount;
      base.category = category;
      base.partner = category;
      extra = { category };
      ensureDict('misc_category', category);
    } else {
      const amount = numOf(body.amount, 0);
      if (toScaled(amount, 2) <= 0) return fail(400, '金额必须大于 0');
      base.amount = amount;
      base.partner = nullableText(body.payer) ?? '老板';
      extra = { payer: nullableText(body.payer) ?? '老板', purpose: nullableText(body.purpose) };
      ensureDict('partner', base.partner);
    }

    const row: CostItem = { ...base, ...extra };
    db.costs.push(row);
    logChange('cost', row.id, 'create', null, row);

    // 录一笔成本 → 自动生成一张应付单（金额＝成本全额，关联 cost_id）
    // 口径与后端 payable_service.COST_TO_BIZ_TYPE 保持一致
    const BIZ_OF_COST: Record<string, FundBizType> = {
      labor: 'labor',
      material: 'material',
      machine: 'machine',
      misc: 'misc',
      advance: 'advance_pay',
    };
    // 幂等守卫：同一笔成本只允许有一张自动应付单。
    // （开发模式 StrictMode 会把创建副作用跑两次，缺了这道守卫就会出现重复单据，
    //   进而让「按 id 找单据」的冲销更新错对象 —— 曾因此让一条测试失败。）
    const existedPayable = db.arap.find((a) => !a.deleted && a.cost_id === row.id);
    if (!existedPayable) {
      const payable: ArApItem = {
        id: nextId('arap'),
        project_id: pid,
        type: 'payable',
        biz_type: BIZ_OF_COST[costType] ?? 'other',
        amount: row.amount,
        settled_amount: 0,
        status: 'open',
        biz_date: row.biz_date,
        partner: row.partner ?? null,
        cost_id: row.id,
        remark: '由记账/成本录入自动生成',
        deleted: 0,
        created_at: nowStamp(),
        updated_at: nowStamp(),
      };
      db.arap.push(payable);
      logChange('ar_ap', payable.id, 'create', null, payable);
    }

    persist();
    if (costType === 'material') {
      return ok({
        cost_id: row.id,
        inventory_txn_id: inventoryTxnId,
        inventory_balance: inventoryBalanceOf(pid, text(row.material_name), text(row.unit)),
        item: withProjectName(row),
      });
    }
    return ok({ cost_id: row.id, item: withProjectName(row) });
  }

  const logsMatch = /^\/costs\/(\d+)\/logs$/.exec(path);
  if (method === 'GET' && logsMatch) {
    const id = Number(logsMatch[1]);
    const logs = db.logs
      .filter((l) => {
        if (l.table_name === 'cost' && l.record_id === id) return true;
        // 材料成本会连带产生入库流水，一并放进时间线
        if (l.table_name === 'inventory_txn') return afterCostId(l.after_json) === id;
        return false;
      })
      .sort((a, b) => a.id - b.id);
    return ok(logs);
  }

  const idMatch = /^\/costs\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.costs.find((c) => c.id === id);
    if (!row) return fail(404, '成本记录不存在');

    if (method === 'PUT') {
      const before = JSON.parse(JSON.stringify(row)) as CostItem;
      if (body.biz_date !== undefined) row.biz_date = pStr(body.biz_date) ?? row.biz_date;
      if (body.remark !== undefined) row.remark = nullableText(body.remark);

      if (row.type === 'labor') {
        if (body.worker_name !== undefined) row.worker_name = text(body.worker_name).trim();
        if (body.work_days !== undefined) row.work_days = numOf(body.work_days, numOf(row.work_days, 0));
        if (body.day_rate !== undefined) row.day_rate = numOf(body.day_rate, numOf(row.day_rate, 0));
        row.partner = row.worker_name ?? null;
        row.amount =
          body.amount === undefined || body.amount === null || body.amount === ''
            ? mulMoney(row.work_days, row.day_rate)
            : numOf(body.amount, 0);
      } else if (row.type === 'material') {
        if (body.material_name !== undefined) row.material_name = text(body.material_name).trim();
        if (body.unit !== undefined) row.unit = text(body.unit).trim();
        if (body.quantity !== undefined) row.quantity = numOf(body.quantity, numOf(row.quantity, 0));
        if (body.unit_price !== undefined) row.unit_price = numOf(body.unit_price, numOf(row.unit_price, 0));
        if (body.supplier !== undefined) row.supplier = nullableText(body.supplier);
        row.partner = row.supplier ?? null;
        row.amount = mulMoney(row.quantity, row.unit_price);
        const txn = db.invTxns.find((t) => t.id === row.inventory_txn_id);
        if (txn) {
          txn.material_name = text(row.material_name);
          txn.unit = text(row.unit);
          txn.quantity = numOf(row.quantity, 0);
          txn.unit_price = numOf(row.unit_price, 0);
          txn.supplier = row.supplier;
          txn.biz_date = row.biz_date;
          txn.updated_at = nowStamp();
          logChange('inventory_txn', txn.id, 'update', null, txn);
        }
      } else if (row.type === 'machine') {
        if (body.machine_name !== undefined) row.machine_name = text(body.machine_name).trim();
        if (body.measure !== undefined) row.measure = text(body.measure) as MachineMeasure;
        if (body.quantity !== undefined) row.quantity = numOf(body.quantity, numOf(row.quantity, 0));
        if (body.unit_price !== undefined) row.unit_price = numOf(body.unit_price, numOf(row.unit_price, 0));
        if (body.lessor !== undefined) row.lessor = nullableText(body.lessor);
        row.partner = row.lessor ?? null;
        row.amount = mulMoney(row.quantity, row.unit_price);
      } else if (row.type === 'misc') {
        if (body.category !== undefined) row.category = text(body.category).trim();
        row.partner = row.category ?? null;
        if (body.amount !== undefined) row.amount = numOf(body.amount, row.amount);
      } else {
        if (body.payer !== undefined) row.payer = nullableText(body.payer);
        if (body.purpose !== undefined) row.purpose = nullableText(body.purpose);
        row.partner = row.payer ?? null;
        if (body.amount !== undefined) row.amount = numOf(body.amount, row.amount);
      }
      if (toScaled(row.amount, 2) <= 0) return fail(400, '金额必须大于 0');
      row.updated_at = nowStamp();
      logChange('cost', row.id, 'update', before, row);
      persist();
      return ok(withProjectName(row));
    }

    if (method === 'DELETE') {
      if (row.type === 'material' && row.inventory_txn_id) {
        const txn = db.invTxns.find((t) => t.id === row.inventory_txn_id);
        if (txn && !txn.deleted) softDelete(db.invTxns, txn.id, 'inventory_txn');
      }
      // 口径：成本删除后它自动生成的应付单**保留**（不自动删），要回传提示给前端。
      // 与真实后端保持一致（backend/app/services/payable_service.py: on_cost_deleted）。
      const payable = db.arap.find((a) => a.cost_id === id && !a.deleted);
      softDelete(db.costs, id, 'cost');
      persist();
      if (!payable) return ok({ id, deleted: true, payable: { kept: false } });
      return ok({
        id,
        deleted: true,
        payable: {
          kept: true,
          payable_id: payable.id,
          payable_amount: payable.amount,
          payable_unsettled: arapUnsettled(payable),
          message: `该成本对应的应付单 #${payable.id} 已保留（未删除）。如不再需要，请到「往来」页自行处理。`,
        },
      });
    }
  }

  return null;
}

/* ------------------------------ 库存 ------------------------------ */

function handleInventory(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  if (method === 'GET' && path === '/inventory') {
    const projectId = pNum(params.project_id);
    if (!projectId) return fail(400, 'project_id 必填（库存按项目隔离）');
    const keys = new Map<string, { material_name: string; unit: string }>();
    db.invTxns
      .filter((t) => !t.deleted && t.project_id === projectId)
      .forEach((t) => keys.set(`${t.material_name}|${t.unit}`, { material_name: t.material_name, unit: t.unit }));
    const items = Array.from(keys.values())
      .sort((a, b) =>
        a.material_name === b.material_name
          ? a.unit.localeCompare(b.unit)
          : a.material_name.localeCompare(b.material_name),
      )
      .map(({ material_name, unit }) => {
        const rows = db.invTxns.filter(
          (t) => !t.deleted && t.project_id === projectId && t.material_name === material_name && t.unit === unit,
        );
        const inQty =
          rows.filter((r) => r.txn_type === 'in').reduce((s, r) => s + toScaled(r.quantity, 3), 0) / 1000;
        const outQty =
          rows.filter((r) => r.txn_type === 'out').reduce((s, r) => s + toScaled(r.quantity, 3), 0) / 1000;
        return {
          project_id: projectId,
          material_name,
          unit,
          in_qty: inQty,
          out_qty: outQty,
          balance: inventoryBalanceOf(projectId, material_name, unit),
        };
      });
    return ok(items);
  }

  if (method === 'GET' && path === '/inventory/txns') {
    const filter = commonFilter(params);
    const txnType = pStr(params.txn_type);
    const materialName = pStr(params.material_name);
    let rows = db.invTxns.filter((t) => matchCommon(t, filter));
    if (txnType) rows = rows.filter((t) => t.txn_type === txnType);
    if (materialName) rows = rows.filter((t) => t.material_name === materialName);
    rows = rows.filter((t) => matchKeyword(filter.keyword, [t.material_name, t.supplier, t.remark]));
    // 与真实后端一致：带上「关联成本」摘要，供表格显示 `#17（材料 · 水泥 40,000.00）`（需求 T3）
    const withCost = rows.map((t) => {
      const enriched = withProjectName(t);
      const brief = t.cost_id ? mockCostBrief(t.cost_id) : null;
      return { ...enriched, cost: brief, cost_label: brief?.label ?? null };
    });
    return ok(paginate(sortByDateDesc(withCost), params));
  }

  if (method === 'POST' && path === '/inventory/in') {
    const projectId = pNum(body.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const lockedIn = ensureMutable(projectId as number);
    if (lockedIn) return lockedIn;
    const pid = projectId as number;
    const materialName = text(body.material_name).trim();
    const unit = text(body.unit).trim();
    const quantity = numOf(body.quantity, 0);
    const bizDate = pStr(body.biz_date);
    if (!materialName) return fail(400, '材料名称必填');
    if (!unit) return fail(400, '单位必填');
    if (quantity <= 0) return fail(400, '数量必须大于 0');
    if (!bizDate) return fail(400, '日期必填');
    const txn: InventoryTxn = {
      id: nextId('invTxns'),
      project_id: pid,
      material_name: materialName,
      unit,
      txn_type: 'in',
      quantity,
      unit_price: body.unit_price === undefined ? null : numOf(body.unit_price, 0),
      supplier: nullableText(body.supplier),
      cost_id: null,
      biz_date: bizDate,
      remark: nullableText(body.remark) ?? '手工补录入库（不生成成本）',
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.invTxns.push(txn);
    logChange('inventory_txn', txn.id, 'create', null, txn);
    ensureDict('material', materialName);
    ensureDict('unit', unit);
    persist();
    return ok({
      txn_id: txn.id,
      balance: inventoryBalanceOf(pid, materialName, unit),
      enough: true,
      item: withProjectName(txn),
    });
  }

  if (method === 'POST' && path === '/inventory/out') {
    const projectId = pNum(body.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const lockedOut = ensureMutable(projectId as number);
    if (lockedOut) return lockedOut;
    const pid = projectId as number;
    const materialName = text(body.material_name).trim();
    const unit = text(body.unit).trim();
    const quantity = numOf(body.quantity, 0);
    const bizDate = pStr(body.biz_date);
    if (!materialName) return fail(400, '材料名称必填');
    if (!unit) return fail(400, '单位必填');
    if (quantity <= 0) return fail(400, '数量必须大于 0');
    if (!bizDate) return fail(400, '日期必填');
    // 领用只减库存，不生成成本；余量不足时仍返回 code=0，前端标红提示
    const after = invScaled(pid, materialName, unit) - toScaled(quantity, 3);
    const txn: InventoryTxn = {
      id: nextId('invTxns'),
      project_id: pid,
      material_name: materialName,
      unit,
      txn_type: 'out',
      quantity,
      unit_price: null,
      supplier: null,
      cost_id: null,
      biz_date: bizDate,
      remark: nullableText(body.remark),
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.invTxns.push(txn);
    logChange('inventory_txn', txn.id, 'create', null, txn);
    persist();
    return ok({ txn_id: txn.id, balance: after / 1000, enough: after >= 0 });
  }

  const idMatch = /^\/inventory\/txns\/(\d+)$/.exec(path);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const row = db.invTxns.find((t) => t.id === id);
    if (!row) return fail(404, '库存流水不存在');

    if (method === 'PUT') {
      const before = JSON.parse(JSON.stringify(row)) as InventoryTxn;
      if (body.material_name !== undefined) row.material_name = text(body.material_name).trim();
      if (body.unit !== undefined) row.unit = text(body.unit).trim();
      if (body.quantity !== undefined) row.quantity = numOf(body.quantity, row.quantity);
      if (body.unit_price !== undefined) row.unit_price = numOf(body.unit_price, 0);
      if (body.supplier !== undefined) row.supplier = nullableText(body.supplier);
      if (body.biz_date !== undefined) row.biz_date = pStr(body.biz_date) ?? row.biz_date;
      if (body.remark !== undefined) row.remark = nullableText(body.remark);
      row.updated_at = nowStamp();
      logChange('inventory_txn', row.id, 'update', before, row);
      persist();
      return ok({
        ...withProjectName(row),
        balance: inventoryBalanceOf(row.project_id, row.material_name, row.unit),
      });
    }

    if (method === 'DELETE') {
      softDelete(db.invTxns, id, 'inventory_txn');
      persist();
      return ok({
        id,
        deleted: true,
        balance: inventoryBalanceOf(row.project_id, row.material_name, row.unit),
      });
    }
  }

  return null;
}

/* ------------------------------ 结算（五类成本） ------------------------------ */

/** 五类结算类别 + 各自的汇总依据名（与后端 SETTLE_TYPE_LABELS / SETTLE_GROUP_LABELS 一致） */
const SETTLE_TYPE_LABELS: Record<string, string> = {
  labor: '人工',
  material: '材料',
  machine: '机械',
  misc: '杂费',
  advance: '垫付',
};
const SETTLE_GROUP_LABELS: Record<string, string> = {
  labor: '按工人姓名',
  material: '按供应商',
  machine: '按出租方',
  misc: '按杂费小类',
  advance: '按垫付人',
};
/** 没填对方时的占位分组名（与后端 PARTNER_NONE_LABEL 一致） */
const PARTNER_NONE_LABEL = '（未填对方）';

/** 取出某类成本「按谁汇总」的值：人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人 */
function settlePartnerOf(cost: CostItem): string {
  switch (cost.type) {
    case 'labor':
      return text(cost.worker_name, PARTNER_NONE_LABEL);
    case 'material':
      return text(cost.supplier, PARTNER_NONE_LABEL);
    case 'machine':
      return text(cost.lessor, PARTNER_NONE_LABEL);
    case 'misc':
      return text(cost.category, PARTNER_NONE_LABEL);
    case 'advance':
      return text(cost.payer, PARTNER_NONE_LABEL);
    default:
      return PARTNER_NONE_LABEL;
  }
}

function previewOf(projectId: number, costType: string = 'labor') {
  const rows = db.costs.filter((c) => !c.deleted && c.project_id === projectId && c.type === costType);
  const grouped = new Map<string, { total_days: number; amount_due: number; count: number }>();
  rows.forEach((c) => {
    const name = settlePartnerOf(c);
    const current = grouped.get(name) ?? { total_days: 0, amount_due: 0, count: 0 };
    if (costType === 'labor') current.total_days += toScaled(c.work_days, 2) / 100;
    current.amount_due = addMoney(current.amount_due, c.amount);
    current.count += 1;
    grouped.set(name, current);
  });
  const items = Array.from(grouped.entries())
    .map(([partner, agg]) => {
      const settle = db.settles.find(
        (s) => s.project_id === projectId && s.worker_name === partner && (s.cost_type ?? 'labor') === costType,
      );
      return {
        worker_name: partner,
        partner,
        cost_type: costType,
        cost_type_label: SETTLE_TYPE_LABELS[costType] ?? costType,
        cost_count: agg.count,
        total_days: Math.round(agg.total_days * 100) / 100,
        amount_due: agg.amount_due,
        paid_amount: settle?.paid_amount ?? 0,
        settle_id: settle?.id ?? null,
        status: settle?.status ?? 'unpaid',
      };
    })
    .sort((a, b) => toScaled(b.amount_due, 2) - toScaled(a.amount_due, 2));
  return {
    items,
    total: addMoney(...items.map((i) => i.amount_due)),
    totalDays: items.reduce((sum, i) => sum + i.total_days, 0),
  };
}

/**
 * 欠款总览（一对象一行，累计口径）——与后端 `settlement_overview` 同口径。
 *
 * 「已付」把该对象名下应付单上的**所有冲销记录**加起来，
 * 所以钱从哪个入口付的（收/付款页、冲销弹窗、登记已付、结算发放）都算得进来。
 */
function mockSettleOverview(projectId: number, costType: string) {
  const bizType = SETTLE_BIZ_TYPE_OF_COST[costType] ?? costType;

  // ① 累计应付：该类别全部未删除成本
  const dueMap = new Map<string, number>();
  db.costs
    .filter((c) => !c.deleted && c.project_id === projectId && c.type === costType)
    .forEach((c) => {
      const name = settlePartnerOf(c);
      dueMap.set(name, addMoney(dueMap.get(name) ?? 0, c.amount));
    });

  // ② 累计已付 + 付款方式构成：该对象名下应付单的全部冲销记录
  const paidMap = new Map<string, number>();
  const methodMap = new Map<string, Map<string, number>>();
  db.arap
    .filter(
      (a) => !a.deleted && a.project_id === projectId && a.type === 'payable' && a.biz_type === bizType,
    )
    .forEach((a) => {
      const name = text(a.partner, PARTNER_NONE_LABEL);
      db.offsets
        .filter((o) => o.ar_ap_id === a.id)
        .forEach((o) => {
          const flow = db.funds.find((f) => f.id === o.funds_flow_id);
          paidMap.set(name, addMoney(paidMap.get(name) ?? 0, o.amount));
          const key = flow?.pay_method ? String(flow.pay_method) : 'unknown';
          const bucket = methodMap.get(name) ?? new Map<string, number>();
          bucket.set(key, addMoney(bucket.get(key) ?? 0, o.amount));
          methodMap.set(name, bucket);
        });
    });

  // ③ 本期该结（时间段内）
  const periodMap = new Map<string, number>();
  previewOf(projectId, costType).items.forEach((item) => {
    periodMap.set(item.partner, item.amount_due);
  });

  const names = new Set<string>([...dueMap.keys(), ...paidMap.keys()]);
  const items = Array.from(names)
    .map((partner) => {
      const due = dueMap.get(partner) ?? 0;
      const paid = paidMap.get(partner) ?? 0;
      const left = subMoney(due, paid);
      const methods = methodMap.get(partner) ?? new Map<string, number>();
      return {
        partner,
        worker_name: partner,
        cost_type: costType,
        cost_type_label: SETTLE_TYPE_LABELS[costType] ?? costType,
        amount_due: due,
        paid_amount: paid,
        unsettled: toScaled(left, 2) > 0 ? left : 0,
        period_amount: periodMap.get(partner) ?? 0,
        paid_methods: Array.from(methods.entries())
          .map(([key, amount]) => ({
            pay_method: key,
            pay_method_label: PAY_METHOD_LABEL_MOCK[key] ?? key,
            amount,
          }))
          .sort((a, b) => toScaled(b.amount, 2) - toScaled(a.amount, 2)),
        status: toScaled(left, 2) <= 0 ? 'closed' : toScaled(paid, 2) > 0 ? 'partial' : 'open',
      };
    })
    .sort((a, b) => toScaled(b.unsettled, 2) - toScaled(a.unsettled, 2));

  return {
    project_id: projectId,
    cost_type: costType,
    cost_type_label: SETTLE_TYPE_LABELS[costType] ?? costType,
    group_label: SETTLE_GROUP_LABELS[costType] ?? '',
    items,
    total_due: addMoney(...items.map((i) => i.amount_due)),
    total_paid: addMoney(...items.map((i) => i.paid_amount)),
    total_unsettled: addMoney(...items.map((i) => i.unsettled)),
    note: '已付＝该对象名下应付单的全部冲销记录之和（钱从哪个入口付的都算）',
  };
}

/** 结算类别 → 应付单业务类型（垫付是 advance_pay） */
const SETTLE_BIZ_TYPE_OF_COST: Record<string, string> = {
  labor: 'labor',
  material: 'material',
  machine: 'machine',
  misc: 'misc',
  advance: 'advance_pay',
};

const PAY_METHOD_LABEL_MOCK: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  bank_card: '银行卡',
  transfer: '转账',
  unknown: '未填',
};

function handleLabor(req: MockRequest): MockResult | null {
  const { method, path, params, body } = req;

  if (method === 'GET' && path === '/labor/types') {
    return ok({
      items: Object.keys(SETTLE_TYPE_LABELS).map((kind) => ({
        cost_type: kind,
        cost_type_label: SETTLE_TYPE_LABELS[kind],
        group_label: SETTLE_GROUP_LABELS[kind],
      })),
    });
  }

  if (method === 'GET' && path === '/labor/overview') {
    const projectId = pNum(params.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const costType = pStr(params.cost_type) ?? 'labor';
    return ok(mockSettleOverview(projectId as number, costType));
  }

  if (method === 'POST' && path === '/labor/pay') {
    const projectId = pNum(body.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const lockedPay = ensureMutable(projectId as number);
    if (lockedPay) return lockedPay;
    const pid = projectId as number;
    const costType = pStr(body.cost_type) ?? 'labor';
    const partner = text(body.partner).trim();
    if (!partner) return fail(400, '缺少发放对象');
    const amount = numOf(body.amount, 0);
    if (toScaled(amount, 2) <= 0) return fail(400, '发放金额必须大于 0');

    // 上限 = 累计应付 − 已付（防多付）
    const ov = mockSettleOverview(pid, costType);
    const row = ov.items.find((item) => item.partner === partner);
    const unsettled = row ? Number(row.unsettled) : 0;
    if (toScaled(unsettled, 2) <= 0) {
      return fail(400, `「${partner}」当前没有未结欠款，无需再发放。`);
    }
    if (toScaled(amount, 2) > toScaled(unsettled, 2)) {
      return fail(400, `发放金额 ${amount.toFixed(2)} 超过未结欠款 ${unsettled.toFixed(2)}`);
    }

    // 没有快照就先补一张（发放口径是"这个人还欠多少"，不依赖结算单）
    let settle = db.settles.find(
      (s) => s.project_id === pid && (s.cost_type ?? 'labor') === costType && s.worker_name === partner,
    );
    if (!settle) {
      const { items } = previewOf(pid, costType);
      const item = items.find((i) => i.partner === partner);
      if (!item) return fail(404, `「${partner}」没有可结算的成本`);
      settle = {
        id: nextId('settles'),
        project_id: pid,
        worker_name: partner,
        cost_type: costType as SettleType,
        partner,
        total_days: item.total_days,
        amount_due: item.amount_due,
        paid_amount: 0,
        status: 'unpaid',
        settle_date: pStr(body.pay_date) ?? today(),
        pay_date: null,
        pay_method: null,
        remark: null,
        created_at: nowStamp(),
        updated_at: nowStamp(),
      };
      db.settles.push(settle);
    }
    // 复用按 id 发放的逻辑：把 request 改写成 /labor/settles/{id}/pay
    return handleLabor({
      ...req,
      path: `/labor/settles/${settle.id}/pay`,
      params: {},
    });
  }

  if (method === 'GET' && path === '/labor/preview') {
    const projectId = pNum(params.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const costType = pStr(params.cost_type) ?? 'labor';
    const { items, total, totalDays } = previewOf(projectId as number, costType);
    return ok({
      project_id: projectId,
      cost_type: costType,
      cost_type_label: SETTLE_TYPE_LABELS[costType] ?? costType,
      group_label: SETTLE_GROUP_LABELS[costType] ?? '',
      items,
      total_days: totalDays,
      total_amount: total,
      note: '结算不重复计入成本',
    });
  }

  if (method === 'POST' && path === '/labor/settle') {
    const projectId = pNum(body.project_id);
    const projectError = ensureProject(projectId);
    if (projectError) return projectError;
    const lockedSettle = ensureMutable(projectId as number);
    if (lockedSettle) return lockedSettle;
    const pid = projectId as number;
    const costType = pStr(body.cost_type) ?? 'labor';
    const settleDate = pStr(body.settle_date) ?? today();
    const { items, total } = previewOf(pid, costType);
    const result: LaborSettle[] = [];
    items.forEach((item) => {
      const existing = db.settles.find(
        (s) =>
          s.project_id === pid &&
          s.worker_name === item.partner &&
          (s.cost_type ?? 'labor') === costType,
      );
      if (existing) {
        // 重复生成时覆盖未发放部分：保留已发金额
        existing.total_days = item.total_days;
        existing.amount_due = item.amount_due;
        existing.settle_date = settleDate;
        existing.updated_at = nowStamp();
        if (toScaled(existing.paid_amount, 2) >= toScaled(existing.amount_due, 2)) existing.status = 'paid';
        else if (toScaled(existing.paid_amount, 2) > 0) existing.status = 'partial';
        else existing.status = 'unpaid';
        result.push(existing);
      } else {
        const row: LaborSettle = {
          id: nextId('settles'),
          project_id: pid,
          worker_name: item.partner,
          cost_type: costType as SettleType,
          partner: item.partner,
          total_days: item.total_days,
          amount_due: item.amount_due,
          paid_amount: 0,
          status: 'unpaid',
          settle_date: settleDate,
          pay_date: null,
          pay_method: null,
          remark: nullableText(body.remark),
          created_at: nowStamp(),
          updated_at: nowStamp(),
        };
        db.settles.push(row);
        result.push(row);
      }
      logChange('labor_settle', result[result.length - 1].id, 'create', null, result[result.length - 1]);
    });
    persist();
    return ok({
      items: result.map(withProjectName),
      total_amount: total,
      cost_type: costType,
      cost_type_label: SETTLE_TYPE_LABELS[costType] ?? costType,
      created: result.length,
      note: '结算不重复计入成本',
    });
  }

  if (method === 'GET' && path === '/labor/settles') {
    const filter = commonFilter(params);
    const status = pStr(params.status);
    const costType = pStr(params.cost_type);
    let rows = db.settles.filter((s) =>
      matchCommon({ ...s, deleted: 0, biz_date: s.settle_date ?? '' }, filter),
    );
    if (costType) rows = rows.filter((s) => (s.cost_type ?? 'labor') === costType);
    if (status) rows = rows.filter((s) => s.status === status);
    rows = rows.filter((s) => matchKeyword(filter.keyword, [s.worker_name, s.partner, s.remark]));
    rows = [...rows].sort((a, b) => b.id - a.id);
    return ok(paginate(rows.map(withProjectName), params));
  }

  const payMatch = /^\/labor\/settles\/(\d+)\/pay$/.exec(path);
  if (method === 'POST' && payMatch) {
    const row = db.settles.find((s) => s.id === Number(payMatch[1]));
    if (!row) return fail(404, '结算单不存在');
    const amount = numOf(body.amount, 0);
    if (toScaled(amount, 2) <= 0) return fail(400, '发放金额必须大于 0');

    // 2026-10-16：上限用**真实未结额**（累计应付 − 已付），不看结算单自己的已发
    const costType = row.cost_type ?? 'labor';
    const partner = row.partner ?? row.worker_name;
    const ov = mockSettleOverview(row.project_id, costType);
    const ovRow = ov.items.find((item) => item.partner === partner);
    const unsettled = ovRow ? Number(ovRow.unsettled) : 0;
    if (toScaled(unsettled, 2) <= 0) {
      return fail(400, `「${partner}」当前没有未结欠款，无需再发放。`);
    }
    if (toScaled(amount, 2) > toScaled(unsettled, 2)) {
      return fail(400, `发放金额 ${amount.toFixed(2)} 超过未结欠款 ${unsettled.toFixed(2)}`);
    }

    // 结算单只是"本期该结多少"的快照：只记最后一次发放的日期/方式，不再存已发金额
    const before = JSON.parse(JSON.stringify(row)) as LaborSettle;
    row.pay_date = pStr(body.pay_date) ?? today();
    row.pay_method = (pStr(body.pay_method) as PayMethod) ?? null;
    if (body.remark !== undefined) row.remark = nullableText(body.remark);
    row.updated_at = nowStamp();
    logChange('labor_settle', row.id, 'update', before, row);

    // 需求 T6：发放同时生成付款流水，并按自动冲销规则冲掉该对象的应付单（与真实后端同口径）
    const payDate = row.pay_date ?? today();
    const bizType = SETTLE_BIZ_TYPE_OF_COST[costType] ?? 'labor';
    const typeLabel = SETTLE_TYPE_LABELS[costType] ?? costType;
    const flow: FundsFlow = {
      id: nextId('funds'),
      project_id: row.project_id,
      direction: 'out',
      biz_type: bizType as FundBizType,
      amount,
      biz_date: payDate,
      partner,
      pay_method: (pStr(body.pay_method) as PayMethod | undefined) ?? null,
      remark: nullableText(body.remark) ?? `${typeLabel}结算发放（${partner}）`,
      deleted: 0,
      created_at: nowStamp(),
      updated_at: nowStamp(),
    };
    db.funds.push(flow);
    logChange('funds_flow', flow.id, 'create', null, flow);

    const planResult = mockAutoOffsetPlan(flow.id);
    let offset = {
      applied: false,
      offset_ids: [] as number[],
      plan_total: 0,
      remaining: amount,
      message: '',
    };
    if (planResult.status === 200) {
      const data = (planResult.body as { data: Record<string, unknown> }).data;
      const list = data.plan as Array<Record<string, unknown>>;
      list.forEach((item) => {
        const target = db.arap.find((a) => a.id === Number(item.ar_ap_id));
        if (!target) return;
        const created: ArApOffset = {
          id: nextId('offsets'),
          ar_ap_id: target.id,
          funds_flow_id: flow.id,
          amount: Number(item.amount_to_offset),
          offset_date: payDate,
          remark: `${typeLabel}结算发放（${partner}）`,
          created_at: nowStamp(),
        };
        db.offsets.push(created);
        offset.offset_ids.push(created.id);
        const snap = JSON.parse(JSON.stringify(target)) as ArApItem;
        recalcArap(target);
        logChange('ar_ap', target.id, 'update', snap, target);
      });
      offset = {
        applied: list.length > 0,
        offset_ids: offset.offset_ids,
        plan_total: Number(data.plan_total ?? 0),
        remaining: Number(data.remaining ?? amount),
        message: String(data.message ?? ''),
      };
    }

    persist();
    return ok({ ...withProjectName(row), funds_flow_id: flow.id, offset, offset_hint: offset.message });
  }

  const idMatch = /^\/labor\/settles\/(\d+)$/.exec(path);
  if (method === 'DELETE' && idMatch) {
    const id = Number(idMatch[1]);
    const row = db.settles.find((s) => s.id === id);
    if (!row) return fail(404, '结算单不存在');
    // 2026-10-16 起：结算单只是"本期该结多少"的快照，钱在流水与冲销里，删快照不影响它们
    db.settles = db.settles.filter((s) => s.id !== id);
    logChange('labor_settle', id, 'delete', row, null);
    persist();
    return ok({ id, deleted: true });
  }

  return null;
}

/* ------------------------------ 看板 ------------------------------ */

function handleDashboard(req: MockRequest): MockResult | null {
  const { method, path, params } = req;

  if (method === 'GET' && path === '/dashboard/projects') {
    const start = pStr(params.start_date);
    const end = pStr(params.end_date);
    const filter: CommonFilter = { start_date: start, end_date: end };
    // 日期筛项目（2026-10-17）：首页与项目列表同一套口径
    const projects = filterByDateField(
      db.projects.filter((p) => !p.deleted),
      pStr(params.date_field),
      start,
      end,
    ).sort((a, b) => a.id - b.id);
    const items = projects.map((p) => {
      const metrics = projectMetrics(p, start, end);
      return {
        project_id: p.id,
        name: p.name,
        status: p.status,
        client_budget: p.client_budget,
        cost_budget: p.cost_budget,
        expect_profit: metrics.expect_profit,
        actual_cost: metrics.actual_cost,
        settle_profit: metrics.settle_profit,
        budget_left: metrics.budget_left,
        received: fundsTotal(p.id, 'in', filter),
        unreceived: arApUnsettledOf(p.id, 'receivable', filter),
        paid: fundsTotal(p.id, 'out', filter),
        unpaid: arApUnsettledOf(p.id, 'payable', filter),
      };
    });
    const total = {
      client_budget: addMoney(...items.map((i) => i.client_budget)),
      cost_budget: addMoney(...items.map((i) => i.cost_budget)),
      expect_profit: addMoney(...items.map((i) => i.expect_profit)),
      actual_cost: addMoney(...items.map((i) => i.actual_cost)),
      settle_profit: addMoney(...items.map((i) => i.settle_profit)),
      budget_left: addMoney(...items.map((i) => i.budget_left)),
      received: addMoney(...items.map((i) => i.received)),
      unreceived: addMoney(...items.map((i) => i.unreceived)),
      paid: addMoney(...items.map((i) => i.paid)),
      unpaid: addMoney(...items.map((i) => i.unpaid)),
    };
    return ok({ items, total });
  }

  if (method === 'GET' && path === '/dashboard/recent') {
    const costRows = db.costs
      .filter((c) => !c.deleted)
      .map((c) => ({
        id: c.id,
        kind: `cost_${c.type}`,
        title: `${text(projectName(c.project_id))} · ${costTypeTitle(c)}`,
        amount: c.amount,
        biz_date: c.biz_date,
        project_id: c.project_id,
        project_name: projectName(c.project_id),
        created_at: c.created_at ?? '',
      }));
    const fundRows = db.funds
      .filter((f) => !f.deleted)
      .map((f) => ({
        id: f.id,
        kind: `funds_${f.direction}`,
        title: `${text(projectName(f.project_id))} · ${f.direction === 'in' ? '收款' : '付款'}（${f.partner ?? '-'}）`,
        amount: f.amount,
        biz_date: f.biz_date,
        project_id: f.project_id,
        project_name: projectName(f.project_id),
        created_at: f.created_at ?? '',
      }));
    const settleRows = db.settles.map((s) => ({
      id: s.id,
      kind: 'labor_settle',
      title: `${text(projectName(s.project_id))} · 人工结算（${s.worker_name}）`,
      amount: s.amount_due,
      biz_date: s.settle_date ?? '',
      project_id: s.project_id,
      project_name: projectName(s.project_id),
      created_at: s.created_at ?? '',
    }));
    const items = [...costRows, ...fundRows, ...settleRows]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, 10);
    return ok(items);
  }

  if (method === 'GET' && path === '/dashboard/cost-trend') {
    const months = new Map<string, number>();
    db.costs
      .filter((c) => !c.deleted)
      .forEach((c) => {
        const month = text(c.biz_date).slice(0, 7);
        months.set(month, addMoney(months.get(month) ?? 0, c.amount));
      });
    const items = Array.from(months.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, amount]) => ({ month, amount }));
    return ok({ items });
  }

  return null;
}

function costTypeTitle(cost: CostItem): string {
  if (cost.type === 'labor') return `人工 ${cost.worker_name ?? ''}`;
  if (cost.type === 'material') return `材料 ${cost.material_name ?? ''}`;
  if (cost.type === 'machine') return `机械 ${cost.machine_name ?? ''}`;
  if (cost.type === 'misc') return `杂费 ${cost.category ?? ''}`;
  return `垫付 ${cost.payer ?? ''}`;
}

/* ------------------------------ 变更日志 ------------------------------ */

function handleLogs(req: MockRequest): MockResult | null {
  const { method, path, params } = req;

  if (method === 'GET' && path === '/logs') {
    const tableName = pStr(params.table_name);
    const recordId = pNum(params.record_id);
    const action = pStr(params.action);
    let rows = [...db.logs];
    if (tableName) rows = rows.filter((l) => l.table_name === tableName);
    if (recordId !== undefined) rows = rows.filter((l) => l.record_id === recordId);
    if (action) rows = rows.filter((l) => l.action === action);
    rows = rows.sort((a, b) => b.id - a.id);
    return ok(paginate(rows, params));
  }

  const match = /^\/logs\/([a-z_]+)\/(\d+)$/.exec(path);
  if (method === 'GET' && match) {
    const rows = db.logs
      .filter((l) => l.table_name === match[1] && l.record_id === Number(match[2]))
      .sort((a, b) => a.id - b.id);
    return ok(rows);
  }

  return null;
}

/* ------------------------------ 导出 ------------------------------ */

function csvCell(value: unknown): string {
  const text2 = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text2)) return `"${text2.replace(/"/g, '""')}"`;
  return text2;
}

function csvBlock(title: string, headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [`### ${title}`, headers.map(csvCell).join(',')];
  rows.forEach((row) => lines.push(row.map(csvCell).join(',')));
  return `${lines.join('\r\n')}\r\n`;
}

function handleExport(req: MockRequest): MockResult {
  const projectId = pNum(req.params.project_id);
  const start = pStr(req.params.start_date);
  const end = pStr(req.params.end_date);
  const inRange = (date: string | null | undefined) =>
    (!start || text(date) >= start) && (!end || text(date) <= end);
  const projects = db.projects.filter((p) => !p.deleted && (!projectId || p.id === projectId));

  let csv = '';
  csv += csvBlock(
    '项目盈亏',
    ['项目', '状态', '甲方预算', '我方成本预算', '预计利润', '实际成本', '结算利润', '成本预算余额', '已收', '未收', '已付', '未付'],
    projects.map((p) => {
      const m = projectMetrics(p, start, end);
      const filter: CommonFilter = { start_date: start, end_date: end };
      return [
        p.name,
        p.status === 'finished' ? '完工' : '在建',
        fmtMoney(p.client_budget),
        fmtMoney(p.cost_budget),
        fmtMoney(m.expect_profit),
        fmtMoney(m.actual_cost),
        fmtMoney(m.settle_profit),
        fmtMoney(m.budget_left),
        fmtMoney(fundsTotal(p.id, 'in', filter)),
        fmtMoney(arApUnsettledOf(p.id, 'receivable', filter)),
        fmtMoney(fundsTotal(p.id, 'out', filter)),
        fmtMoney(arApUnsettledOf(p.id, 'payable', filter)),
      ];
    }),
  );
  csv += csvBlock(
    '资金流水',
    ['日期', '项目', '收付', '类型', '金额', '对方', '支付方式', '备注'],
    db.funds
      .filter((f) => !f.deleted && (!projectId || f.project_id === projectId) && inRange(f.biz_date))
      .map((f) => [
        f.biz_date,
        projectName(f.project_id),
        f.direction === 'in' ? '收' : '付',
        f.biz_type,
        fmtMoney(f.amount),
        f.partner,
        f.pay_method,
        f.remark,
      ]),
  );
  const costSheets: Array<[string, CostType, string[]]> = [
    ['人工', 'labor', ['日期', '项目', '姓名', '工日数', '日工价', '金额', '备注']],
    ['材料', 'material', ['日期', '项目', '材料', '数量', '单位', '单价', '金额', '供应商', '备注']],
    ['机械', 'machine', ['日期', '项目', '设备', '计量方式', '数量', '单价', '金额', '出租方', '备注']],
    ['杂费', 'misc', ['日期', '项目', '小类', '金额', '备注']],
    ['垫付', 'advance', ['日期', '项目', '垫付人', '金额', '事由', '备注']],
  ];
  costSheets.forEach(([title, type, headers]) => {
    const rows = db.costs.filter(
      (c) => !c.deleted && c.type === type && (!projectId || c.project_id === projectId) && inRange(c.biz_date),
    );
    csv += csvBlock(
      title,
      headers,
      rows.map((c) => {
        const base = [c.biz_date, projectName(c.project_id)];
        if (type === 'labor') {
          return [...base, c.worker_name, c.work_days, fmtMoney(c.day_rate), fmtMoney(c.amount), c.remark];
        }
        if (type === 'material') {
          return [...base, c.material_name, c.quantity, c.unit, fmtMoney(c.unit_price), fmtMoney(c.amount), c.supplier, c.remark];
        }
        if (type === 'machine') {
          return [...base, c.machine_name, c.measure, c.quantity, fmtMoney(c.unit_price), fmtMoney(c.amount), c.lessor, c.remark];
        }
        if (type === 'misc') return [...base, c.category, fmtMoney(c.amount), c.remark];
        return [...base, c.payer, fmtMoney(c.amount), c.purpose, c.remark];
      }),
    );
  });
  csv += csvBlock(
    '应收',
    ['日期', '项目', '类型', '对方', '金额', '已冲销', '未结', '状态'],
    db.arap
      .filter((a) => !a.deleted && a.type === 'receivable' && (!projectId || a.project_id === projectId) && inRange(a.biz_date))
      .map((a) => [
        a.biz_date,
        projectName(a.project_id),
        a.biz_type,
        a.partner,
        fmtMoney(a.amount),
        fmtMoney(a.settled_amount),
        fmtMoney(arapUnsettled(a)),
        a.status,
      ]),
  );
  csv += csvBlock(
    '应付',
    ['日期', '项目', '类型', '对方', '金额', '已冲销', '未结', '状态'],
    db.arap
      .filter((a) => !a.deleted && a.type === 'payable' && (!projectId || a.project_id === projectId) && inRange(a.biz_date))
      .map((a) => [
        a.biz_date,
        projectName(a.project_id),
        a.biz_type,
        a.partner,
        fmtMoney(a.amount),
        fmtMoney(a.settled_amount),
        fmtMoney(arapUnsettled(a)),
        a.status,
      ]),
  );
  csv += csvBlock(
    '库存',
    ['项目', '材料', '单位', '入库合计', '领用合计', '余量'],
    db.invTxns
      .filter((t) => !t.deleted && (!projectId || t.project_id === projectId))
      .reduce<Array<[number, string, string]>>((acc, t) => {
        if (!acc.some(([pid, m, u]) => pid === t.project_id && m === t.material_name && u === t.unit)) {
          acc.push([t.project_id, t.material_name, t.unit]);
        }
        return acc;
      }, [])
      .map(([pid, material, unit]) => {
        const rows = db.invTxns.filter(
          (t) => !t.deleted && t.project_id === pid && t.material_name === material && t.unit === unit,
        );
        const inQty = rows.filter((r) => r.txn_type === 'in').reduce((s, r) => s + toScaled(r.quantity, 3), 0) / 1000;
        const outQty = rows.filter((r) => r.txn_type === 'out').reduce((s, r) => s + toScaled(r.quantity, 3), 0) / 1000;
        return [projectName(pid), material, unit, inQty, outQty, inventoryBalanceOf(pid, material, unit)];
      }),
  );
  csv += csvBlock(
    '人工结算',
    ['项目', '姓名', '总工天', '应付金额', '已发金额', '未发', '状态', '结算日期', '发放日期', '发放方式'],
    db.settles
      .filter((s) => !projectId || s.project_id === projectId)
      .map((s) => [
        projectName(s.project_id),
        s.worker_name,
        s.total_days,
        fmtMoney(s.amount_due),
        fmtMoney(s.paid_amount),
        fmtMoney(subMoney(s.amount_due, s.paid_amount)),
        s.status,
        s.settle_date,
        s.pay_date,
        s.pay_method,
      ]),
  );

  const buffer = new TextEncoder().encode(`\ufeff${csv}`).buffer;
  return {
    status: 200,
    body: buffer,
    file: {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="pims-mock-export.csv"`,
        'x-mock-export': 'csv',
      },
    },
  };
}

/* ------------------------------ 总调度 ------------------------------ */

export function handleRequest(req: MockRequest): MockResult {
  const key = `${req.method} ${req.path}`;

  if (!PUBLIC_PATHS.has(key) && !loggedIn()) {
    return fail(401, '未登录或会话已过期');
  }

  const result =
    handleAuth(req) ??
    handleSystem(req) ??
    handleDict(req) ??
    handleProjects(req) ??
    handleFunds(req) ??
    handleArAp(req) ??
    handleCosts(req) ??
    handleInventory(req) ??
    handleLabor(req) ??
    handleDashboard(req) ??
    handleLogs(req) ??
    (req.method === 'GET' && req.path === '/export/excel' ? handleExport(req) : null);

  if (!result) return fail(404, `Mock 未实现的接口：${key}`);
  return result;
}
