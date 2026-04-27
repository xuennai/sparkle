import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
// https://github.com/vdesjs/vite-plugin-monaco-editor/issues/21#issuecomment-1827562674
import monacoEditorPluginModule from 'vite-plugin-monaco-editor'
import tailwindcss from '@tailwindcss/vite'

const isObjectWithDefaultFunction = (
  module: unknown
): module is { default: typeof monacoEditorPluginModule } =>
  module != null &&
  typeof module === 'object' &&
  'default' in module &&
  typeof module.default === 'function'
const monacoEditorPlugin = isObjectWithDefaultFunction(monacoEditorPluginModule)
  ? monacoEditorPluginModule.default
  : monacoEditorPluginModule

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true
    }
  },
  preload: {
    build: {
      externalizeDeps: true
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          floating: resolve('src/renderer/floating.html'),
          traymenu: resolve('src/renderer/traymenu.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      tailwindcss(),
      monacoEditorPlugin({
        languageWorkers: ['editorWorkerService', 'typescript', 'css'],
        customDistPath: (_, out) => `${out}/monacoeditorwork`,
        customWorkers: [
          {
            label: 'yaml',
            entry: 'monaco-yaml/yaml.worker'
          }
        ]
      })
    ],
    /**
     * 开发服务器配置：缓解 ERR_NETWORK_CHANGED 问题
     *
     * 当 mihomo 核心启动/停止修改系统代理时，Chromium 会检测到网络变化
     * 并取消所有正在进行的 HTTP 请求，导致 Vite 模块加载失败。
     * 以下配置优化了 HMR 行为以应对此场景。
     */
    server: {
      // 固定使用 IPv4 回环地址，避免主机名解析导致的网络变化误判
      host: '127.0.0.1',
      // 信任所有来源的 WebSocket 连接，确保 HMR 在代理切换后能重连
      allowedHosts: true,
      hmr: {
        // 关闭错误覆盖层，避免模块加载失败时弹出烦人的全屏错误提示
        overlay: false
      },
      watch: {
        // 禁用文件监视器中的网络相关检查，减少代理切换时的干扰
        ignored: ['**/node_modules/**', '**/.git/**']
      }
    }
  }
})
