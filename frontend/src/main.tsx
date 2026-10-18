import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { USE_MOCK } from './api/client';
import './styles.css';

dayjs.locale('zh-cn');

/**
 * Mock 适配器只在开关打开时加载；`USE_MOCK` 是构建期常量（vite define），
 * 生产构建（VITE_USE_MOCK=false）下 Rollup 会删掉整个分支，本地假数据既不进产物也不进真实请求路径。
 *
 * 这里用「条件表达式 + then」而不是 top-level await：
 * 生产构建的目标是 es2020，不支持顶层 await，写成 `await import(...)` 会让
 * `vite build --mode development`（或任何打开 Mock 的构建）直接失败。
 * 同时把首屏渲染挂在 mockReady 之后，保证适配器装好之前不会发出任何请求。
 */
const mockReady: Promise<void> = USE_MOCK
  ? import('./api/mock').then((mock) => {
      mock.installMockAdapter();
      // eslint-disable-next-line no-console
      console.info('[PIMS] Mock 模式已开启：接口全部由 src/api/mock 本地应答，未请求后端。');
    })
  : Promise.resolve();

void mockReady.then(() => {
  const container = document.getElementById('root');
  if (!container) throw new Error('未找到 #root 挂载点');

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <ConfigProvider locale={zhCN}>
        <AntApp>
          <App />
        </AntApp>
      </ConfigProvider>
    </React.StrictMode>,
  );
});
