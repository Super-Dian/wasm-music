<script lang="ts" setup>
import { fromData, Lyrics, userConfig } from "@/data";
import type { WordLyrics } from "@/data";
import { parseYrc, wordLyricsToEnhancedLrc, wordLyricsToStandardLrc } from "@/utils/yrcParser";
import { onMounted, ref, computed, reactive } from "vue";
import { request } from "@/utils/requests";
import Btn from "@/components/btn.vue";
import UiCheckbox from "@/components/UiCheckbox.vue";
import UiButton from "@/components/UiButton.vue";
import UiInput from "@/components/UiInput.vue";
import UiTextarea from "@/components/UiTextarea.vue";
import UiSpin from "@/components/UiSpin.vue";
import UiAlert from "@/components/UiAlert.vue";
import UiSelect from "@/components/UiSelect.vue";
import UiModal from "@/components/UiModal.vue";
import UiTabs from "@/components/UiTabs.vue";
import { Message } from "@/utils/message";

interface SelectOption {
  label: string;
  value: string | number;
  disabled?: boolean;
}

interface SelectOptionGroup {
  isGroup: true;
  label: string;
  options: SelectOption[];
}
import { callOpenAI, ChatCompletionMessageParam } from "@/utils/gpt";
import { diffChars, diffWords, diffLines, Change } from "diff";
import { logger } from "@/utils/logger";
import { getActiveDefaultRule } from "@/episode";
import {
  correctLyrics,
  cleanOriginalLyrics,
  cleanOriginalLyricsPlain,
} from "@/utils/lyricsCorrector";
import { selectSubtitleForAuto, subtitleToLyrics } from "@/utils/lyrics";

const emits = defineEmits(["next", "prev"]);

type SubTitle = PlayerData["subtitle"]["subtitles"][number];

const subtitles = ref<SubTitle[]>([]);
const noSubtitle = ref(false);
const subtitle = ref<string[]>([]);

const subtitleEdit = ref<SubTitle | null>(null);
const subtitleEditMode = ref<LyricsMode>("ai");

const lyricsRecord = {
  label: undefined as string | undefined,
};

function toggleSubtitle(id: string) {
  const index = subtitle.value.indexOf(id);
  if (index > -1) {
    subtitle.value = [];
    fromData.lyricsData = null;
    lyricsRecord.label = undefined;
    noSubtitle.value = true;
  } else {
    subtitle.value = [id];
    const s = subtitles.value.find((item) => item.id_str === id);
    lyricsRecord.label = s?.lan_doc;
    noSubtitle.value = false;
  }
}

const onChange = (v: (string | number | boolean)[]) => {
  const val = v.at(-1);
  if (val !== undefined && val !== false) {
    subtitle.value = [val.toString()];
    const s = subtitles.value.find((item) => item.id_str === val.toString());
    lyricsRecord.label = s?.lan_doc;
    noSubtitle.value = false;
  } else {
    fromData.lyricsData = null;
    subtitle.value = [];
    lyricsRecord.label = undefined;
    noSubtitle.value = true;
  }
};

const error = ref("");

function skipLyrics() {
  noSubtitle.value = true;
  next();
}

function next() {
  fromData.record.lyrics = lyricsRecord.label;
  fromData.record.externalLyrics = fromData.externalLyrics;
  let lyricsData: Lyrics = [];

  if (noSubtitle.value) {
    Message.info("跳过歌词嵌入");
  } else if (subtitleEdit.value?.data) {
    const data = subtitleEdit.value.data;
    const lines = (data._editBody ?? "").split("\n");

    if (subtitleEditMode.value === "online") {
      lyricsData = data._lyricsBody ?? [];
    } else {
      if (lines.length !== data.body.length) {
        Message.error("歌词行数与 AI 字幕时间轴不一致");
        return;
      }
      lyricsData = data.body.map((item, index) => [Math.round(item.from * 1000), lines[index]]);
      if (subtitleEditMode.value === "ai-corrected" && data._lyricsBody?.length) {
        lyricsData = data._lyricsBody;
      }
    }

    if (lyricsData.length === 0 || lyricsData.length !== lines.length) {
      Message.error("歌词时间轴无效，请重新处理歌词");
      return;
    }
  } else {
    const s = subtitles.value.find((item) => item.id_str === subtitle.value[0]);
    if (!s?.data) {
      Message.error("歌词数据错误");
      return;
    }
    lyricsData = s.data.body.map((item) => [Math.round(item.from * 1000), item.content]);
  }

  fromData.lyricsData = lyricsData;
  emits("next");
}

onMounted(() => {
  if (!fromData.videoData) return;

  // 缓存命中：playerData 已存在（含已解析的字幕），直接恢复本地状态
  if (fromData.playerData?.subtitle?.subtitles?.length) {
    const cached = fromData.playerData.subtitle.subtitles;
    subtitles.value = cached;
    // 阻止 UiSpin 显示加载状态
    return;
  }

  const cid = fromData.videoData.cid.toString();
  const bvid = fromData.videoData.bvid;
  const aid = fromData.videoData.aid.toString();
  logger.debug({ cid, bvid, aid });
  request
    .get({
      url:
        "https://api.bilibili.com/x/player/wbi/v2?" +
        new URLSearchParams({
          cid,
          bvid,
          aid,
        }),
    })
    .then(async (res: any) => {
      logger.debug("playerData", res);
      if (!res.data) return;
      fromData.playerData = res.data as PlayerData;
      fromData.playerData.aid = fromData.playerData.aid || fromData.videoData!.aid;
      fromData.playerData.cid = fromData.videoData!.cid;
      fromData.playerData.bvid = fromData.playerData.bvid || fromData.videoData!.bvid;
      fromData.playerData.subtitle =
        fromData.playerData.subtitle || ({ subtitles: [] } as unknown as PlayerData["subtitle"]);
      fromData.playerData.subtitle.subtitles = fromData.playerData.subtitle.subtitles || [];
      if (fromData.playerData.subtitle.subtitles.length === 0) {
        error.value = "当前视频没有字幕";
        noSubtitle.value = true;
        if (fromData.usedefaultconfig) emits("next");
        return;
      }
      const _subtitles = await Promise.all(
        fromData.playerData.subtitle.subtitles.map(async (item) => {
          item.data = await request.get({ url: `http:${item.subtitle_url}` });
          return item;
        }),
      );
      subtitles.value = _subtitles;
      if (fromData.playerData) fromData.playerData.subtitle.subtitles = _subtitles;

      // 新增：尝试使用本地默认语言配置（lan_doc），否则回退到第一个
      if (_subtitles.length > 0) {
        if (fromData.usedefaultconfig) {
          const preferredLanguage = getActiveDefaultRule()?.lyrics;
          const selected = selectSubtitleForAuto(_subtitles, preferredLanguage);
          if (selected) {
            subtitle.value = [selected.id_str];
            lyricsRecord.label = selected.lan_doc;
            fromData.lyricsData = subtitleToLyrics(selected);
          }

          emits("next");
        } else {
          const val = _subtitles[0].id_str;
          subtitle.value = [val];
          lyricsRecord.label = _subtitles[0].lan_doc;
        }
      }
      logger.info("[lyrics] 字幕数据加载完成:", { count: _subtitles.length });
    })
    .catch((err) => {
      if (fromData.usedefaultconfig) {
        fromData.playerData = {
          aid: fromData.videoData!.aid,
          cid: fromData.videoData!.cid,
          bvid: fromData.videoData!.bvid,
          subtitle: {
            subtitles: [],
          },
        } as unknown as PlayerData;
        fromData.lyricsData = null;
        logger.warn("字幕信息获取失败，自动下载将跳过字幕", err);
        emits("next");
      } else {
        error.value = err.message;
      }
    });
});

