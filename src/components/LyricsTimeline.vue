<script lang="ts" setup>
import type { ClipRanges, Lyrics } from "@/data";
import { Message } from "@/utils/message";
// 显式导入（与仓库其它文件一致）：不依赖 unplugin-vue-components 自动注入，
// 避免生产构建中 resolveComponent 回退渲染成无样式的未知元素
import UiAlert from "@/components/UiAlert.vue";
import UiButton from "@/components/UiButton.vue";
import UiCheckbox from "@/components/UiCheckbox.vue";
import UiInput from "@/components/UiInput.vue";

const props = withDefaults(
  defineProps<{
    lines: Lyrics;
    enhanced?: boolean;
    clipRanges?: ClipRanges | null;
    /** 父级 timelineDirty：是否存在可撤销的时间轴编辑 */
    dirty?: boolean;
  }>(),
  {
    lines: () => [],
    enhanced: false,
    clipRanges: null,
    dirty: false,
  },
);

const emit = defineEmits<{
  (e: "commit", lines: Lyrics, globalDelta?: number): void;
  (e: "select", index: number): void;
  (e: "reset"): void;
}>();

/** 宿主 B 站播放器 video（与 clip.vue 同源选择器） */
let video: HTMLVideoElement | null = null;
let resizeObserver: ResizeObserver | null = null;

/** 虚拟播放头时间（ms），与 video.currentTime 解耦，非响应式：每帧直写 DOM */
let displayTimeMs = 0;
let playheadRafId = 0;
let docRafId = 0;
let pendingClientX = 0;
/** 拖拽期间 props.lines 变化被跳过时置位，mouseup 后补偿同步 */
let resyncPending = false;

/** 行级拖拽状态（普通对象，避免响应式开销） */
const drag = {
  active: false,
  moved: false,
  index: -1,
  startClientX: 0,
  startMs: 0,
  lastT: 0,
  blockEl: null as HTMLElement | null,
  timeEl: null as HTMLElement | null,
};
/** 空白处拖拽平移状态 */
const pan = { active: false, moved: false, startClientX: 0, startView: 0 };

const workingLines = shallowRef<Lyrics>(
  (props.lines ?? []).map(([t, s]): [number, string] => [t, s]),
);
const selectedId = ref<number | null>(null);
const activeIndex = ref(-1);
const isPlaying = ref(false);
const hasVideo = ref(false);
const followPlayhead = ref(true);
/** 点击时间块时是否将播放指针跳到该块开始时间（与「跟随播放指针」相互独立的两个功能） */
const seekOnClick = ref(true);
const windowSec = ref(30);
const viewStartMs = ref(0);
const trackW = ref(0);
const durationMs = ref(0);
const shiftInput = ref("");

const bodyEl = ref<HTMLElement | null>(null);
const trackEl = ref<HTMLElement | null>(null);
const playheadEl = ref<HTMLElement | null>(null);
const timeEl = ref<HTMLElement | null>(null);

const WINDOW_PRESETS = [15, 30, 60];
/** 拖拽磁吸播放头的阈值（ms） */
const SNAP_MS = 80;
/** 判定点击 vs 拖拽的像素阈值 */
const MOVE_THRESHOLD_PX = 3;

const pxPerSec = computed(() =>
  trackW.value > 0 && windowSec.value > 0 ? trackW.value / windowSec.value : 40,
);
const panX = computed(() => (viewStartMs.value / 1000) * pxPerSec.value);

const contentEndMs = computed(() => {
  const lines = workingLines.value;
  const last = lines.length ? lines[lines.length - 1][0] : 0;
  return Math.max(durationMs.value, last);
});

const viewMaxStart = computed(() => Math.max(0, contentEndMs.value - windowSec.value * 1000));

function setViewStart(ms: number) {
  const v = Math.min(Math.max(0, ms), viewMaxStart.value);
  if (v !== viewStartMs.value) viewStartMs.value = v;
}

