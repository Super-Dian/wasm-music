# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

bilibili-music is a Tampermonkey userscript that injects into Bilibili video pages to download audio with embedded cover art, ID3 tags, lyrics, and subtitles. It is NOT an Electron app — the Vue 3 app mounts directly into the host page's DOM.

## Commands

| Command             | Purpose                                |
| ------------------- | -------------------------------------- |
| `npm run dev`       | Start Vite dev server                  |
| `npm run build`     | Build the userscript (output: `dist/`) |
| `npm run build:tsc` | Type-check with vue-tsc, then build    |
| `npm run fmt`       | Format with oxfmt                      |
| `npm run lint`      | Lint with oxlint (type-aware)          |
| `npm run lint:fix`  | Auto-fix lint issues                   |

**Package manager**: npm. **Linter/formatter**: oxlint + oxfmt (Oxc toolchain, not ESLint/Prettier).

> 注：`npm run lint`（type-aware 模式）在部分环境会因 tsgolint 版本不匹配直接 panic（`unknown rule`，干净工作区同样复现），此时用 `npx oxlint <files>` 跑基础规则替代。

## Architecture

### Injection Model

- `src/main.ts` watches for `.bgm-tag` elements on Bilibili pages via `elmGetter` (MutationObserver). On detection, injects a download button. Clicking it mounts the Vue app into a `<div id="bilibili-music-vue">`.
- Uses Tampermonkey APIs: `GM_xmlhttpRequest` (cross-origin requests), `GM_getValue`/`GM_setValue` (persistent config), `GM_cookie`, `unsafeWindow` (access to page's Vue instance).

### Wizard Flow (5 Steps)

The app is a modal with a vertical steps sidebar:

1. **clip.vue** — Audio trimming (delete ranges, speed)
2. **info.vue** — Title/author/filename metadata with template placeholders
3. **cover.vue** — Cover art selection (video cover, music cover, UP avatar)
4. **lyrics.vue** — Lyrics selection, editing, online search, AI correction, smart correction + visual timeline editor（歌词工作台「时间轴」Tab）
5. **audio.vue** — FFmpeg WASM pipeline: fetch audio → transcode M4S→M4A → embed clip/speed/metadata/cover/lyrics → download via FileSaver

### State Management

No Vuex/Pinia. `src/data.ts` holds all wizard state in a single `reactive()` object (`fromData`) and a `userConfig` object persisted via GM_getValue/GM_setValue with auto-save on change.

Key `fromData` fields:

- `lyricsData: Lyrics | null` — `[timestamp_ms, text][]` pairs for audio embedding
- `clipRanges: ClipRanges | null` — `[[start_ms, end_ms], ...]` delete ranges
- `externalLyrics: boolean` — save lyrics as standalone `.lrc` file instead of embedding
- `speed: number` — playback speed multiplier
- `coverUrl: string | null` — cover image URL
- `usedefaultconfig: boolean` — auto-apply saved default rules

Key `userConfig` fields:

- `openai: { host, key, modal }` — OpenAI-compatible API for AI lyrics correction

### Auto-imports 与组件导入约定

- Vue APIs（`ref`、`computed`、`watch`、`nextTick` 等）由 `unplugin-auto-import` 自动导入 —— `.vue` 文件中**不要**写显式 Vue API import。
- **组件必须显式 import**（如 `import UiButton from "@/components/UiButton.vue"`）——这是全仓约定。历史上 `unplugin-vue-components` 的 `include: /.vue$/` 覆盖了插件默认值，导致生产构建中带查询串的 TS SFC 子请求（`Foo.vue?vue&type=script&lang.ts`）匹配失败：组件不注入、回退 `resolveComponent`，渲染成无样式的未知元素（**dev 正常、构建坏**；`vite.config` 的 onwarn 还静默了该警告）。include 已恢复插件默认，但显式导入仍是兜底惯例（unplugin 的正则仍不匹配自引用形式 `_resolveComponent("Name", true)!`）。
- `auto-imports.d.ts` / `components.d.ts` 为生成文件：构建时再生成、`fmt` 会重排其格式，属正常变更。

### Path Alias

`@` → `./src` (configured in both tsconfig and vite config).

### API Layer

`src/utils/requests.ts` wraps `GM_xmlhttpRequest` into a Promise-based API with automatic cookie injection. Bilibili APIs are called directly (no proxy server).

### WASM Backends

- **FFmpeg WASM** (`src/utils/ffmpeg.ts`): Primary audio processing. Loaded from unpkg CDN, with multi-thread support when `crossOriginIsolated`.
- **Rust WASM** (`backend/`): Earlier implementation for ID3 tag writing and WAV clipping via wasm-pack. Build with `cd backend && make build` (requires Rust + wasm-pack). The compiled output is patched to `@ocyss/wasm-music-backend`.

### Lyrics System (lyrics.vue + lyricsCorrector.ts)

**Online Lyrics Search** (two-step API):

- `onlineLyricsApis` defines search sources (currently LuoXueAPI at `api.vkeys.cn`).
- Step 1: `searchOnlineLyrics()` queries `?word=歌曲名` → returns `{ data: [{ id, name, singer }] }`（`singer` 与 `id` 同层级，可能是字符串或数组；候选下拉显示「歌名 - 歌手」，无 singer 时回退仅歌名）。
- Step 2: Watcher on `onlineLyricsIndex` fetches lyrics via `detailUrl + ?id=songId` → returns `{ data: { lrc } }`.
- `lyricsIdMap` caches `compositeKey → songId` mapping between steps.

**Lyrics Workshop Modal** (fullscreen):

- Left panel: editable textarea (`_editBody`) for the selected subtitle track. **时间轴 Tab 激活时左面板 `v-show` 收起**（右列全宽），由「显示文本面板」按钮切换；必须用 `v-show` 而非 `v-if`（保留 textarea 的 undo 栈）。左面板行数与时间轴行数不一致时实时 `UiAlert` 警告（口径与 `onTimelineCommit`/`next()` 的行数守恒一致）。
- Right panel tabs:
  - **在线歌词** — search, select, toggle formatting (timeAxis/blankChar/metaInfo/stripMeta), editable preview with diff view toggle, replace/undo/smart-correct buttons.
  - **AI 改写** — OpenAI-compatible API with custom prompt template (`{{onlineLyrics}}` placeholder). Strict typo correction only.
  - **结果预览** — final lyrics with ♪ note formatting.
  - **时间轴** — 可视化歌词时间轴编辑器（详见下方「Lyrics Timeline」节）。
- 已在在线模式（`useOnlineLyrics`）时**更换歌词源会自动重新应用**到左侧文本与时间轴（`watch(onlineLyricsIndex)` 拉取成功后触发；逐字源无 yrc 时仅警告）。

**Smart Correction** (`src/utils/lyricsCorrector.ts`):

- `correctLyrics(aiBody, onlineText)` — character-level diff correction.
- `cleanOriginalLyrics(text)` — strips LRC tags, metadata (`key:value`/`key-value` format), title lines (`歌名 - 歌手`).
- Algorithm: `diffChars(origText, aiText)` → reconstruct by keeping unchanged+removed, skipping added → split back into AI's original line boundaries.
- **Diff Normalization** (`normalizeDiffs`): Pre-processes diff results to handle four states:
  1. `unchanged` — unchanged characters (plain object)
  2. `changed` — removed + same-length added (paired)
  3. `removed` — pure deletion (no paired added)
  4. `added` — pure addition (no paired removed)
- **Pending Line Break Logic**: When `aiCharCount` reaches line boundary, waits for pending `removed` blocks before executing line break. Only pure `removed` (not `changed`) triggers pending behavior.

**Online Lyrics with Time Axis**:

- `parseLrcToLyrics(lrcText)` — parses LRC format into `Array<[ms, text]>` with time axis.
- "使用在线歌词" switch in lyrics workshop enables automatic replacement with online lyrics time axis.
- "第一句歌词开始时间" input (mm:ss format) allows adjusting the offset between video and online lyrics. 现为**相对当前首行的 delta 平移**（幂等、保留行级拖拽的相对编辑，不再从 pristine 快照整表重放）；超出歌曲时长会报错拦截（`getHostDurationMs()` 上界校验）。
- `useOnlineLyrics` flag controls: disables max-length validation, enables OK button, disables smart correction.

**External Lyrics** (`fromData.externalLyrics`):

- When enabled, `audio.vue` saves the LRC string as a standalone `.lrc` file via FileSaver instead of embedding in audio metadata.

### Audio Processing (audio.vue)

**FFmpeg Pipeline**:

- Cover embedding uses `-c:v copy` (not `-c:v mjpeg`) to avoid progressive JPEG decode hangs in single-thread WASM mode.
- `processLyrics()` adjusts timestamps: subtracts deleted clip ranges, applies speed multiplier, filters out lyrics in deleted ranges.
- `formatLrc(ms)` converts milliseconds to `[MM:SS.mmm]` format.
- LRC header: `[ti:...]`, `[ar:...]`, `[al:...]`, `[re:ocyss/wasm-music]`, `[url:...]`.

### Clip Timeline（剪辑时间轴）

- `src/steps/clip.vue` — 音频剪辑界面，支持区间删除、倍速、时间轴拖动
- 性能优化：鼠标移动使用 `requestAnimationFrame` 节流，避免高频 `mousemove` 导致卡顿
- 虚拟位置：`displayTime` ref 与 `video.currentTime` 解耦，由 `timeupdate` 事件驱动同步
- tooltip 复用对象引用，仅更新变化属性，减少 Vue 响应式开销

### Lyrics Timeline（歌词时间轴）

- `src/components/LyricsTimeline.vue` — 歌词工作台「时间轴」Tab 的可视化编辑器（约 1300 行，显式 import 四个 Ui 组件）。
- **交互模型**：px/秒坐标 + 缩放视口（15/30/60s 预设、滚轮锚点缩放）；平移用 `transform: translateX`（非原生 overflow 滚动，故另手写**横向滚动条**：拖滑块平移、点轨道跳页）；`ResizeObserver` 观察轨道宽度驱动 `pxPerSec`。
- **行级编辑**：拖拽改开始时间（**邻接夹紧**防乱序，`[prev.start, next.start]` 区间）、距播放指针 80ms 磁吸、对齐到播放指针、±100ms、整体偏移。**左对齐语义**：块右缘是派生的（自动延伸至下一句 start），只控 start——界面上有常驻说明。
- **不支持插删块**：N 行文本 ↔ N 时间戳是 `next()`/`handleOk` 硬不变式，ai 模式还被 `body` zip 锁死。**合并歌词工作流** = 把块拖到极短 + 左面板把文本挪进前/后一句 + **保留空行**（行数不变）。空行渲染：预览上下句跳过、当前句显示「（空行）」，时间轴块为细线标记。
- **渲染要点**：歌词块**不设 padding、不设最小宽度**（border-box 下 `width:0` 会被 padding+border 撑到 ~18px 压进下一句）；可见窗口行过滤；等时间戳合法、按序存储。
- **播放指针**（界面对播放头的统一称呼）：`displayTimeMs` 非响应式、rAF 循环仅在播放中运行，每帧只直写 `transform`/状态栏文本（内容未变不写 DOM），活跃行二分查找跨句才更新；三个拖拽态（块拖/平移/滚动条）共享一对 document 监听 + rAF 分支。**禁止展开原生 MouseEvent**（clip.vue 曾因此丢 `clientX`）。
- **数据流**：`getTimelineLines()` 按三模式物化（online/ai-corrected 读 `_lyricsBody`，纯 ai 为 `body.from × _editBody` zip）→ `onTimelineCommit` 行数守恒校验、**ai → ai-corrected 双 ref 提升**（否则 `next()` 只读 `body[].from` 会静默丢编辑）。编辑侧一律**源视频时间**（clip/speed 前），导出时才由 `processLyrics` 换算。
- **溢出检查**：整体偏移钳制**统一位移量**到 `[-首句, 时长-末句]`（逐行 clamp 会让边界行堆叠破坏行距），被钳制时 info 提示实际生效值；「开始时间」/`handleOk` 有歌曲时长上界校验。
- **同步 watcher（`_editBody → _lyricsBody` 单向）**：非 online、行数一致才回写文本（时间戳不动）。同一 watcher 负责**文本编辑激活撤销**：非抑制、非 online 的净变更拍「编辑前」基线（有表用表、无表用编辑前 zip，oldBody 为敲键前值）并置 `timelineDirty`；程序性写入（`editLyrics`/`undoReplace`/智能纠错/`resetTimelineEdits`）必须先 `markInternalEditBodyWrite()`（suppress + nextTick 复位），否则重开工作台撤销就亮。
- **撤销（`resetTimelineEdits`）**：三方基线快照 `_lyricsBody` + `enhancedLrc` + `_editBody`（在 dirty false→true 的全部入口同刻捕获），一键整体回滚；空基线防御、恢复后按钮须熄灭（不自激活）。
- **⚠️ `smartCorrected` 必须独立于 `lyricsMode`**：时间轴编辑会把 `ai` 提升为 `ai-corrected`（路由需要），再用 `lyricsMode === 'ai-corrected'` 判断智能纠错会误显示「已纠错」、误入取消分支清空 `_lyricsBody`。
- **online 模式边界**：文本权威在右侧编辑框，左面板文本不参与同步/激活/导出（`handleOk` 以右侧 parse 为准）。
- **联动**：时间轴选中 → 左面板 `focus + setSelectionRange` 跳转整行（软换行由浏览器算准；面板 `display:none` 时直接跳过）；「点击跳转指针」与「跟随播放指针」是**独立开关**；换源自动重应用、行数实时警告见工作台节。
- **增强歌词**：行级拖拽不重排字级时间；全局偏移经 `shiftEnhancedLrc()` 对字符串内 `[mm:ss.mmm]`/`<mm:ss.mmm>` 标签整体平移（`parseYrc` 无法回读 Enhanced LRC，故不走 raw 重建）。
- 工作台四个 Tab 用 `<Transition name="lyrics-tab" mode="out-in">` 切换（先出后进防双面板并排抖动）。

### TaskCenter（任务中心）

- `src/taskCenter.ts` — 任务队列状态管理、调度、持久化，纯逻辑层不包含 DOM 操作
- `src/components/TaskCenter.vue` — 任务中心 UI，作为独立 Vue 应用挂载到 `#bilibili-music-task-center`
- 订阅机制：`subscribeTaskCenter(listener)` 监听状态变化，组件通过 `getTaskCenterState()` / `getTaskCenterRuntime()` 获取快照
- `panelOpen` 为组件内局部 `ref`，外部（如 `clearFinishedDownloadTasks`）无法访问；调用清除时需在组件内同步重置

**跨标签页隔离（sessionStorage 方案）**：

- 每个标签页有独立的 `TAB_ID`，通过 `unsafeWindow.sessionStorage` 持久化，刷新后保持不变
- 任务存储在 `sessionStorage["wasm_music_download_tasks_${TAB_ID}"]` 中，每个标签页独立存储
- **刷新保留**：`sessionStorage` 自动保留，任务不会丢失
- **关闭清除**：浏览器自动清除 `sessionStorage`，无需手动清理逻辑
- **标签页隔离**：不同标签页的 `sessionStorage` 互不可见，天然隔离
- **无需清理逻辑**：移除了 `beforeunload`/`unload`/`visibilitychange` 事件监听，避免刷新时误清理
- `DownloadTaskState` 接口不再需要 `tabId` 字段，因为每个标签页有独立的 storage key

### FloatingEntry（悬浮入口）

- `src/components/FloatingEntry.vue` — 悬浮入口按钮，仅在 `/video/` 和 `/list/` 路径下显示
- 作为独立 Vue 应用挂载到 `#bilibili-music-floating-entry`（`document.documentElement`）

### 深色模式同步

- `syncDarkMode()` 同时设置 `document.documentElement` 和 `document.body` 的 `arco-theme` 属性
- 自定义组件的深色样式使用 `html[arco-theme="dark"]` 或 `html[data-theme="dark"]` 选择器（非 `body`）

### Key Files

- `src/data.ts` — Centralized reactive state (fromData, userConfig)
- `src/utils/requests.ts` — HTTP request layer (GM_xmlhttpRequest wrapper)
- `src/utils/ffmpeg.ts` — FFmpeg WASM loader with multi-thread detection and progress logging
- `src/utils/lyricsCorrector.ts` — AI subtitle correction via character-level diff against online lyrics
- `src/components/LyricsTimeline.vue` — 歌词时间轴可视化编辑器（工作台「时间轴」Tab，见 Lyrics Timeline 节）
- `src/utils/drop.ts` — Drag-and-drop: parses dropped .wav ID3 tags to find source URL
- `src/utils/gpt.ts` — OpenAI-compatible API wrapper for AI lyrics correction

## UI 组件库（自定义组件）

### 设计系统

所有 UI 组件位于 `src/components/` 目录，基于 Tailwind CSS v4 构建，使用 `.ui-*` 样式命名空间。

### 组件列表

| 组件            | 用途     | 功能特性                            |
| --------------- | -------- | ----------------------------------- |
| `UiButton`      | 通用按钮 | primary/secondary/outline/text 类型 |
| `UiInput`       | 输入框   | 支持 v-model                        |
| `UiTextarea`    | 文本域   | 支持 v-model                        |
| `UiCheckbox`    | 复选框   | 支持 v-model                        |
| `UiSpace`       | 间距容器 | flex 布局                           |
| `UiFormItem`    | 表单项   | 表单布局                            |
| `UiButtonGroup` | 按钮组   | 按钮组合                            |
| `UiInputGroup`  | 输入框组 | 输入框组合                          |
| `UiSpin`        | 加载动画 | 加载状态                            |
| `UiAlert`       | 提示框   | 信息提示                            |
| `UiResult`      | 结果展示 | 操作结果                            |
| `UiSelect`      | 下拉选择 | 下拉选择                            |
| `UiTabs`        | 标签页   | 标签切换                            |
| `UiSteps`       | 步骤条   | 步骤导航                            |
| `UiDropdown`    | 下拉菜单 | 下拉菜单                            |
| `UiModal`       | 模态框   | 支持拖动功能                        |

### 深色模式支持

所有组件支持深色模式，使用以下选择器：

```css
:global([arco-theme="dark"]) .ui-xxx,
:global([data-theme="dark"]) .ui-xxx {
  /* 深色模式样式 */
}
```

### CSS 维护约定

- Tailwind CSS v4 通过 `@tailwindcss/vite` 接入，入口为 `src/style.css`
- 自定义 UI 组件使用 `.ui-*` 样式，不要重新引入已删除的通用 `.btn`/`.input` 工具类
- `html[arco-theme="dark"]` 和 `body[arco-theme="dark"]` 是宿主页面主题同步的兼容桥接，不应删除
- CSS 清理须保持所有功能行为；至少执行 `npm run build:tsc`、`npm run lint`、`npm run fmt` 并比较构建体积