const visible = ref(false);

// 歌词工作台全屏弹窗打开时，隐藏悬浮按钮防止遮挡
watch(visible, (v) => {
  document.documentElement.classList.toggle("hide-floating-buttons", v);
});

const editLyricsData = ref<SubTitle | null>(null);

type LyricsMode = "ai" | "ai-corrected" | "online";
const lyricsMode = ref<LyricsMode>("ai");
const originalAiBody = ref<Body[]>([]);
const originalAiText = ref("");

const onlineLyrics = ref<string>("");
/** 在线 YRC 逐字歌词原始文本 */
const onlineYrc = ref<string>("");

/** 当前激活的 tab */
const activeTab = ref("1");

/** 是否显示 OpenAI 设置面板 */
const showOpenAISettings = ref(false);

/** 第一句歌词开始时间（mm:ss格式） */
const lyricsStartTime = ref("");
const lyricsStartTimeError = ref(false);

/** 是否使用在线歌词 */
const useOnlineLyrics = ref(false);
/** 歌词类型：normal=普通LRC, enhanced=逐字Enhanced LRC */
const lyricsType = ref<"normal" | "enhanced">("normal");
/** 缓存普通 LRC 格式的在线歌词，用于切换回普通格式时恢复 */
const cachedNormalLyrics = ref("");

/** 在线歌词原始解析结果（未偏移），用于 offset 计算基准 */
const originalParsedLyrics = ref<Array<[number, string]>>([]);

/**
 * 切换使用在线歌词状态
 */
let isReplacingLyrics = false;
function toggleUseOnlineLyrics() {
  if (isReplacingLyrics) return;
  if (useOnlineLyrics.value) {
    undoReplaceLyrics();
  } else if (lyricsType.value === "enhanced") {
    applyEnhancedLyrics();
  } else {
    replaceWithOnlineLyrics();
  }
}

/**
 * 监听歌词类型切换，仅切换右侧在线歌词预览框的内容格式
 * - normal: 标准 LRC（行级时间戳）
 * - enhanced: Enhanced LRC（逐字时间戳）
 */
watch(lyricsType, (newType) => {
  if (!onlineLyrics.value) return;
  if (isReplacingLyrics) return;

  if (newType === "enhanced") {
    if (!onlineYrc.value) return;
    // 缓存当前普通格式，然后应用逐字格式
    cachedNormalLyrics.value = editableOnlineLyrics.value;
    const wordLyrics = parseYrc(onlineYrc.value);
    if (wordLyrics.length === 0) return;
    editableOnlineLyrics.value = wordLyricsToEnhancedLrc(wordLyrics);
  } else {
    // 恢复缓存的普通格式并重新应用当前格式化选项
    applyFormatting();
  }
});

/**
 * 验证并调整歌词时间轴
 * @returns 调整后的毫秒数，如果无效返回null
 */
function parseLyricsStartTime(timeStr: string): number | null {
  const match = timeStr.match(/^(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;

  const minutes = parseInt(match[1], 10);
  const seconds = parseInt(match[2], 10);
  const fraction = match[3] ?? "0";

  if (seconds >= 60) return null;

  return minutes * 60 * 1000 + seconds * 1000 + parseInt(fraction.padEnd(3, "0"), 10);
}

/**
 * 当开始时间输入变化时，实时调整歌词时间轴
 */
function onLyricsStartTimeChange(value: string) {
  if (!value) {
    lyricsStartTimeError.value = true;
    return;
  }

  const startTimeMs = parseLyricsStartTime(value);
  if (startTimeMs === null) {
    lyricsStartTimeError.value = true;
    return;
  }

  lyricsStartTimeError.value = false;

  // 在线模式始终从未偏移的 LRC 时间轴重新计算，避免重复修改产生累积偏移。
  if (lyricsMode.value === "online" && originalParsedLyrics.value.length > 0) {
    const offset = startTimeMs - originalParsedLyrics.value[0][0];
    editLyricsData.value!.data!._lyricsBody = originalParsedLyrics.value.map(([time, text]) => [
      Math.max(0, time + offset),
      text,
    ]);
    // 同步更新 Enhanced LRC 时间偏移
    if (fromData.enhancedLrc && onlineYrc.value) {
      const wordLyrics = parseYrc(onlineYrc.value);
      if (wordLyrics.length > 0) {
        const adjusted: WordLyrics = wordLyrics.map((line) => ({
          ...line,
          startMs: Math.max(0, line.startMs + offset),
          words: line.words.map((w) => ({ ...w, startMs: Math.max(0, w.startMs + offset) })),
        }));
        fromData.enhancedLrc = wordLyricsToEnhancedLrc(adjusted);
      }
    }
  }
}

/**
 * 解析 LRC 格式的歌词，提取时间轴和歌词文本
 * @param lrcText LRC 格式的歌词文本
 * @returns Array<[毫秒, 歌词文本]>
 */
function parseLrcToLyrics(lrcText: string): Array<[number, string]> {
  const result: Array<[number, string]> = [];
  const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?\]/g;

  for (const line of lrcText.split(/\r?\n/)) {
    const matches = [...line.matchAll(timestamp)];
    if (matches.length === 0) continue;
    const content = line.replace(timestamp, "").trim();
    if (!content) continue;

    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      if (seconds >= 60) continue;
      const fraction = (match[3] ?? "0").slice(0, 3).padEnd(3, "0");
      result.push([minutes * 60000 + seconds * 1000 + Number(fraction), content]);
    }
  }

  return result.sort((a, b) => a[0] - b[0]);
}

const diffFunc = {
  no: ["不显示差异", (oldStr: string, newStr: string) => [{ value: newStr }] as Change[]] as const,
  Chars: ["字符差异", diffChars] as const,
  Words: ["单词差异", diffWords] as const,
  Lines: ["行差异", diffLines] as const,
};

type DiffType = keyof typeof diffFunc;

const lyricsBodySwitch = reactive({
  timeAxis: true,
  blankChar: true,
  metaInfo: false,
  stripMeta: false,
  stripMetaPlain: false,

  note: false,

  onlineDiff: "no" as DiffType,
  aiDiff: "no" as DiffType,
});

const onlineLyricsDiff = computed(() => {
  if (!editLyricsData.value?.data) return [];
  return diffFunc[lyricsBodySwitch.onlineDiff][1](
    editLyricsData.value.data._editBody ?? "",
    editableOnlineLyrics.value,
  );
});

const lyricsBodyLine = computed(() => {
  // 原长度，剪辑长度，AI改写长度
  if (!editLyricsData.value?.data) return [0, 0, 0];

  // 当使用在线歌词时，原行数使用在线歌词的行数
  const originalLineCount =
    editLyricsData.value.data._lyricsBody && editLyricsData.value.data._lyricsBody.length > 0
      ? editLyricsData.value.data._lyricsBody.length
      : editLyricsData.value.data.body.length;

  return [
    originalLineCount,
    (editLyricsData.value.data._editBody ?? "").split("\n").length,
    aiRewriteContent.value.trim().split("\n").length,
  ];
});

