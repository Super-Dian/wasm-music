import fs from "fs";
import path from "path";
import process from "process";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { defineConfig } from "vite";
import monkey, { cdn, util } from "vite-plugin-monkey";

import { version, displayName, description, author } from "./package.json";
const pathSrc = path.resolve(__dirname, "src");
const rootDir = process.cwd();

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    AutoImport({
      dts: true,
      imports: ["vue"],
    }),
    Components({
      dts: true,
      dirs: ["src/steps", "src/components"],
      // 不要自定义 include：自定义值会替换插件默认的
      // [ /\.vue$/, /\.vue\?vue/, /\.vue\?v=/ ]，导致生产构建中带查询串的
      // TS SFC 子请求（Foo.vue?vue&type=script&lang.ts）匹配失败、组件注入失效
    }),
    {
      name: "replace-url",
      apply: "build",
      transform(code, id) {
        if (id.includes("@ffmpeg/ffmpeg/dist/esm/classes.js")) {
          // this will prevent vite create chunk for worker.js
          const header = `import MyWorker from '@ffmpeg/ffmpeg/worker?worker&inline';\n`;
          return (
            header +
            code.replace(`new Worker(new URL("./worker.js", import.meta.url), `, `new MyWorker(`)
          );
        }
      },
    },
    monkey({
      entry: "src/main.ts",
      format: {
        generate(uOptions) {
          if (uOptions.mode === "build") {
            const filePath = path.join(rootDir, "update.log");
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const lines = fileContent.trim().split("\n");
            const lastTenLines = lines.slice(-30);
            const log = lastTenLines
              .reverse()
              .map((line) => `// ${line}`)
              .join("\n");
            return (
              uOptions.userscript +
              `\n\n// 更新日志[只显示最新的10条,🌟🤡 分别代表新功能和bug修复]\n${log}`
            );
          } else {
            return uOptions.userscript;
          }
        },
      },
      userscript: {
        name: displayName,
        version,
        description,
        author,
        grant: ["unsafeWindow"],
        "run-at": "document-start",
        icon: "https://static.hdslb.com/images/favicon.ico",
        namespace: "https://github.com/Ocyss/wasm-music",
        homepage: "https://github.com/Ocyss/wasm-music",
        match: [
          "https://www.bilibili.com/video/*",
          "https://www.bilibili.com/list/*",
          "*://www.bilibili.com",
        ],
        connect: [
          "api.bilibili.com",
          "bilibili.com",
          "hdslb.com",
          "mxnzp.com",
          "bilivideo.com",
          "api.vkeys.cn",
        ],
        downloadURL: "https://update.greasyfork.org/scripts/498677.user.js",
        updateURL: "https://update.greasyfork.org/scripts/498677.user.js",
      },
      build: {
        externalGlobals: {
          vue: cdn
            .jsdelivr("Vue", "dist/vue.global.prod.js")
            .concat(util.dataUrl(";window.Vue=Vue;")),
        },
      },
      server: {
        prefix: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": pathSrc,
    },
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "UNUSED_EXTERNAL_IMPORT") return;
        if (warning.message.includes("resolveComponent")) return;
        warn(warning);
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