function formatMsShort(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function formatMsFull(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const f = v % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}

/** 可见窗口内的歌词块（±半窗缓冲），只渲染相交的块 */
const visibleRows = computed(() => {
  const rows: Array<{
    i: number;
    left: number;
    width: number;
    time: string;
    full: string;
    text: string;
  }> = [];
  const pps = pxPerSec.value;
  const margin = windowSec.value * 1000 * 0.5;
  const v0 = viewStartMs.value - margin;
  const v1 = viewStartMs.value + windowSec.value * 1000 + margin;
  const lines = workingLines.value;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i][0];
    const end =
      i + 1 < lines.length
        ? lines[i + 1][0]
        : durationMs.value > start
          ? durationMs.value
          : start + 5000;
    if (end < v0 || start > v1) continue;
    // 不设最小宽度：强行撑到 8px 会在两句同刻（拖到夹紧边界）时压在下一句上造成重合。
    // 等时/极近的行渲染为细线标记（选中态 outline 仍可见），数据层等时间戳是合法的。
    const width = Math.max(0, ((end - start) / 1000) * pps);
    rows.push({
      i,
      left: (start / 1000) * pps,
      width,
      time: formatMsShort(start),
      full: `${formatMsFull(start)} ${lines[i][1]}`,
      text: lines[i][1],
    });
  }
  return rows;
});

/** 标尺刻度：选择使相邻刻度间距 ≥70px 的档位 */
const rulerTicks = computed(() => {
  const pps = pxPerSec.value;
  const candidates = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
  const step = candidates.find((s) => (s / 1000) * pps >= 70) ?? 300000;
  const windowMs = windowSec.value * 1000;
  const start = Math.floor(viewStartMs.value / step) * step;
  const ticks: Array<{ t: number; left: number; label: string }> = [];
  for (let t = start; t <= viewStartMs.value + windowMs + step; t += step) {
    if (t < 0) continue;
    ticks.push({ t, left: (t / 1000) * pps, label: formatMsShort(t) });
  }
  return ticks;
});

/** 剪辑删除区遮罩（源视频时间，仅视觉提示） */
const clipMasks = computed(() =>
  (props.clipRanges ?? []).map(([s, e]) => ({
    left: (s / 1000) * pxPerSec.value,
    width: Math.max(2, ((e - s) / 1000) * pxPerSec.value),
  })),
);

const selectedInfo = computed(() => {
  const i = selectedId.value;
  if (i === null || !workingLines.value[i]) return "";
  const [t, text] = workingLines.value[i];
  return `第 ${i + 1}/${workingLines.value.length} 句 · ${formatMsFull(t)} · ${text}`;
});

/** 当前歌词预览行（activeIndex 驱动：仅播放头跨句/表变更时重算） */
type PreviewRow = { i: number; time: string; text: string };

function makePreviewRow(i: number): PreviewRow {
  const line = workingLines.value[i];
  if (!line) return { i, time: "--:--", text: "" };
  return { i, time: formatMsShort(line[0]), text: line[1] };
}

const previewCurrentRow = computed<PreviewRow | null>(() => {
  const idx = activeIndex.value;
  return idx >= 0 && idx < workingLines.value.length ? makePreviewRow(idx) : null;
});

const previewPrevRow = computed<PreviewRow | null>(() => {
  const idx = activeIndex.value;
  return idx > 0 && idx < workingLines.value.length ? makePreviewRow(idx - 1) : null;
});

const previewNextRow = computed<PreviewRow | null>(() => {
  const idx = activeIndex.value;
  // 播放头在第一句之前时，把第一句当下一句展示
  const nextIdx = idx < 0 ? 0 : idx + 1;
  return nextIdx < workingLines.value.length ? makePreviewRow(nextIdx) : null;
});

function cloneLines(lines: Lyrics): Lyrics {
  return lines.map(([t, s]): [number, string] => [t, s]);
}

/** 父级基线变化（如外部整表重建）时同步本地工作副本；拖拽中跳过并记账 */
watch(
  () => props.lines,
  (val) => {
    if (drag.active) {
      resyncPending = true;
      return;
    }
    workingLines.value = cloneLines(val);
  },
);

function syncPlayheadDom() {
  const el = playheadEl.value;
  if (!el) return;
  const x = ((displayTimeMs - viewStartMs.value) / 1000) * pxPerSec.value;
  el.style.transform = `translate3d(${x}px, 0, 0)`;
}

function writeStatusTime() {
  const el = timeEl.value;
  if (!el) return;
  // 逐帧调用：内容未变时不写 DOM，避免无谓的行内布局失效
  const text = formatMsFull(displayTimeMs);
  if (el.textContent !== text) el.textContent = text;
}

