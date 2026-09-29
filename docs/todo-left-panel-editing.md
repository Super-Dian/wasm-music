# 待办：歌词工作台左面板编辑在「在线歌词」模式下生效

> 状态：**已决策——不实现该功能；改为「只读 + 视觉提示」（已实现）**
> 决策依据：在线歌词一般本身是准确的，用户只需用「时间轴」Tab 对齐开头，左面板改文本收益低；
> 但用户默认不知道在线模式下左面板编辑不生效，因此只需给出视觉提示。
> 实现内容：
>
> 1. `src/steps/lyrics.vue` 左面板顶部增加 `lyricsMode === 'online'` 时的只读提示条（`.lyrics-left-hint`，含暗色适配）；
> 2. 同条件下 `UiTextarea` 传 `:readonly`，杜绝敲字后被 `handleOk` 从右框整表重建静默冲掉。
>    下文第二、三节保留为排查记录，**不再需要实现**（若日后重新评估，决策点仍在）。
>    关联提交：前一功能（逐字时间轴写回 / 高亮 / 字条微调 / 删除开始时间）已合入 `c9cd16a`。
>    右框定位已确认：**保持可编辑**（字级结构手改入口，与左面板经行拼接同步）。
>    ~~生效范围未定：仅逐字模式 vs 普通在线模式也放开。~~（随功能取消而失效）

## 一、问题本质

- 左面板（`_editBody` 简化文本）的编辑在**任何在线歌词模式**下都不生效，
  根源是 `_editBody` watcher 入口的守卫（`src/steps/lyrics.vue`，`watch(() => editLyricsData.../_editBody` 内）：

  ```ts
  if (lyricsMode.value === "online") return; // 在线模式整段跳过
  ```

- **为什么这样设计**（CLAUDE.md「online 模式边界」）：在线模式的文本权威是**右侧在线歌词编辑框**——
  `handleOk` 每次用右框 parse 整表重建左面板文本。若允许左面板同步，敲的字会在点「确定」时被右框静默冲掉
  （或两源互踩），于是入口禁用，左面板退化为只读展示。
- **对普通在线合理**：右框格式 `[00:15.20]作词作曲的人`，时间戳在行首、正文直接可改，不缺编辑入口。
- **对逐字（enhanced）不合理（本次痛点）**：右框是
  `[00:15.20]<00:15.20>作<00:15.56>词…` 每个字带标签，隔着标签改文本体验差，
  而唯一天然的简化文本面板（左面板）不生效。

## 二、关键代码事实（行号可能漂移，以函数名为准）

