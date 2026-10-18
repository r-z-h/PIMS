/**
 * axios 实例 —— docs/03-接口设计.md 第 13 节「前端调用约定」。
 * - baseURL '/api'，withCredentials: true
 * - 响应拦截：code === 0 直接返回 data；否则 message.error 弹出；401 跳登录页，403 跳密保页
 * - VITE_USE_MOCK=true 时挂载本地 mock 适配器（真实请求路径不含任何假数据）
 */
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { message } from 'antd';
import { ApiError } from '../types/api';

/** 构建期常量（vite.config.ts define） */
declare const __PIMS_USE_MOCK__: boolean;

/**
 * Mock 开关：编译期常量。生产构建为 false 时，
 * 调用处的 `if (USE_MOCK)` 分支会被 Rollup 直接删除，mock 代码不进产物。
 */
export const USE_MOCK: boolean = __PIMS_USE_MOCK__;

interface AuthRedirectHandlers {
  onUnauthorized?: () => void;
  onForbidden?: () => void;
  /** 会话被服务端拒绝（401）时回调：用于清掉「本机已登录」标记并锁定跳转 */
  onSessionExpired?: () => void;
}

let redirectHandlers: AuthRedirectHandlers = {};

export function registerAuthRedirectHandlers(handlers: AuthRedirectHandlers): void {
  redirectHandlers = handlers;
}

/**
 * 会话失效闩锁：一旦服务端明确回 401，就认定本浏览器会话已失效。
 * 闩锁打开期间不再重复弹窗、不再重复跳转，也不再自动重试 —— 这是防「跳转→取数→再 401」死循环的关键。
 * 只有登录成功时才由 resetSessionGuard() 复位。
 */
let sessionRejected = false;

export function isSessionRejected(): boolean {
  return sessionRejected;
}

export function resetSessionGuard(): void {
  sessionRejected = false;
}

/** 相同文案的 toast 在窗口期内只弹一次（未登录是正常状态，不该刷屏） */
const TOAST_DEDUPE_MS = 4000;
let lastToastKey = '';
let lastToastAt = 0;

function notifyError(key: string, text: string): void {
  const now = Date.now();
  if (key === lastToastKey && now - lastToastAt < TOAST_DEDUPE_MS) return;
  lastToastKey = key;
  lastToastAt = now;
  void message.error(text);
}

export const httpClient: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 30000,
});

const AUTH_PATHS = ['/login', '/security-setup', '/forgot-password'];

function currentPath(): string {
  return window.location.pathname;
}

function redirectTo(url: string): void {
  if (currentPath() === url) return;
  if (redirectHandlers.onUnauthorized && url === '/login') {
    redirectHandlers.onUnauthorized();
    return;
  }
  if (redirectHandlers.onForbidden && url === '/security-setup') {
    redirectHandlers.onForbidden();
    return;
  }
  window.location.href = url;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: '参数校验失败',
  401: '未登录或会话已过期，请重新登录',
  403: '密保答案不正确',
  404: '对象不存在',
  409: '业务冲突',
  500: '服务端异常，请查看后端日志',
};

function buildError(code: number, msg: string, config?: AxiosRequestConfig): ApiError {
  const text = msg || DEFAULT_MESSAGES[code] || '请求失败';
  const skipToast = Boolean(config?.skipErrorToast);
  const skipRedirect = Boolean(config?.skipAuthRedirect);
  const onAuthPage = AUTH_PATHS.includes(currentPath());

  if (code === 401) {
    // 已判定失效：静默返回，避免每个并发请求都弹一条、都跳一次
    if (sessionRejected) return new ApiError(code, text);
    sessionRejected = true;
    redirectHandlers.onSessionExpired?.();
    if (!skipToast) notifyError(`401:${text}`, text);
    if (!skipRedirect && !onAuthPage) redirectTo('/login');
  } else if (code === 403) {
    if (!skipToast) notifyError(`403:${text}`, text);
    // 登录/密保页内的 403（例如密保答案不正确）不跳转，避免死循环
    if (!skipRedirect && !onAuthPage) redirectTo('/security-setup');
  } else if (!skipToast) {
    notifyError(`${code}:${text}`, text);
  }
  return new ApiError(code, text);
}

/** code === 0 时把 data 直接返回给业务层 */
const unwrapResponse = ((response: AxiosResponse) => {
  const responseType = response.config.responseType;
  if (responseType === 'blob' || responseType === 'arraybuffer') return response;

  const body = response.data as unknown;
  if (body && typeof body === 'object' && 'code' in (body as Record<string, unknown>)) {
    const envelope = body as { code: number; message?: string; data?: unknown };
    if (envelope.code === 0) return envelope.data as unknown as AxiosResponse;
    return Promise.reject(
      buildError(envelope.code, envelope.message ?? '', response.config),
    ) as unknown as AxiosResponse;
  }
  return body as unknown as AxiosResponse;
}) as (response: AxiosResponse) => AxiosResponse;