/** 二分查找当前时间所在行（workingLines 按时间升序，邻接夹紧保证） */
function findActiveIndex(tMs: number): number {
  const lines = workingLines.value;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid][0] <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function updateActiveIndex() {
  const idx = findActiveIndex(displayTimeMs);
  if (idx !== activeIndex.value) activeIndex.value = idx;
}

watch([viewStartMs, pxPerSec], syncPlayheadDom);

// 时间表被整体改写（commit/整体偏移/重同步）后，播放指针所在的行可能变化，重算活跃行
watch(workingLines, updateActiveIndex);

function seekTo(ms: number) {
  displayTimeMs = Math.max(0, ms);
  syncPlayheadDom();
  writeStatusTime();
  updateActiveIndex();
  if (video) {
    const target = displayTimeMs / 1000;
    // 与 clip.vue 一致：rAF 内执行 seek，避免阻塞事件处理
    requestAnimationFrame(() => {
      if (video) video.currentTime = target;
    });
  }
}

function clampLine(i: number, t: number, lines: Lyrics): number {
  const min = i > 0 ? lines[i - 1][0] : 0;
  const max = i < lines.length - 1 ? lines[i + 1][0] : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(t, min), max);
}

function emitCommit(globalDelta?: number) {
  emit(
    "commit",
    workingLines.value.map(([t, s]): [number, string] => [t, s]),
    globalDelta,
  );
}

function replaceLine(i: number, t: number) {
  workingLines.value = workingLines.value.map((l, idx): [number, string] =>
    idx === i ? [t, l[1]] : [l[0], l[1]],
  );
  emitCommit();
}

function onBlockMouseDown(e: MouseEvent, i: number) {
  if (e.button !== 0) return;
  const line = workingLines.value[i];
  if (!line) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  drag.active = true;
  drag.moved = false;
  drag.index = i;
  drag.startClientX = e.clientX;
  drag.startMs = line[0];
  drag.lastT = line[0];
  drag.blockEl = el;
  drag.timeEl = el.querySelector(".lt-block-time");
  selectedId.value = i;
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);
}

function applyDrag(clientX: number) {
  const i = drag.index;
  const lines = workingLines.value;
  if (i < 0 || i >= lines.length || !drag.blockEl) return;
  const deltaPx = clientX - drag.startClientX;
  if (Math.abs(deltaPx) > MOVE_THRESHOLD_PX) drag.moved = true;
  const min = i > 0 ? lines[i - 1][0] : 0;
  const max = i < lines.length - 1 ? lines[i + 1][0] : Number.MAX_SAFE_INTEGER;
  let t = drag.startMs + (deltaPx / pxPerSec.value) * 1000;
  // 磁吸播放头（目标须在邻接边界内才吸附）
  if (Math.abs(t - displayTimeMs) < SNAP_MS && displayTimeMs >= min && displayTimeMs <= max) {
    t = displayTimeMs;
  }
  t = Math.min(Math.max(t, min), max);
  drag.lastT = t;
  // 拖拽中只直写该块样式，不改响应式数组
  drag.blockEl.style.left = `${(t / 1000) * pxPerSec.value}px`;
  if (drag.timeEl) drag.timeEl.textContent = formatMsShort(t);
}

function applyPan(clientX: number) {
  const deltaPx = clientX - pan.startClientX;
  if (Math.abs(deltaPx) > MOVE_THRESHOLD_PX) pan.moved = true;
  setViewStart(pan.startView - (deltaPx / pxPerSec.value) * 1000);
}

function onBodyMouseDown(e: MouseEvent) {
  if (e.button !== 0 || drag.active) return;
  pan.active = true;
  pan.moved = false;
  pan.startClientX = e.clientX;
  pan.startView = viewStartMs.value;
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);
}

function onDocMouseMove(e: MouseEvent) {
  // 事件派发后同步捕获坐标，rAF 内消费（勿展开原生 MouseEvent，会丢失 clientX）
  pendingClientX = e.clientX;
  if (docRafId) cancelAnimationFrame(docRafId);
  docRafId = requestAnimationFrame(() => {
    docRafId = 0;
    if (drag.active) applyDrag(pendingClientX);
    else if (pan.active) applyPan(pendingClientX);
  });
}

