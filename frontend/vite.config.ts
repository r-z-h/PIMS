import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// PIMS 前端开发服务器：/api 代理到本地 FastAPI（127.0.0.1:8000）
// VITE_USE_MOCK=true 时挂载本地 Mock 适配器；生产构建下该开关为编译期常量 false，
// Rollup 会直接删除 mock 分支，假数据不会进入产物、也不会进入真实请求路径。
export default defineConfig(({ mode }) => {
  // envDir 用相对路径，避免依赖 @types/node 里的 process.cwd()
  const env = loadEnv(mode, '.', '');
  const useMock = String(env.VITE_USE_MOCK ?? 'false').toLowerCase() === 'true';
  // 代理目标默认 127.0.0.1:8000；多人并行联调时可用 VITE_API_TARGET 指向别的后端实例
  const apiTarget = env.VITE_API_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [react()],
    define: {
      __PIMS_USE_MOCK__: JSON.stringify(useMock),
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
      watch: {
        // 忽略编辑器/工具产生的临时目录，避免 watcher 因 EBUSY 崩溃
        ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/.git/**'],
      },
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1600,
    },
  };
});
