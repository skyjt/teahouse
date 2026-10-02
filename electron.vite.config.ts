import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 红线（README）：渲染层基线 Chrome 108，主进程/preload 基线 Node 16.17 —— Electron 22 焊死。
// 构建目标写死在这里，越线语法在编译期直接失败。
// externalizeDepsPlugin：依赖（尤其 native 的 better-sqlite3）不打进 bundle，运行时从 node_modules 加载。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { target: 'node16' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { target: 'node16' }
  },
  renderer: {
    build: {
      target: 'chrome108',
      manifest: true,
      minify: 'esbuild',
      assetsInlineLimit(file) {
        // 单色品牌图标独立输出，避免 SVG 缩小后内联导致主窗静态 JS 超预算。
        if (file.endsWith('/assets/brand/icon-macos-menubar-outline.svg')) return false
        // 本地 emoji SVG 由 img 按需读取，避免把全部图形数据解析进每个窗口的 JS 闭包。
        if (file.includes('/assets/twemoji/') && file.endsWith('.svg')) return false
      }
    },
    plugins: [
      vue(),
      {
        // onnxruntime-web 的 bundle 版用 new URL 触发 vite 又复制一份 ~11MB 的 wasm 到 assets/，
        // 但运行时我们用 env.wasm.wasmPaths 指向 public/ocr/ 那份（file:// 下最可靠，同 tesseract 机制），
        // assets/ 这份纯冗余，打包时删掉省体积。
        name: 'pantry-drop-bundled-ort-wasm',
        generateBundle(_options, bundle) {
          for (const fileName of Object.keys(bundle)) {
            if (/ort-wasm.*\.wasm$/.test(fileName)) delete bundle[fileName]
          }
        }
      }
    ]
  }
})
