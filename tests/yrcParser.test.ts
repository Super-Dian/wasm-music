import { describe, expect, test } from "bun:test";

import {
  parseEnhancedLrc,
  parseYrc,
  shiftTimestampsInLine,
  wordLyricsToEnhancedLrc,
} from "../src/utils/yrcParser";

describe("parseEnhancedLrc", () => {
  test("序列化 → 解析 → 序列化恒等（逐字级）", () => {
    const src =
      "[00:30.370]<00:30.370>陪<00:30.810>伴<00:31.278>三<00:31.693>个\n[00:40.000]<00:40.000>你";
    const parsed = parseEnhancedLrc(src);
    expect(parsed.hasWordTags).toBe(true);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].text).toBe("陪伴三个");
    expect(parsed.lines[0].startMs).toBe(30370);
    expect(parsed.lines[0].words.map((w) => w.startMs)).toEqual([30370, 30810, 31278, 31693]);
    expect(wordLyricsToEnhancedLrc(parsed.lines, parsed.hasWordTags)).toBe(src);
  });

  test("行级文档（无字级标签）往返保真，hasWordTags=false", () => {
    const src = "[00:10.000]第一句歌词\n[00:20.500]第二句歌词";
    const parsed = parseEnhancedLrc(src);
    expect(parsed.hasWordTags).toBe(false);
    expect(parsed.lines[0].text).toBe("第一句歌词");
    expect(wordLyricsToEnhancedLrc(parsed.lines, parsed.hasWordTags)).toBe(src);
  });

  test("首个锚点前的字符继承行起始时间", () => {
    const parsed = parseEnhancedLrc("[00:10.000]前导<00:11.000>正");
    expect(parsed.lines[0].words.map((w) => ({ t: w.startMs, c: w.text }))).toEqual([
      { t: 10000, c: "前" },
      { t: 10000, c: "导" },
      { t: 11000, c: "正" },
    ]);
  });

  test("跳过无行标签/秒≥60/空内容行，rawIndices 记录物理行号", () => {
    const src = [
      "歌名 - 歌手",
      "[00:10.000]甲",
      "[00:20.99]乙",
      "[00:70.000]坏行",
      "[00:40.000]",
    ].join("\n");
    const parsed = parseEnhancedLrc(src);
    expect(parsed.lines.map((l) => l.text)).toEqual(["甲", "乙"]);
    // 源行号：0(元信息跳) 1(甲) 2(乙) 3(秒≥60跳) 4(空内容跳)
    expect(parsed.rawIndices).toEqual([1, 2]);
  });

  test("结果按 startMs 稳定排序且 rawIndices 随行携带", () => {
    const src = "[00:50.000]后句\n[00:10.000]前句";
    const parsed = parseEnhancedLrc(src);
    expect(parsed.lines.map((l) => l.text)).toEqual(["前句", "后句"]);
    expect(parsed.rawIndices).toEqual([1, 0]);
  });

  test("正文 stray [mm:ss.fff] 按锚点处理，不污染文本", () => {
    const parsed = parseEnhancedLrc("[00:10.000]甲[00:11.000]乙");
    expect(parsed.hasWordTags).toBe(false);
    expect(parsed.lines[0].text).toBe("甲乙");
    expect(parsed.lines[0].words.map((w) => w.startMs)).toEqual([10000, 11000]);
  });
});

describe("shiftTimestampsInLine", () => {
  test("统一平移行标签与全部字标签", () => {
    const line = "[00:30.370]<00:30.370>陪<00:30.810>伴";
    expect(shiftTimestampsInLine(line, 1500)).toBe("[00:31.870]<00:31.870>陪<00:32.310>伴");
    expect(shiftTimestampsInLine(line, -1000)).toBe("[00:29.370]<00:29.370>陪<00:29.810>伴");
  });

  test("负向移位逐标签钳到 0", () => {
    expect(shiftTimestampsInLine("[00:00.370]<00:00.370>陪", -1000)).toBe(
      "[00:00.000]<00:00.000>陪",
    );
  });

  test("delta=0 原样返回", () => {
    const line = "[00:30.370]<00:30.370>陪";
    expect(shiftTimestampsInLine(line, 0)).toBe(line);
  });
});

describe("parseYrc 与 Enhanced 往返协同", () => {
  test("YRC → Enhanced LRC → 解析还原相同行结构", () => {
    const yrc = "[30370,6360]陪(30370,440)伴(30810,468)";
    const wordLyrics = parseYrc(yrc);
    const enhanced = wordLyricsToEnhancedLrc(wordLyrics);
    const parsed = parseEnhancedLrc(enhanced);
    expect(parsed.hasWordTags).toBe(true);
    expect(parsed.lines[0].text).toBe(wordLyrics[0].text);
    expect(parsed.lines[0].startMs).toBe(wordLyrics[0].startMs);
    expect(parsed.lines[0].words.map((w) => w.startMs)).toEqual(
      wordLyrics[0].words.map((w) => w.startMs),
    );
  });
});