| 位置                                           | 事实                                                                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_editBody` watcher                            | 守卫 `mode === "online"` 整段 return；非在线时做：撤销基线捕获（dirty false→true）→ `_lyricsBody` 文本回写（行数一致才写）                                                                             |
| `next()`                                       | online → 读 `_lyricsBody`；ai → `_editBody` 按行 zip 进 `body[].from`（行数必须等于 AI 字幕行数）；ai-corrected → 读 `_lyricsBody`                                                                     |
| `handleOk`                                     | online 普通：dirty 时文本取右框 parse（行数一致），非 dirty 整表从框重建；online 逐字：`textsDiffer` 门（框文本 vs enhancedLrc 文本）决定是否按框重基，否则仅 `syncEnhancedLrcFromTimeline()` 归并时间 |
| `applyEnhancedLyrics`                          | 写 `_editBody` 时**没有** `markInternalEditBodyWrite()`——目前靠 watcher 的 online 守卫兜底；一旦放开守卫必须补                                                                                         |
| `parseEnhancedLrc`（`src/utils/yrcParser.ts`） | 跳过无行标签行、秒≥60、**无内容行**（`!rest.trim()` continue / `words.length===0` continue）→ 逐字模式下「留空行占位」的合并工作流天然不通                                                             |
| 撤销基线                                       | 三方快照 `_lyricsBody` + `enhancedLrc` + `_editBody`（三处 dirty 捕获点：`onTimelineCommit` / `onTimelineWordCommit` / `_editBody` watcher）；**不含右框**                                             |

## 三、方案决策点（规划用）

1. **权威归属**：逐字模式下文本权威是否移到左面板（右框 = 格式视图 + 字级手改入口）？
   决定 `handleOk` 的 `textsDiffer` 门如何改造。
2. **文本变更后的字级时间**（绕不开）：改文本 = 字符数变化 = 旧 `<...>` 标签与新字符错位。候选：
   - **按字符位置比例重映射**（同长度时精确等于原映射；插入/删除时近似）——推荐；
   - 只保前缀、余下归行首；
   - 改文本即该行降级为行级时间戳。
3. **空行/合并工作流**：`parseEnhancedLrc` 需否保留 `[00:40.000]` 这种仅行标签的空行，
   以支持「挪文本 + 留空行」的合并流程（现在会因跳行导致行数不齐）。
4. **三处文本同步时机**：左面板（即时）↔ `_lyricsBody` ↔ `enhancedLrc` ↔ 右框（行拼接）。
   逐击键 parse+serialize 开销可接受（2-4KB 正则级）；右框逐击键重写会动其光标状态，需权衡。
5. **撤销基线扩成四方**：必须把**右框内容**纳入 dirty 捕获，否则撤销后右框残留编辑后文本，
   经 `textsDiffer` 会把已撤销的改动带回（非 dirty 的整表重建路径还会直接以右框为准）。
6. **程序性写入抑制**：放开守卫后，`applyEnhancedLyrics`、`handleOk` 各分支写 `_editBody`
   需补 `markInternalEditBodyWrite()`，否则一应用/一确定就误亮撤销、拍错基线。
7. **普通在线是否同放开**（范围未定）：普通在线右框好编辑、收益小，但两模式行为会不一致。

## 四、已知相邻坑（与本方案无关，规划时值得知道）

- `useEnhancedLyrics` / `enhancedLrc` 在 `editLyrics`（重开工作台）时**不清除**——
  上一场逐字会话的残留可能在后续 AI 流程里劫持导出（`audio.vue` 只看 flag）；
  `replaceWithOnlineLyrics`（普通应用）也未清这两个字段。
- 普通在线的 `parseLrcToLyrics` 同样跳过空内容行 → 普通在线的合并空行工作流本来也不通。

## 五、上一功能（c9cd16a）遗留验证

- [ ] 手动 R0：在线模式左面板顶部出现只读提示、文本框 readonly（灰底、暗色同样可辨）；时间轴选中仍能跳转选中行；AI/智能纠错模式下无提示且可正常编辑
- [ ] `npm test`（需 bun；本机当时未装，`tests/yrcParser.test.ts` 的断言已用 Node 24 原生 TS 等价验证过）
- [ ] 手动 R1：在线 Tab 无开始时间输入；时间轴整体偏移/拖拽完成对齐 → 导出时间正确
- [ ] 手动 R2：逐字「智能保留（保留时间轴/纯文本）」生效、与普通模式提示一致；改右框文本后「使用在线歌词」生效且不覆写框
- [ ] 手动 R4：行级拖拽 → 导出该行行标签+全部字标签精确平移、行内间距不变；撤销整体回滚
- [ ] 手动 R5：预览区逐字高亮（行锚定、随拖拽走、文本未归并行回退纯文本）
- [ ] 手动 R6：字条微调 chips、±10/±50 钳制、对齐播放指针、确定后进导出、撤销回滚、暗色样式
- [ ] `npm run lint` 若 tsgolint panic（已知环境问题），用基础规则配置回退

## 附：快速定位

- 歌词工作台主体：`src/steps/lyrics.vue`（watcher / handleOk / applyEnhancedLyrics / syncEnhancedLrcFromTimeline / onTimelineWordCommit）
- 时间轴编辑器：`src/components/LyricsTimeline.vue`（高亮 `updateActiveWord`、字条 `nudgeWord`/`applyWordTime`、预览 `.lt-preview`）
- 解析层：`src/utils/yrcParser.ts`（`parseEnhancedLrc` / `wordLyricsToEnhancedLrc` / `shiftTimestampsInLine` / `processEnhancedLrc`）
- 元信息判定：`src/utils/lyricsCorrector.ts`（`isMetaLine`，已导出）
- 行为契约文档：`CLAUDE.md`（Lyrics System / Lyrics Timeline 两节）