const handleRejected = (error: unknown): Promise<never> => {
  const axiosError = error as {
    response?: { status?: number; data?: { code?: number; message?: string } };
    config?: AxiosRequestConfig;
    message?: string;
  };
  if (!axiosError.response) {
    void message.error('无法连接后端服务：请确认 uvicorn 已启动，或开启 VITE_USE_MOCK');
    return Promise.reject(new ApiError(0, axiosError.message ?? '网络异常'));
  }
  const body = axiosError.response.data;
  const status = axiosError.response.status ?? 0;
  const code = typeof body?.code === 'number' ? body.code : status;

  // 项目完工锁（2026-10-17）：交给上层弹密码框，解锁成功后**自动重试原请求一次**。
  // 只重试一次（`_lockRetried`），避免"解了又锁"造成死循环。
  const locked = isProjectLockedError(body);
  const config = axiosError.config as (AxiosRequestConfig & { _lockRetried?: boolean }) | undefined;
  if (locked && projectLockHandler && config && !config._lockRetried) {
    if (!pendingLock) {
      pendingLock = projectLockHandler(locked).finally(() => {
        pendingLock = null;
      });
    }
    return pendingLock.then((unlocked) => {
      if (!unlocked) return Promise.reject(buildError(code, body?.message ?? '', config));
      config._lockRetried = true;
      // 重试：解锁后同一个请求应当直接通过
      return httpClient.request(config);
    });
  }

  return Promise.reject(buildError(code, body?.message ?? '', axiosError.config));
};

httpClient.interceptors.response.use(unwrapResponse, handleRejected);

/** 去掉空查询参数，避免提交 keyword= / project_id= 这类空值 */
export function cleanParams<T extends Record<string, unknown>>(params: T): Partial<T> {
  const result: Partial<T> = {};
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    result[key as keyof T] = value as T[keyof T];
  });
  return result;
}

/**
 * 项目完工锁（2026-10-17 需求）：写操作被 409 拦下时，交给上层弹密码框。
 *
 * 放在 client 这一层的原因：完工锁要拦**所有**写操作（成本/流水/往来/冲销/
 * 结算/库存/项目档案…），逐个页面写提示必然漏。这里统一兜住：
 * 后端返回 `data.reason === 'project_locked'` → 调注册进来的处理器 → 拿到解锁结果后**自动重试原请求**。
 */
export interface ProjectLockInfo {
  projectId: number;
  message: string;
}

/** 处理器返回 true 表示"已解锁，可以重试"；false 表示用户放弃 */
type ProjectLockHandler = (info: ProjectLockInfo) => Promise<boolean>;

let projectLockHandler: ProjectLockHandler | null = null;
/** 正在处理的锁定（避免一次批量操作弹出多个密码框） */
let pendingLock: Promise<boolean> | null = null;

export function registerProjectLockHandler(handler: ProjectLockHandler | null): void {
  projectLockHandler = handler;
}

function isProjectLockedError(body: unknown): { projectId: number; message: string } | null {
  const envelope = body as { code?: number; message?: string; data?: { reason?: string; project_id?: number } };
  if (!envelope || envelope.code !== 409) return null;
  if (envelope.data?.reason !== 'project_locked') return null;
  return { projectId: Number(envelope.data.project_id ?? 0), message: envelope.message ?? '项目已完工并锁定' };
}

export const http = {
  get<T>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig): Promise<T> {
    return httpClient.get(url, { params: params ? cleanParams(params) : undefined, ...config }) as unknown as Promise<T>;
  },
  post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return httpClient.post(url, data, config) as unknown as Promise<T>;
  },
  put<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return httpClient.put(url, data, config) as unknown as Promise<T>;
  },
  delete<T>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig): Promise<T> {
    return httpClient.delete(url, { params: params ? cleanParams(params) : undefined, ...config }) as unknown as Promise<T>;
  },
  /** 文件流请求（导出），返回完整响应以便读取 Content-Disposition */
  download(url: string, params?: Record<string, unknown>): Promise<AxiosResponse<Blob>> {
    return httpClient.get(url, {
      params: params ? cleanParams(params) : undefined,
      responseType: 'blob',
      timeout: 120000,
    }) as unknown as Promise<AxiosResponse<Blob>>;
  },
};

/** 列表响应容错：后端可能返回数组，也可能返回 { items } */
export function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
    return (data as { items: T[] }).items;
  }
  return [];
}