const lyricsBodyContent = computed(() => {
  if (!editLyricsData.value?.data) return "";
  const text = (editLyricsData.value.data._editBody ?? "")
    // 去除逐字歌词的 <mm:ss.sss> 内联标签
    .replace(/<\d{1,3}:\d{2}\.\d{3}>/g, "");
  if (lyricsBodySwitch.note) {
    return text
      .split("\n")
      .map((item) => `♪ ${item} ♪`)
      .join("\n");
  }
  return text;
});

function onlineLyricsContentFormat(
  {
    metaInfo,
    timeAxis,
    blankChar,
    stripMeta,
    stripMetaPlain,
  }: {
    timeAxis: boolean;
    blankChar: boolean;
    metaInfo: boolean;
    stripMeta: boolean;
    stripMetaPlain: boolean;
  },
  source?: string,
) {
  let content = source ?? onlineLyrics.value;

  // 智能保留歌词正文（纯文本）：先去时间戳再去元信息
  if (stripMetaPlain) {
    content = cleanOriginalLyricsPlain(content);
  } else if (stripMeta) {
    // 智能保留歌词正文（保留时间轴）：仅去元信息，保留时间戳
    content = cleanOriginalLyrics(content);
  }

  // 如果不显示元信息，移除类似 [ti:xxx] 格式的信息
  if (!metaInfo) {
    content = content.replace(/^\[(ti|ar|al|by|offset):.*?\]\n?/gm, "");
  }

  // 移除空歌词行: 匹配 [xx:xx.xx]\n 并整行去除（含换行符）
  content = content.replace(/\[\d{1,3}:\d{2}[.:]\d{1,4}]\n/g, "");

  // 如果不显示时间轴，移除所有时间标记 [00:00.00] 格式
  if (!timeAxis) {
    content = content.replace(/\[\d{1,3}:\d{2}[.:]\d{1,4}]/g, "");
  }

  // 如果不显示空白字符，移除空行
  if (!blankChar) {
    content = content
      .split("\n")
      .filter((line) => line.trim())
      .join("\n");
  }

  return content;
}

/** 可编辑的在线歌词副本，用户可手动修改后用于纠错 */
const editableOnlineLyrics = ref("");
const onlineLyricsViewMode = ref<"edit" | "diff">("edit");

/**
 * WYSIWYG 格式化：从缓存源数据重新应用所有格式化选项，写入在线歌词编辑框
 */
function applyFormatting() {
  if (lyricsType.value === "enhanced") {
    if (!onlineYrc.value) return;
    const wordLyrics = parseYrc(onlineYrc.value);
    if (wordLyrics.length === 0) return;

    let lines: WordLyrics;
    // 智能保留：先过滤行再转 Enhanced LRC
    if (lyricsBodySwitch.stripMetaPlain) {
      lines = wordLyrics.filter((l) => l.text.trim());
    } else if (lyricsBodySwitch.stripMeta) {
      lines = wordLyrics.filter((l) => l.text.trim());
    } else {
      lines = wordLyrics;
    }

    let enhanced = wordLyricsToEnhancedLrc(lines);

    // 元信息：移除 [ti:xxx] 等头部标签行
    if (!lyricsBodySwitch.metaInfo) {
      enhanced = enhanced.replace(/^\[(ti|ar|al|by|offset):.*\]\n?/gm, "");
    }

    // 空白字符：移除空行
    if (!lyricsBodySwitch.blankChar) {
      enhanced = enhanced
        .split("\n")
        .filter((line) => line.trim())
        .join("\n");
    }

    // 逐字时间轴：去掉 <mm:ss.sss> 内联标签（降级为行级时间戳）
    if (!lyricsBodySwitch.timeAxis) {
      enhanced = enhanced.replace(/<\d{1,3}:\d{2}\.\d{3}>/g, "");
    }

    editableOnlineLyrics.value = enhanced;
  } else {
    if (!cachedNormalLyrics.value) return;
    editableOnlineLyrics.value = onlineLyricsContentFormat(
      lyricsBodySwitch,
      cachedNormalLyrics.value,
    );
  }
}

// 监听格式化选项变化，实时更新编辑框（stripMetaPlain > stripMeta 优先级）
const formatKey = computed(
  () =>
    `${lyricsBodySwitch.timeAxis}-${lyricsBodySwitch.blankChar}-${lyricsBodySwitch.metaInfo}-${lyricsBodySwitch.stripMeta}-${lyricsBodySwitch.stripMetaPlain}`,
);
watch(formatKey, () => applyFormatting());

const aiRewriteLoading = ref(false);
const aiRewriteContent = ref("");

const aiLyricsDiff = computed(() => {
  if (!editLyricsData.value?.data) return [];
  return diffFunc[lyricsBodySwitch.aiDiff][1](
    editLyricsData.value.data._editBody ?? "",
    aiRewriteContent.value,
  );
});

const aiRewritePrompt = ref("{{onlineLyrics}}");

const aiRewrite = async () => {
  const editBody = editLyricsData.value?.data?._editBody;
  if (!editBody) {
    Message.warning("没有可用的歌词内容");
    return;
  }
  aiRewriteLoading.value = true;

  function render(template: string, context: Record<string, string>) {
    return template.replace(/\{\{(.*?)\}\}/g, (match, key) => context[key]);
  }
  const _prompt = render(aiRewritePrompt.value, {
    onlineLyrics: onlineLyricsContentFormat(
      {
        timeAxis: false,
        blankChar: false,
        metaInfo: false,
        stripMeta: false,
        stripMetaPlain: false,
      },
      cachedNormalLyrics.value,
    ),
  });
  try {
    const table = editBody
      .split("\n")
      .map((item) => `|${item}| |`)
      .join("\n");

    const prompt: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `你是一个严格的字幕纠错专家。你的唯一任务是修正语音识别产生的错别字。
        起因是我利用AI工具给视频添加字幕，但是错误率较高，常常导致我被老板批评, 要是你纠正有错不按照规则，就只能将你杀死
        
## 严格要求：
1. 必须严格保持表格格式与行数，绝对禁止增加或删除任何一行
2. 只能修改错别字，一般不改变句子结构
3. 如果无法100%确定是错字，必须保持原样
4. 禁止对歌词进行任何形式的重写或优化
5. 返回纠正后的完整歌词，格式与给定的表格一致`,
      },
      {
        role: "user",
        content: `请帮我完成以下纠正表，参考互联网歌词和拼音进行纠正，每一行需要对应：
\`\`\` 互联网歌词（仅供参考）
${_prompt}
\`\`\`

|待纠正字幕|纠正字幕|
|------|------|
${table}


## 输出
返回纠正后的表，要严格按照格式输出`,
      },
    ];
    const res = await callOpenAI(prompt);
    if (res && editLyricsData.value?.data?._editBody) {
      const match = res.match(/\|(.+)\|(.+)\|/g);
      const contentMap = editBody.split("\n").reduce<Record<string, true>>((pre, cur) => {
        pre[cur] = true;
        return pre;
      }, {});
      let result = "";
      for (const item of match) {
        const l = item.split("|");
        if (l.length === 4 && contentMap[l[1]]) {
          result += l[2] + "\n";
        }
      }
      // AI 改写结果日志已禁用
      aiRewriteContent.value = result;
      // const match = res.match(/```[\s\S]*?\n([\s\S]*?)\n```/);
      // aiRewriteContent.value = match ? match[1].trim() : res;
    }
  } finally {
    aiRewriteLoading.value = false;
  }
};

