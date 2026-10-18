/**
 * 全局状态（Zustand）：只存登录态、当前项目、时间段筛选、字典缓存、显示已删除开关。
 * docs/01-开发手册.md 1.1：状态只存这几样，业务数据一律实时拉取。
 */
import { create } from 'zustand';
import type { DateRange, DictItem, DictType, Project } from '../types';
import { dictApi } from '../api/dict';
import { projectApi } from '../api/projects';
import { resetSessionGuard } from '../api/client';

const PROJECT_KEY = 'pims.current_project_id';
const RANGE_KEY = 'pims.date_range';
const SHOW_DELETED_KEY = 'pims.show_deleted';
const PROJECT_DATE_FIELD_KEY = 'pims.project_date_field';
const SESSION_HINT_KEY = 'pims.session_hint';

/**
 * 「本机登录过」标记 —— **仅用于登录页的提示文案，不参与任何跳转/渲染判定**。
 *
 * 会话判定以 `GET /api/auth/status` 的 `logged_in` 为准（后端已按「本请求 Cookie 是否有效」返回，
 * 见 backend/app/services/auth_service.py 与 tests/test_01_auth.py 的回归用例）；
 * 这里不再拿它当闸门 —— 用它挡人会让「浏览器数据被清、但 Cookie 仍有效」的用户被迫重输密码。
 *
 * 写入时机：显式登录成功（confirmLogin）；清除时机：被 401 拒绝（markSessionExpired）、退出登录（reset）。
 * 于是「本机登录过 + 服务端说不认」恰好等价于「会话失效」，可据此在登录页给出明确提示。
 */