function onDocMouseUp(e: MouseEvent) {
  if (docRafId) {
    cancelAnimationFrame(docRafId);
    docRafId = 0;
  }
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);

  if (drag.active) {
    const i = drag.index;
    if (drag.moved) {
      applyDrag(e.clientX);
      replaceLine(i, drag.lastT);
    } else {
      // 未超过阈值视为点击：是否跳转播放指针由「点击跳转指针」选项控制；
      // 选中（selectedId/文本同步）不受该选项影响，始终执行
      if (seekOnClick.value) seekTo(drag.startMs);
    }
    selectedId.value = i;
    // 选中行变化 → 通知父级同步左侧文本面板（点击与拖拽松手均触发一次）
    emit("select", i);
    drag.active = false;
    drag.blockEl = null;
    drag.timeEl = null;
  } else if (pan.active) {
    if (!pan.moved && bodyEl.value) {
      // 空白单击：seek 到光标时间
      const rect = bodyEl.value.getBoundingClientRect();
      const t = viewStartMs.value + ((e.clientX - rect.left) / pxPerSec.value) * 1000;
      seekTo(t);
    }
    pan.active = false;
  }

  if (resyncPending) {
    resyncPending = false;
    workingLines.value = cloneLines(props.lines);
  }
}

function onWheel(e: WheelEvent) {
  const body = bodyEl.value;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const tAnchor = viewStartMs.value + (x / pxPerSec.value) * 1000;
  const factor = e.deltaY > 0 ? 1.25 : 0.8;
  windowSec.value = Math.min(120, Math.max(5, windowSec.value * factor));
  // 缩放后保持锚点时间仍在光标下
  setViewStart(tAnchor - (x / pxPerSec.value) * 1000);
}

function setWindowSec(sec: number) {
  const center = viewStartMs.value + (windowSec.value * 1000) / 2;
  windowSec.value = sec;
  setViewStart(center - (sec * 1000) / 2);
}

function togglePlay() {
  if (!video) {
    Message.info("未检测到宿主播放器");
    return;
  }
  if (isPlaying.value) {
    video.pause();
  } else {
    video.play().catch((err) => {
      console.error("视频播放失败:", err);
    });
  }
}

function requireSelection(): number | null {
  const i = selectedId.value;
  if (i === null || !workingLines.value[i]) {
    Message.info("请先点击选择歌词行");
    return null;
  }
  return i;
}

function nudgeSelected(deltaMs: number) {
  const i = requireSelection();
  if (i === null) return;
  const t = clampLine(i, workingLines.value[i][0] + deltaMs, workingLines.value);
  replaceLine(i, t);
}

function alignSelectedToPlayhead() {
  const i = requireSelection();
  if (i === null) return;
  const t = clampLine(i, displayTimeMs, workingLines.value);
  replaceLine(i, t);
}

function applyShiftAll() {
  const raw = shiftInput.value.trim();
  const sec = Number(raw);
  if (!raw || !Number.isFinite(sec) || sec === 0) {
    Message.warning("请输入偏移秒数，如 0.5 或 -0.3");
    return;
  }
  const lines = workingLines.value;
  if (!lines.length) return;

  // 溢出检查：整体平移必须让整表留在 [0, 歌曲结束] 内。
  // 钳制的是「统一 delta」而不是逐行 Math.max——逐行钳制会让出界行堆叠在 0、破坏行距。
  const requested = Math.round(sec * 1000);
  const minDelta = -lines[0][0]; // 首句最早对齐 00:00（表有序 → 全表 ≥0）
  const maxDelta =
    durationMs.value > 0 ? durationMs.value - lines[lines.length - 1][0] : Number.MAX_SAFE_INTEGER;
  const deltaMs = Math.min(Math.max(requested, minDelta), maxDelta);

  if (deltaMs !== requested) {
    if (deltaMs === 0) {
      Message.warning("已到达歌曲边界，无法继续偏移");
      return;
    }
    Message.info(`偏移超出歌曲范围，已调整为 ${(deltaMs / 1000).toFixed(3)} 秒`);
  }

  workingLines.value = lines.map(([t, s]): [number, string] => [t + deltaMs, s]);
  shiftInput.value = "";
  // 携带「实际应用」的 delta（可能已被钳制）供父级同步逐字歌词
  emitCommit(deltaMs);
}

/** 播放头 rAF 循环：仅播放中运行；每帧只直写 transform/文本 + 条件性 activeIndex */
function playheadTick() {
  playheadRafId = 0;
  if (!video || video.paused) {
    isPlaying.value = false;
    return;
  }
  displayTimeMs = video.currentTime * 1000;
  syncPlayheadDom();
  writeStatusTime();
  updateActiveIndex();
  maybeFollow();
  playheadRafId = requestAnimationFrame(playheadTick);
}

