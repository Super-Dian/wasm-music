/**
 * YRC（逐字歌词）解析器与 Enhanced LRC 转换工具。
 *
 * 标准 YRC 格式（QQ 音乐）：
 *   [lineStartMs,lineDurMs]char(startMs,durMs)char(startMs,durMs)...
 *   例：[30370,6360]陪(30370,440)伴(30810,468)三(31278,414)个(31693,361)
 *
 * Enhanced LRC 格式（卡拉 OK 播放器）：
 *   [mm:ss.sss] <mm:ss.sss>char1 <mm:ss.sss>char2 ...
 *   例：[00:30.370] <00:30.370>陪 <00:30.810>伴 <00:31.278>三 <00:31.693>个
 */

import type { WordLyrics, WordTiming } from "@/data";

/** 将毫秒转换为 LRC 时间戳格式 [mm:ss.sss] */
function formatLrcTimestamp(ms: number): string {
  const m = Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0");
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `[${m}:${s}]`;
}

/** 将毫秒转换为 Enhanced LRC 内联标签 <mm:ss.sss> */
function formatWordTag(ms: number): string {
  const m = Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0");
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return `<${m}:${s}>`;
}

/**
 * 解析 YRC 逐字歌词为结构化数据。
 *
 * YRC 行格式：[lineStartMs,lineDurMs]char(startMs,durMs)char(startMs,durMs)...
 * 例：[30370,6360]陪(30370,440)伴(30810,468)三(31278,414)
 */