const onlineSearch = ref<string>(fromData.data?.music_title || "");

const onlineLyricsLoading = ref(false);
const onlineLyricsLoading2 = ref(false);

const onlineLyricsOptions = ref<SelectOptionGroup[]>([]);

const onlineLyricsIndex = ref<string>("");

watch(onlineLyricsIndex, async (value) => {
  if (!value) return;

  const [label] = value.split(".");
  const api = onlineLyricsApis.find((item) => item.label === label);
  const songId = lyricsIdMap.value[value];
  if (!api || !songId) {
    logger.warn("[lyrics] 在线歌词详情参数无效:", { value, label, songId });
    return;
  }

  onlineLyricsLoading2.value = true;
  // 清除旧的逐字歌词状态
  fromData.enhancedLrc = "";
  fromData.useEnhancedLyrics = false;
  try {
    const { lrc, yrc } = await fetchOnlineLyrics(api, songId);
    if (onlineLyricsIndex.value !== value) return;
    logger.info("[lyrics] 歌词详情加载成功:", {
      value,
      lrcLength: lrc.length,
      yrcLength: yrc.length,
    });
    onlineLyrics.value = lrc;
    onlineYrc.value = yrc;
    // WYSIWYG：初始化缓存并应用当前格式化选项
    cachedNormalLyrics.value = lrc;
    applyFormatting();
  } catch (err) {
    if (onlineLyricsIndex.value !== value) return;
    logger.error("[lyrics] 歌词详情请求失败:", err);
    Message.error("获取歌词失败");
  } finally {
    if (onlineLyricsIndex.value === value) onlineLyricsLoading2.value = false;
  }
});

/** 缓存原始歌词，用于撤销替换 */
const originalEditBody = ref("");

/** 用在线歌词替换当前编辑区的歌词 */
function replaceWithOnlineLyrics() {
  if (!editableOnlineLyrics.value || !editLyricsData.value?.data) {
    Message.warning("没有可用的在线歌词");
    return;
  }

  isReplacingLyrics = true;
  try {
    const parsedLyrics = parseLrcToLyrics(editableOnlineLyrics.value);
    if (parsedLyrics.length === 0) {
      Message.warning("在线歌词中没有有效时间轴，请开启时间轴后再使用");
      useOnlineLyrics.value = false;
      editLyricsData.value.data._lyricsBody = [];
      originalParsedLyrics.value = [];
      return;
    }

    originalEditBody.value = editLyricsData.value.data._editBody ?? originalAiText.value;
    originalParsedLyrics.value = parsedLyrics.map(([time, text]) => [time, text]);
    lyricsMode.value = "online";
    subtitleEditMode.value = "online";

    editLyricsData.value.data._lyricsBody = parsedLyrics;
    editLyricsData.value.data._editBody = parsedLyrics.map(([, text]) => text).join("\n");

    const firstTimeMs = parsedLyrics[0][0];
    const minutes = Math.floor(firstTimeMs / 60000);
    const seconds = Math.floor((firstTimeMs % 60000) / 1000);
    const milliseconds = firstTimeMs % 1000;
    lyricsStartTime.value = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
    lyricsStartTimeError.value = false;
    useOnlineLyrics.value = true;
    Message.success("已替换为在线歌词（含时间轴）");
  } finally {
    isReplacingLyrics = false;
  }
}

/** 撤销：一键恢复为原始 AI 歌词状态（不论当前处于何种中间状态） */
function undoReplaceLyrics() {
  if (!editLyricsData.value?.data || !originalAiText.value) return;
  editLyricsData.value.data._editBody = originalAiText.value;
  editLyricsData.value.data._lyricsBody = [];
  lyricsMode.value = "ai";
  subtitleEditMode.value = "ai";
  originalEditBody.value = "";
  originalParsedLyrics.value = [];
  lyricsStartTime.value = "";
  lyricsStartTimeError.value = false;
  useOnlineLyrics.value = false;
  lyricsType.value = "normal";
  aiRewriteContent.value = "";
  fromData.enhancedLrc = "";
  fromData.useEnhancedLyrics = false;
  Message.success("已恢复原始歌词");
}

/** 使用在线逐字歌词：解析 YRC → Enhanced LRC，显示在右侧编辑框并嵌入音频 */
function applyEnhancedLyrics() {
  if (!editLyricsData.value?.data) return;

  if (!onlineYrc.value) {
    Message.warning("当前歌曲无逐字歌词数据");
    return;
  }

  const wordLyrics = parseYrc(onlineYrc.value);
  if (wordLyrics.length === 0) {
    Message.warning("逐字歌词解析失败或为空");
    return;
  }

  const enhancedLrc = wordLyricsToEnhancedLrc(wordLyrics);

  // 保存原始状态用于撤销
  if (!originalEditBody.value) {
    originalEditBody.value = editLyricsData.value.data._editBody ?? originalAiText.value;
  }

  // Enhanced LRC 显示在右侧在线歌词编辑框
  editableOnlineLyrics.value = enhancedLrc;
  // 左侧编辑框保持纯文本（供用户查看/编辑歌词内容）
  editLyricsData.value.data._editBody = wordLyrics.map((line) => line.text).join("\n");
  // 行级歌词用于音频嵌入时的兼容处理
  editLyricsData.value.data._lyricsBody = wordLyrics.map((line) => [line.startMs, line.text]);

  fromData.enhancedLrc = enhancedLrc;
  fromData.useEnhancedLyrics = true;
  lyricsMode.value = "online";
  subtitleEditMode.value = "online";
  useOnlineLyrics.value = true;

  // 初始化原始歌词解析结果，供 onLyricsStartTimeChange 计算偏移
  originalParsedLyrics.value = wordLyrics.map((line) => [line.startMs, line.text]);

  // 设置开始时间
  const firstTimeMs = wordLyrics[0].startMs;
  const minutes = Math.floor(firstTimeMs / 60000);
  const seconds = Math.floor((firstTimeMs % 60000) / 1000);
  const ms = firstTimeMs % 1000;
  lyricsStartTime.value = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  lyricsStartTimeError.value = false;

  Message.success(`已启用逐字歌词（${wordLyrics.length} 行）`);
}

