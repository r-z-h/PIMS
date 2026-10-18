/**
 * Mock 适配器：把 axios 的请求在本地按 docs/03-接口设计.md 契约应答。
 * 只在 VITE_USE_MOCK=true 时被 src/api/client.ts 动态 import —— 真实请求路径不引用本目录。
 */
import type { AxiosAdapter, AxiosRequestConfig, AxiosResponse } from 'axios';
import { httpClient } from '../client';
import { handleRequest, type MockRequest, type MockResult } from './handlers';
import { db, persist, resetMockDB } from './store';

type QueryValue = string | number | boolean | undefined | null;

function readPathAndParams(config: AxiosRequestConfig): { path: string; params: Record<string, QueryValue> } {
  const url = config.url ?? '';
  const baseURL = config.baseURL ?? '';
  let full = url;
  if (!/^https?:\/\//i.test(url)) {
    full = `${baseURL}${url}`;
  }
  const [rawPath, rawQuery = ''] = full.split('?');
  const path = rawPath.replace(/^\/api/, '') || '/';

  const params: Record<string, QueryValue> = {};
  new URLSearchParams(rawQuery).forEach((value, key) => {
    params[key] = value;
  });
  Object.entries(config.params ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params[key] = value as QueryValue;
  });
  return { path, params };
}

function readBody(data: unknown): Record<string, unknown> {
  if (!data) return {};
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof data === 'object') return data as Record<string, unknown>;
  return {};
}

function buildResponse(config: AxiosRequestConfig, result: MockResult): AxiosResponse {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(result.file?.headers ?? {}) };
  return {
    data: result.body,
    status: result.status,
    statusText: result.status === 200 ? 'OK' : 'Mock Error',
    headers,
    config: config as AxiosResponse['config'],
  };
}

export function createMockAdapter(): AxiosAdapter {
  return async (config) => {
    const { path, params } = readPathAndParams(config);
    const request: MockRequest = {
      method: (config.method ?? 'get').toUpperCase(),
      path,
      params,
      body: readBody(config.data),
    };

    const result = handleRequest(request);
    persist();

    // 模拟网络延迟，便于观察 loading 状态
    await new Promise((resolve) => {
      window.setTimeout(resolve, 60);
    });

    if (result.status >= 400) {
      const error = Object.assign(new Error(String((result.body as { message?: string })?.message ?? 'mock error')), {
        isAxiosError: true,
        config,
        response: buildResponse(config, result),
        toJSON: () => ({}),
      });
      throw error;
    }

    return buildResponse(config, result);
  };
}

/** 开发便利：控制台执行 window.__PIMS_MOCK__ 查看/重置本地 mock 数据 */
export function exposeMockConsole(): void {
  Object.defineProperty(window, '__PIMS_MOCK__', {
    value: {
      db,
      reset: () => {
        resetMockDB();
        window.location.reload();
      },
    },
    configurable: true,
  });
}

/** 把 mock 适配器挂到 axios 实例上（仅 VITE_USE_MOCK=true 时被调用） */
export function installMockAdapter(): void {
  httpClient.defaults.adapter = createMockAdapter();
  exposeMockConsole();
}