function startPlayheadLoop() {
  if (playheadRafId) return;
  playheadRafId = requestAnimationFrame(playheadTick);
}

function stopPlayheadLoop() {
  if (playheadRafId) {
    cancelAnimationFrame(playheadRafId);
    playheadRafId = 0;
  }
}

function maybeFollow() {
  if (!followPlayhead.value || drag.active || pan.active || trackW.value <= 0) return;
  const x = ((displayTimeMs - viewStartMs.value) / 1000) * pxPerSec.value;
  if (x > trackW.value * 0.8 || (x < trackW.value * 0.1 && displayTimeMs > 1000)) {
    setViewStart(displayTimeMs - ((trackW.value * 0.2) / pxPerSec.value) * 1000);
  }
}

function handlePlay() {
  isPlaying.value = true;
  startPlayheadLoop();
}

function handlePause() {
  isPlaying.value = false;
  stopPlayheadLoop();
  if (video) {
    displayTimeMs = video.currentTime * 1000;
    syncPlayheadDom();
    writeStatusTime();
    updateActiveIndex();
  }
}

function handleEnded() {
  isPlaying.value = false;
  stopPlayheadLoop();
}

onMounted(() => {
  video = document.querySelector(`.bpx-player-video-wrap video`);
  if (video) {
    hasVideo.value = true;
    durationMs.value = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    displayTimeMs = video.currentTime * 1000;
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handleEnded);
    if (!video.paused) {
      isPlaying.value = true;
      startPlayheadLoop();
    }
  }

  if (trackEl.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      trackW.value = w;
    });
    resizeObserver.observe(trackEl.value);
  } else if (trackEl.value) {
    trackW.value = trackEl.value.clientWidth;
  }

  // 初始视口对准第一句附近
  const first = workingLines.value[0]?.[0] ?? 0;
  setViewStart(first > 0 ? first - 2000 : 0);
  syncPlayheadDom();
  writeStatusTime();
  updateActiveIndex();
});

onUnmounted(() => {
  stopPlayheadLoop();
  if (docRafId) {
    cancelAnimationFrame(docRafId);
    docRafId = 0;
  }
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);
  if (video) {
    video.removeEventListener("play", handlePlay);
    video.removeEventListener("pause", handlePause);
    video.removeEventListener("ended", handleEnded);
    video = null;
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
  drag.active = false;
  pan.active = false;
});
</script>

