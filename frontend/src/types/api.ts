/**
 * 通用接口类型 —— 与 docs/03-接口设计.md 第 1 节「通用约定」对齐。
 */

/** 金额：接口允许字符串或数字，前端一律按两位小数处理，禁止浮点累加 */
export type Money = number | string;

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

/** 列表响应体：{ total, page, page_size, items } */
export interface PageResult<T> {
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

/** 通用查询参数（03-接口设计 1.4） */
export interface ListQuery {
  page?: number;
  page_size?: number;
  project_id?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  keyword?: string | null;
  include_deleted?: boolean;
}

/** 时间段筛选（DateRangeBar 传出） */
export interface DateRange {
  start_date?: string;
  end_date?: string;
}

/** 业务错误：响应拦截器 code !== 0 时抛出，页面可按 code 分支处理 */
export class ApiError extends Error {
  code: number;

  constructor(code: number, msg: string) {
    super(msg);
    this.name = 'ApiError';
    this.code = code;
  }
}
