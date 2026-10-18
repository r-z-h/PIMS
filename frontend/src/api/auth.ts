/** 认证与系统接口 —— docs/03-接口设计.md 第 2 节 */
import { http } from './client';
import type {
  AuthStatus,
  BackupResult,
  LoginResult,
  SecurityQuestionItem,
  SecurityQuestions,
  SecurityTicket,
} from '../types/domain';

/**
 * GET /api/auth/status 的并发去重：
 * 路由守卫与登录页都会在挂载时问一次系统状态（React StrictMode 还会双跑 effect），
 * 共享同一个在途 Promise，避免一次页面加载打 4 次 status。
 * 只合并「在途」请求，resolve 后立即失效，不引入过期状态。
 */
let statusInFlight: Promise<AuthStatus> | null = null;

export const authApi = {
  /** 查询系统状态：是否已登录、是否需要初始化密保、是否仍是初始密码 */
  status(): Promise<AuthStatus> {
    if (!statusInFlight) {
      statusInFlight = http
        .get<AuthStatus>('/auth/status', undefined, { skipAuthRedirect: true, skipErrorToast: true })
        .finally(() => {
          statusInFlight = null;
        });
    }
    return statusInFlight;
  },

  login(password: string): Promise<LoginResult> {
    return http.post<LoginResult>('/auth/login', { password }, { skipAuthRedirect: true });
  },

  logout(): Promise<{ logged_in: boolean }> {
    return http.post<{ logged_in: boolean }>('/auth/logout');
  },

  /** 取 3 个密保问题（不含答案） */
  securityQuestions(): Promise<SecurityQuestions> {
    return http.get<SecurityQuestions>('/auth/security-questions', undefined, { skipErrorToast: true });
  },

  /** 校验 3 个密保答案；全对返回临时票据 */
  verifySecurity(answers: string[]): Promise<SecurityTicket> {
    return http.post<SecurityTicket>(
      '/auth/security/verify',
      { answers },
      { skipErrorToast: true, skipAuthRedirect: true },
    );
  },

  /** 首次设置 3 组密保问题与答案 */
  setupSecurity(questions: SecurityQuestionItem[]): Promise<{ security_ready: boolean }> {
    return http.post<{ security_ready: boolean }>('/auth/security/setup', { questions });
  },

  /** 修改密码：口径见 00-需求冻结 FR-1.3 —— 必须 3 个密保全对 */
  changePassword(payload: {
    new_password: string;
    answers: string[];
    old_password?: string;
  }): Promise<{ changed: boolean }> {
    return http.post<{ changed: boolean }>('/auth/password/change', payload, { skipErrorToast: true });
  },

  /** 忘记密码：密保全对 → 重置为新密码 */
  resetPassword(payload: { ticket: string; new_password: string }): Promise<{ reset: boolean }> {
    return http.post<{ reset: boolean }>('/auth/password/reset', payload);
  },
};

export const systemApi = {
  /** 备份数据库文件 */
  backup(): Promise<BackupResult> {
    return http.post<BackupResult>('/system/backup');
  },
};