export function parseYrc(yrcText: string): WordLyrics {
  const result: WordLyrics = [];

  for (const line of yrcText.split(/\r?\n/)) {
    // 用 indexOf 分离行时间戳 [startMs,durMs]，避免正则回溯问题
    const bracketEnd = line.indexOf("]");
    if (bracketEnd === -1) continue;
    const bracket = line.substring(1, bracketEnd);
    const commaIdx = bracket.indexOf(",");
    if (commaIdx === -1) continue;
    const lineStartMs = Number(bracket.substring(0, commaIdx));
    const rest = line.substring(bracketEnd + 1);
    if (!rest.trim()) continue;

    const words: WordTiming[] = [];
    let lineText = "";
    // 匹配 (startMs,durMs) 时间标记，用于定位切分点
    const timingPattern = /\((\d+),(\d+)\)/g;
    const timings: Array<{ startMs: number; durMs: number; index: number; length: number }> = [];
    let tm;
    while ((tm = timingPattern.exec(rest)) !== null) {
      timings.push({
        startMs: Number(tm[1]),
        durMs: Number(tm[2]),
        index: tm.index,
        length: tm[0].length,
      });
    }

    if (timings.length === 0) {
      // 没有时间标记，整行作为无时间轴文本
      for (const ch of rest) {
        words.push({ startMs: lineStartMs, durMs: 0, text: ch });
        lineText += ch;
      }
    } else {
      // 第一个时间标记之前的文本，使用行起始时间
      const leading = rest.slice(0, timings[0].index);
      for (const ch of leading) {
        words.push({ startMs: lineStartMs, durMs: 0, text: ch });
        lineText += ch;
      }
      // 将 rest 按时间标记切分为文本段，每段继承其后面那个标记的时间戳
      // segments[i] = 标记 i 和标记 i+1 之间的文本 → 用 timings[i+1] 的时间
      // 最后一段 = 最后一个标记之后的文本 → 用最后一个标记的时间
      for (let i = 0; i < timings.length; i++) {
        const textStart = timings[i].index + timings[i].length;
        const textEnd = i + 1 < timings.length ? timings[i + 1].index : rest.length;
        const text = rest.slice(textStart, textEnd);
        // 该段文本后面紧跟的标记的时间戳
        const ts = i + 1 < timings.length ? timings[i + 1] : timings[i];
        for (const ch of text) {
          words.push({ startMs: ts.startMs, durMs: ts.durMs, text: ch });
          lineText += ch;
        }
      }
    }

    if (words.length > 0) {
      result.push({ startMs: lineStartMs, text: lineText, words });
    }
  }

  return result.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 将 WordLyrics 转换为 Enhanced LRC 字符串。
 *
 * 输出格式（逐字级）：
 *   [mm:ss.sss]<mm:ss.sss>char1<mm:ss.sss>char2...
 *
 * @param hasWordTags false 时输出仅行标签的行级 LRC（timeAxis 关闭时的
 *   「降级为行级时间戳」往返保真），默认 true 保持既有调用点输出字节不变。
 */
export function wordLyricsToEnhancedLrc(wordLyrics: WordLyrics, hasWordTags = true): string {
  return wordLyrics
    .map((line) => {
      const lineTag = formatLrcTimestamp(line.startMs);
      if (!hasWordTags) return `${lineTag}${line.text}`;
      const charTags = line.words.map((w) => `${formatWordTag(w.startMs)}${w.text}`).join("");
      return `${lineTag}${charTags}`;
    })
    .join("\n");
}

/** parseEnhancedLrc 的结果：行结构 + 是否含字级标签 + 行在源文本中的物理行号 */
export type EnhancedParseResult = {
  lines: WordLyrics;
  /** 源文本至少含一个 <mm:ss.sss> 字级锚点（决定序列化是否输出字级标签） */
  hasWordTags: boolean;
  /** rawIndices[i] = lines[i] 在源文本中的物理行号（含被跳过的元信息行，供行级字符串手术定位） */
  rawIndices: number[];
};

/**
 * 解析 Enhanced LRC 为结构化数据（wordLyricsToEnhancedLrc 的逆运算）。
 *
 * 规则（与 parseLrcToLyrics / parseYrc 的跳行口径一致）：
 * - 行首必须有 [mm:ss(.fff)] 行标签，否则整行跳过；秒≥60、内容为空也跳过；
 * - 正文内 <mm:ss.sss> 为字锚点（正文中的 stray [mm:ss.sss] 也按锚点防御性处理，
 *   避免时间戳污染文本）；锚点前的字符继承行起始时间，锚点 k 后的字符继承锚点 k
 *   的时间直到下一锚点——序列化器给每个字符前置标签，本函数为其精确逆运算；
 * - words[].durMs 恒为 0（Enhanced LRC 不承载时长）；结果按 startMs 稳定排序，
 *   rawIndices 随行携带。
 */
export function parseEnhancedLrc(text: string): EnhancedParseResult {
  const lines: WordLyrics = [];
  const rawIndices: number[] = [];
  let hasWordTags = false;

  const rawLines = text.split(/\r?\n/);
  for (let k = 0; k < rawLines.length; k++) {
    const trimmed = rawLines[k].trim();
    if (!trimmed) continue;

    const lineTagMatch = trimmed.match(/^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?\]/);
    if (!lineTagMatch) continue;
    const minutes = Number(lineTagMatch[1]);
    const seconds = Number(lineTagMatch[2]);
    if (seconds >= 60) continue;
    const fraction = (lineTagMatch[3] ?? "0").slice(0, 3).padEnd(3, "0");
    const lineStartMs = minutes * 60000 + seconds * 1000 + Number(fraction);

    const rest = trimmed.slice(lineTagMatch[0].length);
    if (!rest.trim()) continue;

    // 锚点扫描：<mm:ss.sss> 与正文 stray [mm:ss.sss]；秒≥60 的匹配不作锚点（留作文本）
    const anchorPattern = /[<[](\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?[>\]]/g;
    const anchors: Array<{ startMs: number; index: number; end: number }> = [];
    let am: RegExpExecArray | null;
    while ((am = anchorPattern.exec(rest)) !== null) {
      const aMin = Number(am[1]);
      const aSec = Number(am[2]);
      if (aSec >= 60) continue;
      if (am[0].startsWith("<")) hasWordTags = true;
      const aFrac = (am[3] ?? "0").slice(0, 3).padEnd(3, "0");
      anchors.push({
        startMs: aMin * 60000 + aSec * 1000 + Number(aFrac),
        index: am.index,
        end: am.index + am[0].length,
      });
    }

    const words: WordTiming[] = [];
    let lineText = "";
    let pos = 0;
    let anchorTime = lineStartMs;
    const flush = (end: number, time: number) => {
      for (const ch of rest.slice(pos, end)) {
        words.push({ startMs: time, durMs: 0, text: ch });
        lineText += ch;
      }
    };
    for (const a of anchors) {
      flush(a.index, anchorTime);
      anchorTime = a.startMs;
      pos = a.end;
    }
    flush(rest.length, anchorTime);

    if (words.length === 0) continue;
    lines.push({ startMs: lineStartMs, text: lineText, words });
    rawIndices.push(k);
  }

  // 稳定排序，rawIndices 随行携带（表必须按时间升序，供时间轴二分查找）
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].startMs - lines[b].startMs);
  return {
    lines: order.map((i) => lines[i]),
    hasWordTags,
    rawIndices: order.map((i) => rawIndices[i]),
  };
}

