import 'axios';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 为 true 时响应拦截器不弹 message.error（页面自行提示） */
    skipErrorToast?: boolean;
    /** 为 true 时跳过 401/403 的自动跳转（登录/密保流程使用） */
    skipAuthRedirect?: boolean;
  }
}