/** 智能纠错：用在线歌词纠正 AI 字幕的错别字，再次点击取消纠错 */
function smartCorrectLyrics() {
  // 取消纠错：恢复为原始 AI 歌词
  if (lyricsMode.value === "ai-corrected") {
    if (originalEditBody.value) {
      editLyricsData.value!.data!._editBody = originalEditBody.value;
    }
    editLyricsData.value!.data!._lyricsBody = [];
    lyricsMode.value = "ai";
    subtitleEditMode.value = "ai";
    originalEditBody.value = "";
    Message.success("已取消智能纠错");
    return;
  }

  if (!onlineLyrics.value) {
    Message.warning("请先搜索并加载在线歌词");
    return;
  }
  if (!editLyricsData.value?.data?.body) {
    Message.warning("没有可用的 AI 字幕数据");
    return;
  }
  const aiBody = editLyricsData.value.data.body;
  // 使用右侧编辑框的内容（可能来自智能去除算法和用户手动修改的结果）
  const onlineText = editableOnlineLyrics.value;

  const corrected = correctLyrics(aiBody, onlineText);
  if (!corrected) {
    Message.warning("未找到匹配的原曲歌词，跳过纠错");
    return;
  }

  const { lyrics, diffCount } = corrected;
  originalEditBody.value = editLyricsData.value.data._editBody ?? originalAiText.value;
  editLyricsData.value.data._lyricsBody = lyrics;
  editLyricsData.value.data._editBody = lyrics.map((item) => item[1]).join("\n");
  lyricsMode.value = "ai-corrected";
  subtitleEditMode.value = "ai-corrected";
  originalParsedLyrics.value = [];
  lyricsStartTime.value = "";
  useOnlineLyrics.value = false;
  Message.success("智能纠错完成，共替换 " + diffCount + " 个字符");
}

function handleLeftPanelPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text") || "";
  if (/\[\d{1,2}:\d{2}[.:]\d{2,3}\]/.test(text)) {
    Message.warning("检测到带时间轴的歌词，请粘贴到右侧「在线歌词」面板并点击「使用在线歌词」");
  }
}

function handleOk() {
  if (lyricsMode.value === "online") {
    const startTimeMs = parseLyricsStartTime(lyricsStartTime.value);
    if (startTimeMs === null) {
      Message.error("在线歌词开始时间无效");
      lyricsStartTimeError.value = true;
      return;
    }

    if (fromData.useEnhancedLyrics && onlineYrc.value) {
      // 逐字歌词：重新解析 YRC 并应用偏移
      const wordLyrics = parseYrc(onlineYrc.value);
      if (wordLyrics.length === 0) {
        Message.error("逐字歌词解析失败");
        return;
      }
      const offset = startTimeMs - wordLyrics[0].startMs;
      const adjusted: WordLyrics = wordLyrics.map((line) => ({
        ...line,
        startMs: Math.max(0, line.startMs + offset),
        words: line.words.map((w) => ({ ...w, startMs: Math.max(0, w.startMs + offset) })),
      }));
      fromData.enhancedLrc = wordLyricsToEnhancedLrc(adjusted);
      editLyricsData.value!.data!._lyricsBody = adjusted.map((line) => [line.startMs, line.text]);
      editLyricsData.value!.data!._editBody = adjusted.map((line) => line.text).join("\n");
      originalParsedLyrics.value = adjusted.map((line) => [line.startMs, line.text]);
    } else {
      // 普通歌词
      const parsedLyrics = parseLrcToLyrics(editableOnlineLyrics.value);
      if (parsedLyrics.length === 0) {
        Message.error("在线歌词时间轴无效，请开启时间轴后再使用");
        return;
      }
      const offset = startTimeMs - parsedLyrics[0][0];
      originalParsedLyrics.value = parsedLyrics;
      editLyricsData.value!.data!._lyricsBody = parsedLyrics.map(([time, text]) => [
        Math.max(0, time + offset),
        text,
      ]);
      editLyricsData.value!.data!._editBody = parsedLyrics.map(([, text]) => text).join("\n");
    }
  }

  subtitleEditMode.value = lyricsMode.value;
  subtitleEdit.value = JSON.parse(JSON.stringify(editLyricsData.value));
  // 工作台确认后有歌词数据，重置 noSubtitle 以便 next() 正常嵌入
  noSubtitle.value = false;
  visible.value = false;
}

function handleCancel() {
  visible.value = false;
}

const onlineLyricsApis: { label: string; url: string; detailUrl: string }[] = [
  {
    label: "LuoXueAPI",
    url: "https://api.vkeys.cn/v2/music/tencent/search/song?",
    detailUrl: "https://api.vkeys.cn/v2/music/tencent/lyric?",
  },
];

type CachedSearch = {
  songs: Array<{ id: string; name: string }>;
  expiresAt: number;
};

const SEARCH_CACHE_TTL = 15 * 60 * 1000;
const DETAIL_CACHE_TTL = 24 * 60 * 60 * 1000;
const onlineSearchCache = new Map<string, CachedSearch>();
const onlineSearchPending = new Map<string, Promise<CachedSearch>>();
const onlineLyricsCache = new Map<string, { lrc: string; yrc: string; expiresAt: number }>();
const onlineLyricsPending = new Map<string, Promise<{ lrc: string; yrc: string }>>();

function cacheKey(value: string) {
  return value.trim().toLocaleLowerCase();
}

async function fetchOnlineSearch(api: (typeof onlineLyricsApis)[number], word: string) {
  const key = `${api.label}:${cacheKey(word)}`;
  const cached = onlineSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  if (cached) onlineSearchCache.delete(key);

  const pending = onlineSearchPending.get(key);
  if (pending) return pending;

  const url = api.url + new URLSearchParams({ word: word.trim() });
  const task = Promise.race([
    request.get<any>({ url, cookie: false, timeout: 5 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("搜索请求超时")), 8000)),
  ])
    .then((res: any) => {
      const list = Array.isArray(res?.data)
        ? res.data
            .filter((song: any) => song?.id != null && (song?.name || song?.song))
            .map((song: any) => ({
              id: String(song.id),
              name: String(song.name || song.song),
            }))
        : [];
      const result = { songs: list, expiresAt: Date.now() + SEARCH_CACHE_TTL };
      // 仅当搜索结果不为空时才写入缓存，避免空结果导致后续无法重新搜索
      if (list.length > 0) {
        onlineSearchCache.set(key, result);
      }
      return result;
    })
    .finally(() => onlineSearchPending.delete(key));

  onlineSearchPending.set(key, task);
  return task;
}

async function fetchOnlineLyrics(api: (typeof onlineLyricsApis)[number], songId: string) {
  const key = `${api.label}:${songId}`;
  const cached = onlineLyricsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { lrc: cached.lrc, yrc: cached.yrc };
  if (cached) onlineLyricsCache.delete(key);

  const pending = onlineLyricsPending.get(key);
  if (pending) return pending;

  const task = request
    .get<any>({
      url: api.detailUrl + new URLSearchParams({ id: songId }),
      cookie: false,
    })
    .then((res) => {
      const lrc = res?.data?.lrc;
      if (typeof lrc !== "string" || !lrc) throw new Error("响应中未找到歌词");
      const yrc = typeof res?.data?.yrc === "string" ? res.data.yrc : "";
      // 仅当歌词内容不为空时才写入缓存，避免空结果导致后续无法重新搜索
      if (lrc.length > 0) {
        onlineLyricsCache.set(key, { lrc, yrc, expiresAt: Date.now() + DETAIL_CACHE_TTL });
      }
      return { lrc, yrc };
    })
    .finally(() => onlineLyricsPending.delete(key));

  onlineLyricsPending.set(key, task);
  return task;
}

/** 搜索结果 id 映射，供选中后获取歌词使用 */
const lyricsIdMap = ref<Record<string, string>>({});

