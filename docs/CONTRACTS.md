# 内部契约（冻结版 v1）

> 本文件是各模块之间的**接口契约**。改动这里 = 改动所有人的代码，改前先确认。
> 所有模块均为零依赖 ESM，`node --test` 可直接跑（除 `src/ui/*` 需要 DOM）。

## 0. 命名与常量

```
EXT_ID      = 'beatrice-guide'
EXT_NAME    = '碧翠丝的禁书库'
TAG         = '[碧翠丝]'
SETTINGS_KEY= 'beatriceGuide'        // ctx.extensionSettings / extension_settings 下的键
CHAT_KEY    = 'beatrice-guide'       // ctx.chatMetadata 下的键
CSS_PREFIX  = 'bg-'                  // 所有 class 前缀，避免污染酒馆样式
```

## 1. 配置对象（`getSettings(ctx)` 的返回值）

存于 `ctx.extensionSettings[SETTINGS_KEY]`，由 `saveSettingsDebounced()` 落盘。
**所有字段必须有兜底默认值**，缺字段的老配置必须能升级。

```js
{
  schemaVersion: 1,
  enabled: true,                 // 总开关
  cadence: {
    mode: 'every-n',             // 'every-n' | 'probability' | 'always'
    everyN: 2,                   // every-n 模式：每 N 轮 AI 回复引导一次
    probability: 0.5,            // probability 模式：0~1
    cooldownMs: 20000,           // 两次引导之间的最短间隔，防连点
  },
  worldbook: {
    bookNames: [],               // [] = 自动发现（角色卡/聊天/全局勾选）
    tags: ['引导', '钩子', '剧情', '地点', '事件', '线索'],  // 注释前缀白名单
    excludeTags: ['禁止引导', '剧透', '勿引导'],  // 命中这些前缀直接排除
    maxHooks: 24,                // 一次最多取多少条钩子送进提示词
    maxHookChars: 300,           // 单条钩子截断
    includeConstantEntries: true,// 常量条目（蓝灯）也算钩子
  },
  commentary: {
    enabled: true,               // 吐槽单独开关
    maxChars: 40,                // 单句上限（写进提示词约束）
    allowFollowUp: false,        // 是否允许第二句
  },
  guidance: {
    enabled: true,
    maxChars: 60,
    hintOnly: true,              // 「不可直接指明目的地」硬约束
  },
  llm: {
    mode: 'profile',             // 'profile' | 'tavern-helper' | 'custom' | 'main'
    profileId: '',               // mode==='profile' 时用
    custom: { url: '', key: '', model: '', temperature: 1.0, maxTokens: 400 },
    timeoutMs: 45000,
    maxTokens: 400,
    temperature: 1.0,
  },
  injection: {
    mode: 'appended',            // 'appended'（正文后追加小字系统消息）| 'off'
    isSmallSys: true,
    speakerName: '贝翠丝',
    maxChars: 600,               // 整条注入消息上限
  },
  ui: {
    showAvatar: true,
    avatarPos: { x: 24, y: 220 },
    avatarSize: 96,
    bubbleSide: 'auto',          // 'auto' | 'left' | 'right'
    bubbleDurationMs: 15000,     // 气泡自动消失时间，0 = 不自动消失
    idleAnimation: true,
    customImage: '',             // 相对扩展目录的图片路径，空则用内置 SVG
  },
  persona: {
    name: '贝翠丝',
    overridePrompt: '',          // 非空则整段替换内置人设
  },
}
```

## 2. 钩子对象（世界书读取层输出）

```js
/** @typedef {Object} Hook
 * @property {string} book      来源世界书名
 * @property {number} uid       条目 uid
 * @property {string} comment   条目标题（原始）
 * @property {string[]} tags    从 comment 解析出的标签，如 ['引导','地点']
 * @property {string} content   条目正文（已按 maxHookChars 截断）
 * @property {boolean} constant 是否常量条目
 * @property {number} order     插入顺序
 */
```

标签解析规则（`parseEntryTags`）：对条目的 `comment` 依次尝试

1. `[引导] 旧城区的传言` / `【地点】王都下水道` / `（线索）卖花女人` → tag + 括号外的名字
2. `[引导·旧城区]` / `[引导：旧城区]` / `[引导|旧城区]` → tag + 括号内的名字
3. `引导 - 旧城区`（前缀 `tag` + 分隔符 `- — : ： · | / \ >`）→ tag + 名字
4. 无任何标签 → `tags=[]`，仅在 `includeConstantEntries` 为真且条目是常量时兜底入选

⚠️ **括号是标签区域的边界。** 名字从标签取到**下一个括号**为止，所以注释里的
说明性文字**不能再带括号** —— 否则名字会被切到说明里的那一段去。实测踩到的例子：

```
[地点] 王都下水道 ← 中文方头括号【】也可以，[地点] 也在白名单里
         → 名字被切成「也在白名单里」（错）
[地点] 王都下水道 ← 中文方头括号也可以
         → 名字是「王都下水道」（对）
```

名字的收尾清洗由 `normalizeLabel()` 负责：在 `← → ⇒ # |` 处截断、剥掉包裹的
书名号/引号、去掉尾部孤立标点。**刻意不剥 `-` 和 `—`** —— 它们是合法的名字成分，
剥了会把 `引导 - 旧城区` 的名字吃空。

## 3. 上下文快照（送给辅助 API 的东西）