export function hasSessionHint(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSessionHint(): void {
  try {
    window.localStorage.setItem(SESSION_HINT_KEY, '1');
  } catch {
    /* 隐私模式忽略 */
  }
}

export function clearSessionHint(): void {
  try {
    window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 项目列表日期筛选口径（与后端 date_field 对齐） */
export type ProjectDateField = 'start_date' | 'activity';

interface AppState {
  /* 登录态 */
  loggedIn: boolean | null;
  securityReady: boolean;
  isInitialPassword: boolean;
  authLoaded: boolean;
  /** 服务端已明确拒绝本机会话（401）：此时必须停止取数与跳转 */
  sessionExpired: boolean;
  /** 写入服务端回报的登录态（来自 /auth/status 探测，**不**代表本机持有有效会话） */
  setAuth: (payload: {
    logged_in: boolean;
    security_ready: boolean;
    is_initial_password: boolean;
  }) => void;
  /** 本机显式登录成功（登录 / 密保保存）：写入登录痕迹并解除 401 闩锁 */
  confirmLogin: (payload: { security_ready: boolean; is_initial_password: boolean }) => void;
  /** 401 时调用：清掉本机登录痕迹并锁死跳转，直到下次登录成功 */
  markSessionExpired: () => void;
  /** 仅在已确认登录时可以取数 */
  canFetch: () => boolean;

  /* 当前项目（顶部项目选择器） */
  currentProjectId: number | null;
  setCurrentProjectId: (id: number | null) => void;

  /* 时间段筛选（顶部时间段选择器） */
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;

  /**
   * 项目列表的日期按什么筛（2026-10-17 用户需求「按名字和日期筛项目」）。
   *   start_date = 开工日期落在区间内
   *   activity   = 区间内有业务数据（成本/收付款/往来/入库/结算）
   * 项目列表与首页共用这一个值，两处口径永远一致。
   */
  projectDateField: ProjectDateField;
  setProjectDateField: (field: ProjectDateField) => void;

  /* 显示已删除记录开关（设置页） */
  showDeleted: boolean;
  setShowDeleted: (value: boolean) => void;

  /* 字典缓存 */
  dicts: Partial<Record<DictType, DictItem[]>>;
  dictLoading: Partial<Record<DictType, boolean>>;
  loadDict: (type: DictType, force?: boolean) => Promise<DictItem[]>;

  /* 项目列表缓存（顶部选择器与各页面共用一份） */
  projects: Project[];
  projectsLoading: boolean;
  projectsLoaded: boolean;
  loadProjects: (force?: boolean) => Promise<Project[]>;

  reset: () => void;
}

function readProjectId(): number | null {
  const raw = window.localStorage.getItem(PROJECT_KEY);
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readRange(): DateRange {
  const raw = window.localStorage.getItem(RANGE_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as DateRange;
      return { start_date: parsed.start_date, end_date: parsed.end_date };
    } catch {
      /* 解析失败则回落到默认今年 */
    }
  }
  // 默认今年（docs/01-开发手册.md 5.2）
  const year = new Date().getFullYear();
  return { start_date: `${year}-01-01`, end_date: `${year}-12-31` };
}

function readShowDeleted(): boolean {
  return window.localStorage.getItem(SHOW_DELETED_KEY) === '1';
}

/** 项目列表「日期按什么筛」：默认按"有业务数据"（老板更常问"这段时间哪些项目在动"） */
function readProjectDateField(): ProjectDateField {
  const raw = window.localStorage.getItem(PROJECT_DATE_FIELD_KEY);
  return raw === 'start_date' ? 'start_date' : 'activity';
}

export const useAppStore = create<AppState>((set, get) => ({
  loggedIn: null,
  securityReady: false,
  isInitialPassword: false,
  authLoaded: false,
  sessionExpired: false,

  setAuth: ({ logged_in, security_ready, is_initial_password }) =>
    set({
      loggedIn: logged_in,
      securityReady: security_ready,
      isInitialPassword: is_initial_password,
      authLoaded: true,
    }),

  confirmLogin: ({ security_ready, is_initial_password }) => {
    // 只有本机真正登录成功才留痕、才解除 401 闩锁
    setSessionHint();
    resetSessionGuard();
    set({
      loggedIn: true,
      securityReady: security_ready,
      isInitialPassword: is_initial_password,
      authLoaded: true,
      sessionExpired: false,
    });
  },

  markSessionExpired: () => {
    clearSessionHint();
    set({ sessionExpired: true, loggedIn: false, authLoaded: true, projects: [], projectsLoaded: false, dicts: {} });
  },

  canFetch: () => get().loggedIn === true && !get().sessionExpired,

  currentProjectId: readProjectId(),
  setCurrentProjectId: (id) => {
    if (id) window.localStorage.setItem(PROJECT_KEY, String(id));
    else window.localStorage.removeItem(PROJECT_KEY);
    set({ currentProjectId: id });
  },

  projectDateField: readProjectDateField(),
  setProjectDateField: (field) => {
    window.localStorage.setItem(PROJECT_DATE_FIELD_KEY, field);
    set({ projectDateField: field });
  },

  dateRange: readRange(),
  setDateRange: (range) => {
    window.localStorage.setItem(RANGE_KEY, JSON.stringify(range));
    set({ dateRange: range });
  },

  showDeleted: readShowDeleted(),
  setShowDeleted: (value) => {
    window.localStorage.setItem(SHOW_DELETED_KEY, value ? '1' : '0');
    set({ showDeleted: value });
  },

  dicts: {},
  dictLoading: {},

  loadDict: async (type, force = false) => {
    // 未确认登录前一律不发请求（防未登录取数风暴）
    if (!get().canFetch()) return get().dicts[type] ?? [];
    const cached = get().dicts[type];
    if (cached && !force) return cached;
    set((state) => ({ dictLoading: { ...state.dictLoading, [type]: true } }));
    try {
      const items = await dictApi.list(type);
      set((state) => ({ dicts: { ...state.dicts, [type]: items } }));
      return items;
    } finally {
      set((state) => ({ dictLoading: { ...state.dictLoading, [type]: false } }));
    }
  },

  reset: () => {
    clearSessionHint();
    resetSessionGuard();
    set({
      loggedIn: false,
      securityReady: false,
      isInitialPassword: false,
      authLoaded: true,
      sessionExpired: false,
      dicts: {},
      projects: [],
      projectsLoaded: false,
    });
  },

  projects: [],
  projectsLoading: false,
  projectsLoaded: false,

  loadProjects: async (force = false) => {
    // 未确认登录前一律不发请求（防未登录取数风暴）
    if (!get().canFetch()) return get().projects;
    if (get().projectsLoaded && !force) return get().projects;
    set({ projectsLoading: true });
    try {
      const data = await projectApi.list({ page: 1, page_size: 200 });
      const items = data.items ?? [];
      set({ projects: items, projectsLoaded: true });
      return items;
    } catch {
      // 401 等错误由响应拦截器统一处理，这里不让 Promise 变成未捕获拒绝
      return get().projects;
    } finally {
      set({ projectsLoading: false });
    }
  },
}));