/**
 * 平移单行字符串内的全部时间标签（[mm:ss.fff] 行标签与 <mm:ss.fff> 字标签）。
 * 逐标签钳到 ≥0；重新格式化为两位分钟 + 3 位毫秒。
 * 供行级写回（syncEnhancedLrcFromTimeline）对单个物理行做统一 δ 移位。
 */
export function shiftTimestampsInLine(line: string, deltaMs: number): string {
  if (!deltaMs) return line;
  return line.replace(
    /([<[])(\d{1,3}):(\d{2})(?:[.:](\d{1,4}))?[>\]]/g,
    (_m, open: string, mm: string, ss: string, frac: string | undefined) => {
      const base =
        Number(mm) * 60000 + Number(ss) * 1000 + Number((frac ?? "0").slice(0, 3).padEnd(3, "0"));
      const ms = Math.max(0, base + deltaMs);
      return open === "[" ? formatLrcTimestamp(ms) : formatWordTag(ms);
    },
  );
}

/**
 * 将 WordLyrics 转换为标准 LRC（降级，仅行级时间戳）。
 */
export function wordLyricsToStandardLrc(wordLyrics: WordLyrics): string {
  return wordLyrics.map((line) => `${formatLrcTimestamp(line.startMs)} ${line.text}`).join("\n");
}

/**
 * 处理 Enhanced LRC 的时间偏移（用于剪辑范围和倍速调整）。
 * 逻辑与 audio.vue 的 processLyrics 相同，但操作 Enhanced LRC 字符串。
 */
export function processEnhancedLrc(
  enhancedLrc: string,
  deleteRanges: Array<[number, number]>,
  speed: number,
): string {
  if (!deleteRanges || deleteRanges.length === 0) {
    if (speed === 1) return enhancedLrc;
    return adjustEnhancedLrcTimestamps(enhancedLrc, speed);
  }

  // 合并删除区间
  const sorted = [...deleteRanges]
    .map(([s, e]) => [Math.max(0, s), Math.max(0, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    if (merged.length > 0 && range[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  const lines = enhancedLrc.split(/\r?\n/);
  const result: string[] = [];

  for (const line of lines) {
    const lineMatch = line.match(/^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/);
    if (!lineMatch) {
      result.push(line);
      continue;
    }
    const lineMs =
      Number(lineMatch[1]) * 60000 +
      Number(lineMatch[2]) * 1000 +
      Number((lineMatch[3] ?? "0").padEnd(3, "0").slice(0, 3));

    const isInDeleted = merged.some(([s, e]) => lineMs >= s && lineMs < e);
    if (isInDeleted) continue;

    const deletedBefore = merged
      .filter(([s]) => lineMs >= s)
      .reduce((sum, [s, e]) => sum + (Math.min(lineMs, e) - s), 0);
    const adjustedLineMs = Math.max(0, (lineMs - deletedBefore) / speed);

    const restOfLine = line.substring(lineMatch[0].length);
    let newLine = `${formatLrcTimestamp(adjustedLineMs)}${restOfLine}`;

    // 替换所有 <mm:ss.sss> 内联标签
    newLine = newLine.replace(/<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>/g, (_, m, s, f) => {
      const tagMs =
        Number(m) * 60000 + Number(s) * 1000 + Number((f ?? "0").padEnd(3, "0").slice(0, 3));
      const adjustedTagMs = Math.max(0, (tagMs - deletedBefore) / speed);
      return formatWordTag(adjustedTagMs);
    });

    result.push(newLine);
  }

  return result.join("\n");
}

/** 替换 Enhanced LRC 中所有时间戳（用于纯调速场景） */
function adjustEnhancedLrcTimestamps(enhancedLrc: string, speed: number): string {
  return enhancedLrc.replace(
    /(?:^|\s)(\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]|<(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?>)/gm,
    (match, _full, m1, s1, f1, m2, s2, f2) => {
      const ms =
        m2 !== undefined
          ? Number(m2) * 60000 + Number(s2) * 1000 + Number((f2 ?? "0").padEnd(3, "0").slice(0, 3))
          : Number(m1) * 60000 + Number(s1) * 1000 + Number((f1 ?? "0").padEnd(3, "0").slice(0, 3));
      const adjusted = Math.max(0, ms / speed);
      return m2 !== undefined ? formatWordTag(adjusted) : formatLrcTimestamp(adjusted);
    },
  );
}