<template>
  <div class="lyrics-timeline">
    <UiAlert v-if="enhanced" type="warning" style="margin-bottom: 8px">
      逐字歌词模式：行级拖拽仅影响行级时间轴，字级时间只随「整体偏移 /
      开始时间」整体平移；导出时逐字时间以 Enhanced LRC 为准。
    </UiAlert>
    <UiAlert v-if="!hasVideo" type="warning" style="margin-bottom: 8px">
      未检测到宿主播放器，无法试听；时间轴仍可编辑。
    </UiAlert>

    <div class="lt-toolbar">
      <UiButton
        size="small"
        :type="isPlaying ? 'primary' : 'outline'"
        :disabled="!hasVideo"
        @click="togglePlay"
      >
        {{ isPlaying ? "⏸ 暂停" : "▶ 播放" }}
      </UiButton>
      <span class="lt-label">窗口</span>
      <UiButton
        v-for="w in WINDOW_PRESETS"
        :key="w"
        size="small"
        :type="Math.abs(windowSec - w) < 0.5 ? 'primary' : 'outline'"
        @click="setWindowSec(w)"
      >
        {{ w }}s
      </UiButton>
      <UiCheckbox v-model="followPlayhead">跟随播放指针</UiCheckbox>
      <UiCheckbox
        v-model="seekOnClick"
        title="开启后，点击时间块会将播放指针跳到该块的开始时间；关闭后点击仅选中该块（不影响跟随播放指针）"
      >
        点击跳转指针
      </UiCheckbox>
      <span class="lt-divider"></span>
      <span class="lt-label">整体偏移(秒)</span>
      <UiInput
        v-model="shiftInput"
        style="width: 90px"
        placeholder="如 -0.3"
        @keyup.enter="applyShiftAll"
      />
      <UiButton size="small" @click="applyShiftAll">应用</UiButton>
      <UiButton
        size="small"
        :disabled="selectedId === null"
        title="将选中行的开始时间设为播放指针当前所在的时间点"
        @click="alignSelectedToPlayhead"
      >
        对齐到播放指针
      </UiButton>
      <UiButton size="small" :disabled="selectedId === null" @click="nudgeSelected(-100)">
        −100ms
      </UiButton>
      <UiButton size="small" :disabled="selectedId === null" @click="nudgeSelected(100)">
        +100ms
      </UiButton>
      <UiButton
        size="small"
        :disabled="!dirty"
        title="撤销所有时间轴编辑（含整体偏移/开始时间调整），恢复到编辑前的原始时间轴"
        @click="emit('reset')"
      >
        撤销
      </UiButton>
    </div>

    <div
      v-if="workingLines.length"
      ref="bodyEl"
      class="lt-body"
      @mousedown="onBodyMouseDown"
      @wheel.prevent="onWheel"
    >
      <div class="lt-ruler">
        <div class="lt-layer" :style="{ transform: `translateX(${-panX}px)` }">
          <div
            v-for="tick in rulerTicks"
            :key="tick.t"
            class="lt-tick"
            :style="{ left: tick.left + 'px' }"
          >
            <span class="lt-tick-label">{{ tick.label }}</span>
          </div>
        </div>
      </div>
      <div ref="trackEl" class="lt-track">
        <div class="lt-layer lt-viewport" :style="{ transform: `translateX(${-panX}px)` }">
          <div
            v-for="mask in clipMasks"
            :key="'mask-' + mask.left"
            class="lt-clip-mask"
            :style="{ left: mask.left + 'px', width: mask.width + 'px' }"
          ></div>
          <div
            v-for="row in visibleRows"
            :key="row.i"
            class="lt-block"
            :class="{
              'lt-block-active': activeIndex === row.i,
              'lt-block-selected': selectedId === row.i,
            }"
            :style="{ left: row.left + 'px', width: row.width + 'px' }"
            :title="row.full"
            @mousedown.stop="onBlockMouseDown($event, row.i)"
          >
            <span class="lt-block-time">{{ row.time }}</span>
            <span class="lt-block-text">{{ row.text }}</span>
          </div>
        </div>
      </div>
      <div ref="playheadEl" class="lt-playhead"></div>
    </div>
    <UiAlert v-else type="info">暂无歌词时间轴数据，请先加载歌词。</UiAlert>

    <!-- 当前歌词预览：跟随播放指针所在句（上一句/当前句/下一句），点击任意行跳转试听。
         固定行高 + 单行省略，行切换与左面板开合引起的宽度变化都不造成布局抖动 -->
    <div
      v-if="workingLines.length"
      class="lt-preview"
      title="跟随播放指针的当前歌词，点击可跳转试听"
    >
      <div
        v-if="previewPrevRow"
        class="lt-preview-row lt-preview-prev"
        @click="previewPrevRow && seekTo(workingLines[previewPrevRow.i][0])"
      >
        <span class="lt-preview-time">{{ previewPrevRow.time }}</span>
        <span class="lt-preview-text">{{ previewPrevRow.text || "♪" }}</span>
      </div>
      <div
        class="lt-preview-row lt-preview-current"
        :class="{ 'lt-preview-empty': !previewCurrentRow }"
        @click="previewCurrentRow && seekTo(workingLines[previewCurrentRow.i][0])"
      >
        <template v-if="previewCurrentRow">
          <span class="lt-preview-time">{{ previewCurrentRow.time }}</span>
          <span class="lt-preview-text">{{ previewCurrentRow.text || "♪" }}</span>
          <span class="lt-preview-index">
            {{ previewCurrentRow.i + 1 }}/{{ workingLines.length }}
          </span>
        </template>
        <template v-else>
          <span class="lt-preview-time">--:--</span>
          <span class="lt-preview-text">尚未播放到歌词</span>
        </template>
      </div>
      <div
        v-if="previewNextRow"
        class="lt-preview-row lt-preview-next"
        @click="previewNextRow && seekTo(workingLines[previewNextRow.i][0])"
      >
        <span class="lt-preview-time">{{ previewNextRow.time }}</span>
        <span class="lt-preview-text">{{ previewNextRow.text || "♪" }}</span>
      </div>
    </div>

    <div class="lt-status">
      <span ref="timeEl" class="lt-status-time">00:00.000</span>
      <span class="lt-status-sel">{{ selectedInfo || "未选中行" }}</span>
      <span class="lt-status-hint">拖动色块调整时间 · 点击试听 · 滚轮缩放 · 拖空白平移</span>
    </div>
  </div>