```js
/** @typedef {Object} GuideContext
 * @property {string} userName
 * @property {string} charName
 * @property {string} sceneText     最近 N 条消息拼成的节选（每条截断）
 * @property {string} lastUserText  用户最后一条发言（吐槽素材）
 * @property {string} lastAiText    最新 AI 正文（判断剧情走到哪）
 * @property {Hook[]} hooks         候选钩子
 * @property {number} turnIndex     当前是第几条 AI 消息
 * @property {string} recentSpoken  最近几次贝翠丝说过的话（去重用，避免重复）
 */
```

## 4. 辅助 API 输出（严格 JSON）

模型必须只返回一个 JSON 对象，**不要 markdown 代码块**：

```json
{
  "guidance": "……",
  "commentary": "……",
  "emotion": "calm",
  "hooks_used": ["旧城区"]
}
```

字段约束：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `guidance` | string | 是 | 0~`guidance.maxChars` 字符；**不得出现具体地名/人名作为目的地指令**；不得出现"你应该去/你必须" |
| `commentary` | string | 否 | 0~`commentary.maxChars` 字符，吐槽向 |
| `emotion` | enum | 否 | `calm` \| `smug` \| `annoyed` \| `worried` \| `smile` \| `thinking` |
| `hooks_used` | string[] | 否 | 用到的钩子 label，仅用于调试面板 |

解析层 `parseGuideResult(text)` 必须容错：
- 剥掉 ```json 围栏、前后说明文字
- 抓第一个平衡的 `{...}`
- 字段缺失/超长 → 按约束截断而非丢弃
- 完全解析失败 → 把纯文本当 `guidance` 兜底（若长度合理）

## 5. 注入消息格式

正文（`mes`）模板：

```
【贝翠丝的低语】
「guidance」

—— 贝翠丝：commentary
```

实际渲染由 `buildInjectionText(result, settings)` 生成，超出 `injection.maxChars` 时优先砍 commentary。

注入的 message 对象（与 tavern-dice 保持一致，便于识别自家消息）：

```js
{
  name: settings.injection.speakerName,
  is_user: false,
  is_system: true,              // 隐藏，不发给 LLM
  mes: text,
  extra: {
    beatriceGuide: { injected: true, at: <ms>, emotion, hooksUsed, reason },
  },
  swipes: [text],
  swipe_id: 0,
}
```

落盘：`ctx.addOneMessage(msg, { isSmallSys })` → `await ctx.saveChat()`（群聊可能抛，要 catch）。

## 6. 事件挂接

| 事件 | 用途 |
|---|---|
| `GENERATION_AFTER_COMMANDS` | 主模型开跑 → **并发启动**辅助 API 请求（关键：抢在正文结束前拿到结果） |
| `GENERATION_ENDED` | 兜底：若并发请求没起过，现在起 |
| `MESSAGE_RECEIVED` | 排除自家注入消息（防回环），其余情况按 cadence 决定是否引导 |
| `CHAT_CHANGED` | 清空去重记忆、重读世界书、清空气泡 |
| `WORLDINFO_UPDATED` / `WORLDINFO_ENTRIES_LOADED` | 让钩子缓存失效 |
| `SETTINGS_UPDATED` | 同步悬浮窗可见性 |

**防回环**：`isOwnInjectedMessage(ctx, id)` 检查 `chat[id].extra.beatriceGuide.injected`。

## 7. 运行时状态（`window.BeatriceGuide.state()` 输出）

```js
{
  version, enabled, llmMode, hooksCount, lastHooks: [...labels],
  lastResult: { guidance, commentary, emotion, hooks_used } | null,
  lastError: string | null,
  inflight: boolean,
  turnIndex: number,
  spokenHistory: string[],
}
```

## 8. 悬浮窗 DOM 契约（`src/ui/floating.js` 产出）

```html
<div class="bg-root" data-emotion="calm">
  <div class="bg-bubble" hidden>
    <div class="bg-bubble-head">贝翠丝</div>
    <div class="bg-bubble-body"></div>
    <button class="bg-bubble-close" aria-label="关闭">×</button>
  </div>
  <button class="bg-avatar" aria-label="贝翠丝">
    <!-- 内置 SVG 或 <img class="bg-avatar-img" src="..."> -->
    <span class="bg-badge" hidden>1</span>
  </button>
</div>
```

对外 API：

```js
createFloatingBeatrice({ settings, onAvatarClick, onAvatarMove })
  -> { node, say(text, { emotion, durationMs, sticky }), hide(), setVisible(bool),
       setEmotion(name), setBadge(text|null), destroy(), isBubbleOpen }
```

## 9. 模块归属（谁负责哪个文件）

| 文件 | 内容 |
|---|---|
| `index.js` | 启动、等待 ctx、事件挂接、斜杠命令、调试入口 |
| `src/config.js` | 常量、默认配置、配置合并与校验、`deriveExtensionFolder` |
| `src/core/store.js` | 配置读写、chatMetadata 读写、去重记忆 |
| `src/worldbook.js` | 世界书发现与读取、标签解析、钩子筛选 |
| `src/context.js` | 组装 `GuideContext` |
| `src/prompts.js` | 贝翠丝人设 + 引导/吐槽提示词 |
| `src/llm/client.js` | 四通道 LLM 客户端 |
| `src/llm/guide.js` | 调 LLM、解析 JSON、去重 |
| `src/inject.js` | 注入文本构造 + 落盘 |
| `src/ui/floating.js` | 悬浮窗组件 |
| `src/ui/panel.js` | 酒馆扩展设置面板 |
| `src/ui/dom.js` | 小工具（el/toast/drawer/field） |