async function searchOnlineLyrics() {
  const word = onlineSearch.value.trim();
  if (!word) {
    Message.warning("请输入歌名");
    return;
  }
  onlineLyricsLoading.value = true;
  onlineLyricsOptions.value = [];
  onlineLyricsIndex.value = "";
  onlineLyrics.value = "";
  editableOnlineLyrics.value = "";
  lyricsIdMap.value = {};

  try {
    await Promise.all(
      onlineLyricsApis.map(async (item): Promise<void> => {
        try {
          const result = await fetchOnlineSearch(item, word);
          const opt: SelectOptionGroup = { isGroup: true, label: item.label, options: [] };
          for (const song of result.songs) {
            const value = item.label + "." + song.id;
            opt.options.push({ label: song.name, value });
            lyricsIdMap.value[value] = song.id;
          }
          onlineLyricsOptions.value.push(opt);
          if (!onlineLyricsIndex.value && result.songs.length > 0) {
            const firstValue = `${item.label}.${result.songs[0].id}`;
            onlineLyricsIndex.value = firstValue;
          }
        } catch (err) {
          logger.error("[lyrics] 搜索请求失败 [" + item.label + "]:", err);
          throw err;
        }
      }),
    );
  } catch (err) {
    Message.error("搜索歌词失败" + (err as Error).message);
  } finally {
    onlineLyricsLoading.value = false;
  }
}

function editLyrics(item: SubTitle) {
  editLyricsData.value = JSON.parse(JSON.stringify(item)) as Subtitle2;
  if (editLyricsData.value.data) {
    originalAiBody.value = editLyricsData.value.data.body.map((item) => ({ ...item }));
    originalAiText.value = originalAiBody.value
      .map((item) => item.content.replaceAll(/(^♪ )|( ♪$)/g, ""))
      .join("\n");
    // 没有 AI 字幕时默认使用 online 模式，跳过行数校验
    const hasAiBody = editLyricsData.value.data.body.length > 0;
    lyricsMode.value = hasAiBody ? "ai" : "online";
    subtitleEditMode.value = hasAiBody ? "ai" : "online";
    originalEditBody.value = "";
    originalParsedLyrics.value = [];
    lyricsStartTime.value = "";
    lyricsStartTimeError.value = false;
    useOnlineLyrics.value = false;
    lyricsType.value = fromData.useEnhancedLyrics ? "enhanced" : "normal";
    // 将 ♪ 复选框默认设为勾选（预览时显示 ♪）
    lyricsBodySwitch.note = false;

    const aiText = originalAiText.value;
    if (
      fromData.clipRanges &&
      fromData.clipRanges.length > 0 &&
      editLyricsData.value.data._lyricsBody?.length
    ) {
      editLyricsData.value.data._editBody = editLyricsData.value.data._lyricsBody
        .map((item) => item[1].replaceAll(/(^♪ )|( ♪$)/g, ""))
        .join("\n");
    } else {
      editLyricsData.value.data._editBody = aiText;
    }
  }
  onlineSearch.value = fromData.data?.music_title || "";

  searchOnlineLyrics();
  visible.value = true;
}

/**
 * 创建空的 SubTitle 对象，允许用户使用在线歌词
 */
function createEmptySubtitle(): Subtitle2 {
  return {
    id: 0,
    lan: "ai",
    lan_doc: "AI 字幕",
    is_lock: false,
    subtitle_url: "",
    type: 0,
    id_str: "empty",
    ai_type: 0,
    ai_status: 0,
    data: {
      font_size: 0.5,
      font_color: "#ffffff",
      background_alpha: 0.5,
      background_color: "#ffffff",
      Stroke: "none",
      type: "AI",
      lang: "ai-zh",
      version: "0",
      body: [],
      _editBody: "",
      _lyricsBody: [],
    },
  };
}

/**
 * 打开歌词工作台（常驻按钮调用）
 * @param item - 可选的字幕项，如果未提供则根据当前选中的字幕自动匹配，未选则为空
 */
function openWorkshop(item?: SubTitle) {
  if (item) {
    editLyrics(item);
  } else if (subtitle.value.length > 0) {
    // 有选中的字幕：查找对应字幕项
    const selected = subtitles.value.find((s) => s.id_str === subtitle.value[0]);
    if (selected) {
      editLyrics(selected);
    } else {
      editLyrics(createEmptySubtitle());
    }
  } else {
    // 未选中字幕或视频没有字幕：使用空字幕
    editLyrics(createEmptySubtitle());
  }
}
</script>