</template>

<style scoped>
.lyrics-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.lt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lt-label {
  font-size: 12px;
  color: var(--color-bili-text-secondary, #666);
  white-space: nowrap;
}

.lt-divider {
  width: 1px;
  height: 16px;
  background: var(--color-bili-border, #e3e5e7);
}

.lt-body {
  position: relative;
  border: 1px solid var(--color-bili-border, #e3e5e7);
  border-radius: 6px;
  background: var(--color-bili-bg, #fff);
  overflow: hidden;
  cursor: grab;
  user-select: none;
}

.lt-body:active {
  cursor: grabbing;
}

.lt-ruler {
  position: relative;
  height: 26px;
  border-bottom: 1px solid var(--color-bili-border, #e3e5e7);
  overflow: hidden;
}

.lt-layer {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  will-change: transform;
}

.lt-tick {
  position: absolute;
  bottom: 0;
  height: 100%;
  border-left: 1px solid var(--color-bili-border, #d0d3d6);
  padding-left: 4px;
}

.lt-tick-label {
  font-size: 10px;
  line-height: 26px;
  color: var(--color-bili-text-muted, #999);
  font-variant-numeric: tabular-nums;
}

.lt-track {
  position: relative;
  height: 88px;
  overflow: hidden;
}

.lt-viewport {
  overflow: visible;
}

.lt-block {
  position: absolute;
  top: 18px;
  height: 52px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 块本体不带 padding：border-box 下指定宽度小于 padding+border 时，
     浏览器会把实际占位撑到 padding+border（约 18px），且 overflow 裁剪边界
     是 padding box——近零时长的块会连底色带漏出的文字一起压进下一句。
     左右内边距改由子元素承担（time 的 margin-left / text 的 padding-right），
     块本体因此可真正收缩到仅剩 1px 边框。 */
  background: rgba(0, 174, 236, 0.12);
  border: 1px solid rgba(0, 174, 236, 0.45);
  border-radius: 4px;
  cursor: grab;
  overflow: hidden;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-bili-text, #18191c);
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.lt-block:hover {
  background: rgba(0, 174, 236, 0.22);
}

.lt-block-active {
  background: rgba(0, 174, 236, 0.3);
  border-color: var(--color-bili-blue, #00aeec);
}

.lt-block-selected {
  outline: 2px solid var(--color-bili-blue, #00aeec);
  outline-offset: 1px;
  z-index: 2;
}

.lt-block-time {
  flex: none;
  /* 替代块本体的左内边距；子元素 margin 不参与父块占位计算 */
  margin-left: 8px;
  font-size: 10px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.lt-block-text {
  overflow: hidden;
  text-overflow: ellipsis;
  /* 替代块本体的右内边距，收在自身盒内不影响父块占位 */
  padding-right: 8px;
}

/* 当前歌词预览：宽度 100% 随右列（左面板开合）自适应；
   固定行高 + 单行省略，跨句切换与宽度变化不引起布局抖动 */
.lt-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--color-bili-border, #e3e5e7);
  border-radius: 6px;
  background: var(--color-bili-bg, #fff);
}

.lt-preview-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 22px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-bili-text-muted, #999);
  cursor: pointer;
  overflow: hidden;
}

.lt-preview-row:hover {
  background: rgba(0, 174, 236, 0.08);
}

.lt-preview-prev,
.lt-preview-next {
  opacity: 0.7;
}

.lt-preview-current {
  height: 34px;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-bili-text, #18191c);
  background: rgba(0, 174, 236, 0.1);
}

.lt-preview-current:hover {
  background: rgba(0, 174, 236, 0.16);
}

.lt-preview-empty {
  background: transparent;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-bili-text-muted, #999);
  cursor: default;
}

.lt-preview-empty:hover {
  background: transparent;
}

.lt-preview-time {
  flex: none;
  min-width: 44px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--color-bili-blue, #00aeec);
  opacity: 0.85;
}

.lt-preview-current .lt-preview-time {
  font-size: 14px;
}

.lt-preview-empty .lt-preview-time {
  color: var(--color-bili-text-muted, #999);
  opacity: 1;
}

.lt-preview-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-preview-index {
  flex: none;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.6;
  color: var(--color-bili-text-secondary, #666);
}

.lt-clip-mask {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(255, 77, 79, 0.16);
  border-left: 1px solid rgba(255, 77, 79, 0.5);
  border-right: 1px solid rgba(255, 77, 79, 0.5);
  pointer-events: none;
  z-index: 1;
}

.lt-playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--color-bili-blue, #00aeec);
  pointer-events: none;
  z-index: 3;
}

.lt-status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--color-bili-text-secondary, #666);
  min-height: 18px;
}

.lt-status-time {
  font-variant-numeric: tabular-nums;
  color: var(--color-bili-blue, #00aeec);
  font-weight: 600;
  /* 固定时间槽宽：逐帧变化的数字若宽度不一，会推挤右侧歌词详情造成反复抽搐 */
  min-width: 9ch;
  flex-shrink: 0;
  white-space: nowrap;
}

.lt-status-sel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
}

.lt-status-hint {
  margin-left: auto;
  color: var(--color-bili-text-muted, #999);
}
</style>

<style>
/* 深色模式 */
body[arco-theme="dark"] .lt-body,
body[data-theme="dark"] .lt-body {
  background: #1f1f1f;
  border-color: #444;
}

body[arco-theme="dark"] .lt-ruler,
body[data-theme="dark"] .lt-ruler {
  border-bottom-color: #444;
}

body[arco-theme="dark"] .lt-tick,
body[data-theme="dark"] .lt-tick {
  border-left-color: #3a3a3a;
}

body[arco-theme="dark"] .lt-tick-label,
body[data-theme="dark"] .lt-tick-label {
  color: #999;
}

body[arco-theme="dark"] .lt-block,
body[data-theme="dark"] .lt-block {
  background: rgba(0, 174, 236, 0.16);
  border-color: rgba(0, 174, 236, 0.5);
  color: #e0e0e0;
}

body[arco-theme="dark"] .lt-block:hover,
body[data-theme="dark"] .lt-block:hover {
  background: rgba(0, 174, 236, 0.26);
}

body[arco-theme="dark"] .lt-block-active,
body[data-theme="dark"] .lt-block-active {
  background: rgba(0, 174, 236, 0.34);
}

body[arco-theme="dark"] .lt-clip-mask,
body[data-theme="dark"] .lt-clip-mask {
  background: rgba(255, 77, 79, 0.22);
}

body[arco-theme="dark"] .lt-label,
body[data-theme="dark"] .lt-label,
body[arco-theme="dark"] .lt-status,
body[data-theme="dark"] .lt-status {
  color: #999;
}

body[arco-theme="dark"] .lt-status-hint,
body[data-theme="dark"] .lt-status-hint {
  color: #666;
}

body[arco-theme="dark"] .lt-preview,
body[data-theme="dark"] .lt-preview {
  background: #1f1f1f;
  border-color: #444;
}

body[arco-theme="dark"] .lt-preview-row,
body[data-theme="dark"] .lt-preview-row {
  color: #666;
}

body[arco-theme="dark"] .lt-preview-row:hover,
body[data-theme="dark"] .lt-preview-row:hover {
  background: rgba(0, 174, 236, 0.12);
}

body[arco-theme="dark"] .lt-preview-current,
body[data-theme="dark"] .lt-preview-current {
  color: #e0e0e0;
  background: rgba(0, 174, 236, 0.16);
}

body[arco-theme="dark"] .lt-preview-current:hover,
body[data-theme="dark"] .lt-preview-current:hover {
  background: rgba(0, 174, 236, 0.22);
}

body[arco-theme="dark"] .lt-preview-empty,
body[data-theme="dark"] .lt-preview-empty {
  background: transparent;
  color: #666;
}

body[arco-theme="dark"] .lt-preview-empty:hover,
body[data-theme="dark"] .lt-preview-empty:hover {
  background: transparent;
}

body[arco-theme="dark"] .lt-preview-index,
body[data-theme="dark"] .lt-preview-index {
  color: #999;
}

body[arco-theme="dark"] .lt-divider,
body[data-theme="dark"] .lt-divider {
  background: #444;
}
</style>