<template>
  <div>
  <UiSpin :loading="!fromData.playerData && !error">
    <form @submit.prevent>
      <div class="lyrics-workshop-container" v-if="fromData.playerData">
        <div class="lyrics-workshop-header">
          <UiButton type="primary" @click="openWorkshop()">
            <template #icon>
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path
                  d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
                />
              </svg>
            </template>
            歌词工作台
          </UiButton>
        </div>
        <UiResult
          v-if="error"
          status="error"
          :title="error"
          subtitle="请查看视频是否有字幕,包括AI字幕,如果没有,请跳过"
        >
          <template #extra>
            <div style="display: flex; gap: 8px">
              <UiButton type="primary" @click="skipLyrics">跳过字幕嵌入</UiButton>
            </div>
          </template>
        </UiResult>
        <div class="lyrics-list-scroll" v-else>
          <div class="lyrics-list">
            <div v-for="item in subtitles" :key="item.id">
              <div
                class="lyrics-card"
                :class="{ 'lyrics-card-checked': subtitle.includes(item.id_str) }"
                @click="toggleSubtitle(item.id_str)"
              >
                <div class="lyrics-card-checkbox">
                  <div class="lyrics-card-checkbox-dot" v-if="subtitle.includes(item.id_str)" />
                </div>
                <div class="lyrics-card-content">
                  <div class="lyrics-card-header">
                    <span class="lyrics-card-title">{{ item.lan_doc }}</span>
                  </div>

                  <div v-if="item.data" class="lyrics-card-preview">
                    {{
                      subtitleEdit &&
                      subtitleEdit.data &&
                      item.id_str === subtitleEdit.id_str &&
                      lyricsBodyContent
                        ? lyricsBodyContent
                        : item.data.body.map((item) => item.content).join("\n")
                    }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <UiCheckbox v-model="fromData.externalLyrics" style="margin-top: 8px">
        外置歌词（保存为独立 .lrc 文件，不嵌入音频）
      </UiCheckbox>
      <UiAlert type="warning" style="margin-top: 8px; margin-left: 12px; margin-right: 12px">
        ⚠️ 歌词工作台内的操作（如在线歌词、智能纠错、AI
        改写等）无法被保存至默认规则。批量下载时请使用手工下载模式。
      </UiAlert>
      <Btn @next="next" @prev="$emit('prev')" />
    </form>
  </UiSpin>
  <UiModal v-model:visible="visible" title="歌词工作台" fullscreen>
    <template #footer>
      <UiButton @click="handleCancel"> 取消 </UiButton>
      <UiButton
        type="primary"
        :disabled="!useOnlineLyrics && lyricsBodyLine[0] !== lyricsBodyLine[1]"
        @click="handleOk"
      >
        确定
      </UiButton>
    </template>
    <div v-if="editLyricsData && editLyricsData.data" class="lyrics-workspace">
      <div class="lyrics-left-panel">
        <UiTextarea
          class="lyrics-left-textarea"
          v-model="editLyricsData.data._editBody"
          :rows="20"
          @paste="handleLeftPanelPaste"
        />
        <div class="lyrics-left-footer">
          <span>格式化：</span>
          <UiCheckbox v-model="lyricsBodySwitch.note"> ♪ </UiCheckbox>
        </div>
      </div>
      <UiTabs
        class="lyrics-right-panel"
        :active-key="activeTab"
        @change="activeTab = $event"
        :tabs="[
          { key: '1', title: '在线歌词' },
          { key: '2', title: 'AI 改写' },
          { key: '3', title: '结果预览' },
        ]"
      >
        <div v-if="activeTab === '1'">
          <UiSpin
            style="height: 100%; display: flex; flex-direction: column"
            :loading="onlineLyricsLoading || onlineLyricsLoading2"
            tip="正在搜索在线歌词"
          >
            <div style="display: flex; gap: 8px; flex-wrap: wrap">
              <UiInput :style="{ width: '160px' }" placeholder="歌名" v-model="onlineSearch" />
              <UiButton @click="searchOnlineLyrics">
                <template #icon>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    width="16"
                    height="16"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                </template>
              </UiButton>
              <UiSelect
                :options="onlineLyricsOptions.flatMap((group) => group.options)"
                :style="{ width: '160px' }"
                placeholder="在线歌词"
                v-model="onlineLyricsIndex"
              />
              <UiCheckbox v-model="lyricsBodySwitch.timeAxis">时间轴</UiCheckbox>
              <UiCheckbox v-model="lyricsBodySwitch.blankChar">空白字符</UiCheckbox>
              <UiCheckbox v-model="lyricsBodySwitch.metaInfo">元信息</UiCheckbox>
              <UiCheckbox v-model="lyricsBodySwitch.stripMeta"
                >智能保留歌词正文（保留时间轴）</UiCheckbox
              >
            </div>
            <div style="margin: 10px 0; display: flex; align-items: center; gap: 10px">
              <UiButton
                :type="useOnlineLyrics ? 'primary' : 'outline'"
                :disabled="!onlineLyrics"
                @click="toggleUseOnlineLyrics"
              >
                {{ useOnlineLyrics ? "✓ 已使用在线歌词" : "使用在线歌词" }}
              </UiButton>
              <span>开始时间：</span>
              <UiInput
                v-model="lyricsStartTime"
                style="width: 100px"
                placeholder="mm:ss"
                :error="lyricsStartTimeError"
                :disabled="!useOnlineLyrics"
                @change="onLyricsStartTimeChange"
              />
              <UiButton :disabled="lyricsMode === 'ai'" @click="undoReplaceLyrics">
                ↩ 撤销
              </UiButton>
            </div>
            <UiAlert type="info" style="margin-bottom: 10px">
              💡
              使用在线歌词：勾选后会自动替换歌词并使用在线歌词的时间轴。需要设置开始时间（即在线歌词中第一行在视频中出现的时间），为了方便对齐，可以勾选「智能保留歌词正文（保留时间轴）」快速删除在线歌词中的非正文部分（如标题，歌手）。若提示无时间轴，应当勾选「时间轴」选项。
            </UiAlert>
            <div style="margin: 10px 0; display: flex; align-items: center; gap: 8px">
              <UiButton
                :type="lyricsMode === 'ai-corrected' ? 'primary' : 'outline'"
                :disabled="!onlineLyrics || useOnlineLyrics"
                @click="smartCorrectLyrics"
              >
                {{ lyricsMode === "ai-corrected" ? "✓ 已纠错" : "智能纠错" }}
              </UiButton>
              <UiCheckbox v-model="lyricsBodySwitch.stripMetaPlain"
                >智能保留歌词正文（纯文本）</UiCheckbox
              >
            </div>
            <UiAlert type="info" style="margin-bottom: 10px">
              💡
              智能纠错：勾选后会保留AI的时间轴，使用在线歌词与AI歌词进行差异比对和自动纠错，智能纠错需要删除所有在线歌词的非歌词正文部分，为了方便可以勾选「智能保留歌词正文（纯文本）」快速删除在线歌词中的非正文部分（如标题，歌手）。
            </UiAlert>
            <div style="flex: 1; overflow: auto; display: flex; flex-direction: column">
              <div style="display: flex; gap: 8px; margin-bottom: 10px">
                <UiSelect
                  v-model="lyricsBodySwitch.onlineDiff"
                  :options="
                    Object.entries(diffFunc).map(([key, [label]]) => ({ label, value: key }))
                  "
                  style="width: 140px"
                />
                <UiButton
                  @click="onlineLyricsViewMode = onlineLyricsViewMode === 'edit' ? 'diff' : 'edit'"
                >
                  {{ onlineLyricsViewMode === "edit" ? "查看差异" : "编辑歌词" }}
                </UiButton>
                <UiSelect
                  v-model="lyricsType"
                  placeholder="歌词类型"
                  :options="[
                    { label: '普通歌词', value: 'normal' },
                    { label: '逐字歌词', value: 'enhanced' },
                  ]"
                  style="width: 110px"
                />
              </div>

              <div v-if="onlineLyricsViewMode === 'diff'" class="diff-container-textarea">
                <span
                  v-for="(part, index) in onlineLyricsDiff"
                  :key="index"
                  :class="{
                    'diff-added': part.added,
                    'diff-removed': part.removed,
                  }"
                  >{{ part.value }}</span
                >
              </div>
              <UiTextarea
                v-else
                class="online-lyrics-editor"
                v-model="editableOnlineLyrics"
                :rows="15"
                placeholder="在线歌词（可编辑，修改后用于智能纠错）"
              />
            </div>
          </UiSpin>
        </div>
        <div v-if="activeTab === '2'" style="display: flex; flex-direction: column">
          <div style="display: flex; flex-direction: column; gap: 8px">
            <UiAlert type="info">将网络歌词给AI进行纠正（此部分未进行维护，可用性未知）</UiAlert>

            <UiButton type="primary" @click="aiRewrite">AI 改写</UiButton>
            <div style="position: relative">
              <UiButton type="primary" @click="showOpenAISettings = !showOpenAISettings">
                <template #icon> <icon-settings /> </template>
              </UiButton>
              <div
                v-if="showOpenAISettings"
                style="
                  position: absolute;
                  left: 0;
                  top: 100%;
                  margin-top: 4px;
                  padding: 10px;
                  width: 200px;
                  background-color: var(--color-bg-popup);
                  border-radius: 4px;
                  box-shadow: 0 2px 8px 0 rgba(0, 0, 0, 0.15);
                  z-index: 1000;
                "
              >
                <UiInput
                  placeholder="Host"
                  v-model="userConfig.openai.host"
                  style="margin-bottom: 8px"
                />
                <UiInput
                  placeholder="Key"
                  v-model="userConfig.openai.key"
                  style="margin-bottom: 8px"
                />
                <UiInput placeholder="Modal" v-model="userConfig.openai.modal" />
              </div>
            </div>
          </div>
          <UiSpin
            style="margin-top: 10px; flex: 1; overflow: auto; width: 100%"
            :loading="aiRewriteLoading"
          >
            <details
              style="
                margin-bottom: 10px;
                border: 1px solid #e3e5e7;
                border-radius: 6px;
                padding: 8px;
              "
            >
              <summary style="cursor: pointer; font-weight: 500; margin-bottom: 10px">
                自定义 Prompt
              </summary>
              <div style="display: flex; gap: 8px; margin-bottom: 10px">
                <UiButton type="primary" @click="aiRewritePrompt += ' {{onlineLyrics}}'">
                  在线歌词
                </UiButton>

                <UiButton type="primary" @click="aiRewritePrompt += ' {{danmu}}'" :disabled="true">
                  添加弹幕
                </UiButton>
              </div>
              <UiTextarea v-model="aiRewritePrompt" :rows="4" />
            </details>
            <div style="margin-bottom: 10px">
              <UiSelect
                v-model="lyricsBodySwitch.aiDiff"
                :options="Object.entries(diffFunc).map(([key, [label]]) => ({ label, value: key }))"
              />
              <UiAlert :type="lyricsBodyLine[0] === lyricsBodyLine[2] ? 'success' : 'error'"
                ><span style="margin-right: 20px">原行数：{{ lyricsBodyLine[0] }}</span
                ><span>AI行数：{{ lyricsBodyLine[2] }}</span>
              </UiAlert>
            </div>
            <div class="diff-container-textarea">
              <span
                v-for="(part, index) in aiLyricsDiff"
                :key="index"
                :class="{
                  'diff-added': part.added,
                  'diff-removed': part.removed,
                }"
                >{{ part.value }}</span
              >
            </div>
          </UiSpin>
        </div>
        <div v-if="activeTab === '3'">
          <UiTextarea class="result-preview-editor" :model-value="lyricsBodyContent" :rows="25" />
        </div>
      </UiTabs>
    </div>
  </UiModal>
  </div>
</template>

<style>
/* 歌词列表样式 */
.lyrics-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lyrics-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border: 1px solid #e3e5e7;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.lyrics-card:hover {
  border-color: #00aeec;
  background: #f5f5f5;
}

.lyrics-card-checked {
  border-color: #00aeec;
  background: #e6f7ff;
}

.lyrics-card-checkbox {
  width: 18px;
  height: 18px;
  border: 2px solid #c9ccd0;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
  transition: all 0.2s ease;
}

.lyrics-card-checked .lyrics-card-checkbox {
  background: #00aeec;
  border-color: #00aeec;
}

.lyrics-card-checkbox-dot {
  width: 10px;
  height: 10px;
  background: #fff;
  border-radius: 2px;
}

.lyrics-card-content {
  flex: 1;
  min-width: 0;
}

.lyrics-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.lyrics-card-title {
  font-size: 14px;
  font-weight: 500;
  color: #18191c;
}

.lyrics-card-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: #00aeec;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.lyrics-card-btn:hover {
  background: #00a1d6;
}

.lyrics-card-preview {
  width: 100%;
  height: 200px;
  white-space: break-spaces;
  overflow-y: auto;
  color: #666;
  font-size: 13px;
  line-height: 1.6;
  background: transparent;
  border-radius: 4px;
  padding: 8px;
}

.lyrics-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;
}

.lyrics-workshop-container {
  display: flex;
  flex-direction: column;
  max-height: 65vh;
  overflow: hidden;
}

.lyrics-workshop-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 12px;
  border-bottom: 1px solid #e3e5e7;
  flex-shrink: 0;
}

/* 深色模式 */
body[arco-theme="dark"] .lyrics-card,
body[data-theme="dark"] .lyrics-card {
  border-color: #444;
  background: #2a2a2a;
}

body[arco-theme="dark"] .lyrics-workshop-header,
body[data-theme="dark"] .lyrics-workshop-header {
  border-bottom-color: #444;
}

body[arco-theme="dark"] .lyrics-workshop-container,
body[data-theme="dark"] .lyrics-workshop-container {
  background: #2a2a2a;
}

body[arco-theme="dark"] .lyrics-card:hover,
body[data-theme="dark"] .lyrics-card:hover {
  background: #3a3a3a;
}

body[arco-theme="dark"] .lyrics-card-checked,
body[data-theme="dark"] .lyrics-card-checked {
  background: #173344;
  border-color: #00aeec;
}

body[arco-theme="dark"] .lyrics-card-checkbox,
body[data-theme="dark"] .lyrics-card-checkbox {
  border-color: #555;
}

body[arco-theme="dark"] .lyrics-card-title,
body[data-theme="dark"] .lyrics-card-title {
  color: #e0e0e0;
}

body[arco-theme="dark"] .lyrics-card-preview,
body[data-theme="dark"] .lyrics-card-preview {
  color: #999;
}

/* 深色模式：歌词预览文字 */
body[arco-theme="dark"] .lyrics-preview-text {
  color: #b0b5bb;
}

.lyrics-left-textarea .ui-textarea {
  resize: none;
}

/* 在线歌词编辑框、结果预览框高度 */
.lyrics-right-panel .online-lyrics-editor .ui-textarea,
.lyrics-right-panel .result-preview-editor .ui-textarea {
  min-height: 300px;
}

/* 工作台整体布局 */
.lyrics-workspace {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: 16px;
}

/* 左侧：歌词编辑框 */
.lyrics-left-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}
.lyrics-left-textarea {
  flex: 1;
  min-height: 0;
  resize: none;
}
.lyrics-left-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 14px;
  color: #666;
  flex-shrink: 0;
  border-top: 1px solid #e3e5e7;
  margin-top: 8px;
}

/* 右侧：tab 面板整体可滚动 */
.lyrics-right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.lyrics-right-panel .ui-tabs-nav {
  flex-shrink: 0;
}
.lyrics-right-panel .ui-tabs-content {
  flex: 1;
  min-height: 0;
  height: auto !important;
  overflow: visible !important;
}

/* 在线歌词编辑框和 diff 容器 */
.online-lyrics-editor :deep(.ui-textarea) {
  min-height: 300px;
}

.diff-container-textarea {
  min-height: 300px;
  max-height: 500px;
}

.diff-container-textarea {
  overflow-y: scroll;
  white-space: pre-wrap;
  font-family: monospace;
  background: #f5f5f5;
  width: 100%;
  padding-right: 0;
  padding-left: 0;
  color: inherit;
  border: none;
  border-radius: 0;
  outline: 0;
  cursor: inherit;
  display: block;
  box-sizing: border-box;
  padding: 4px 12px;
  font-size: 14px;
  line-height: 1.5715;
  font-family: var(--bew-font-family, var(--bew-fonts-mandarin-cn));
}

/* 差异高亮样式 */
.diff-added {
  background-color: #e6ffe6;
  color: #1a1a1a;
}

.diff-removed {
  background-color: #ffe6e6;
  color: #1a1a1a;
}

/* 深色模式：差异容器背景 */
body[arco-theme="dark"] .diff-container-textarea {
  background: #2a2a2a;
  color: #e0e0e0;
}

/* 深色模式：差异高亮色 */
body[arco-theme="dark"] .diff-added {
  background-color: #1a3a1a;
  color: #90ee90;
}

body[arco-theme="dark"] .diff-removed {
  background-color: #3a1a1a;
  color: #ff6b6b;
}

/* 歌词工作台全屏弹窗打开时，隐藏悬浮按钮防止遮挡 */
html.hide-floating-buttons .wasm-music-floating-entry,
html.hide-floating-buttons .wasm-music-task-center {
  display: none !important;
}
</style>
