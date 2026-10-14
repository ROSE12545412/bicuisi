/**
 * 碧翠丝的禁书库 —— SillyTavern / TauriTavern 扩展入口
 * ===========================================================================
 *
 * 一句话说明：读世界书里的剧情钩子，用独立的辅助 API 生成一句「贝翠丝的低语」，
 * 在正文写完后作为小字系统消息插进聊天，同时在她的悬浮窗里用对话气泡说出来。
 *
 *   ┌─ 世界书（[引导]/[地点]/[钩子] 标签的条目）
 *   │        │  读取
 *   │        ▼
 *   │   钩子池 ──► 辅助 API（独立通道）──► { guidance, commentary, emotion }
 *   │                    ▲                        │
 *   │  用户发言 + 最近场面 ┘                        ▼
 *   │                                     ┌────────┴────────┐
 *   │                                     ▼                 ▼
 *   │                              悬浮窗气泡          聊天小字注入
 *   └─ 去重记忆（chatMetadata）◄───────────┘
 *
 * ── 时序（体验关键）──────────────────────────────────────────────────
 *  辅助请求在 `GENERATION_AFTER_COMMANDS`（正文开始生成）时就并发发出，
 *  而不是等正文写完。辅助模型通常 1~5 秒返回，正文通常 20~40 秒，
 *  所以正文结束时结果早已到手，可以立刻出声，用户感觉不到等待。
 *
 * ── 三条不可妥协的原则 ────────────────────────────────────────────────
 *  1. **不改正文**。正文是用户和正文模型的产物，插件只追加独立的隐藏消息。
 *  2. **不越权操纵剧情**。引导通过用户生效（用户读了才知道往哪走），
 *     注入的消息是隐藏的，不会进正文模型的上下文。
 *  3. **失败必须安静**。辅助 API 挂了、世界书读不到、连接超时 ——
 *     都只是这一轮不出声，绝不能让酒馆报错或卡住用户聊天。
 */

import { EXT_ID, EXT_NAME, TAG, CODE_REVISION, deriveExtensionFolder } from './src/config.js';
import { getSettings, saveSettings } from './src/core/store.js';
import { GuideController } from './src/app.js';
import { createFloatingBeatrice } from './src/ui/floating.js';
import { createSettingsWindow } from './src/ui/panel.js';
import {
    appendGuidanceToMessage,
    clearPendingAppends,
    flushPendingAppends,
    patchUpdateMessageBlock,
    pendingAppendCount,
    repairDisplayedGuidance,
    observeDisplayedGuidance,
} from './src/inject.js';
import { toast } from './src/ui/dom.js';
import { describeError } from './src/llm/client.js';
import { installRealmWorldbookGuard } from './src/realm-worldbook.js';

/** 扩展目录名（从自身 URL 推导，用户改了文件夹名也不会错）。 */
const EXT_FOLDER = deriveExtensionFolder(import.meta.url);

/**
 * 把「相对插件目录」的资源路径解析成浏览器可直接取的 URL。
 *
 * 为什么要这一步：用户在设置里填的是 `assets/my-beatrice.png` 这种相对路径，
 * 但浏览器解析相对 URL 是相对于**当前页面**（酒馆根目录 `/`），
 * 直接塞给 `<img src>` 会 404。而插件实际挂在
 * `/scripts/extensions/third-party/<文件夹名>/` 下，文件夹名还可能被用户改名。
 *
 * 已经是绝对路径（`http://`、`https://`、`/`、`data:`）时原样返回，
 * 这样也支持用户直接填一个图床地址。
 *
 * @param {string} value 用户填的路径
 * @param {string} folder 插件文件夹名
 * @returns {string}
 */
function resolveAssetUrl(value, folder) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    if (/^(https?:|data:|blob:|\/)/i.test(s)) return s;
    return `/scripts/extensions/third-party/${folder}/${s.replace(/^\.\//, '')}`;
}

/** 运行期单例。 */
const runtime = {
    /** @type {GuideController|null} */
    app: null,
    /** @type {any} */
    ui: null,
    /** @type {any} 插件自己的设置窗（首次打开时才创建） */
    settingsWindow: null,
    booted: false,
};

// ---------------------------------------------------------------------------
// 等待酒馆就绪
// ---------------------------------------------------------------------------

/**
 * 取得酒馆上下文。
 *
 * 扩展脚本可能在 `SillyTavern` 全局就绪之前就被加载（尤其是
 * `loading_order` 靠前、或者 TauriTavern 的加载时序和原版 ST 不同），
 * 所以这里轮询等待，而不是假设它已经在了。
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function waitForContext(timeoutMs = 30000) {
    const started = Date.now();
    const immediate = tryGetContext();
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const ctx = tryGetContext();
            if (ctx) {
                clearInterval(timer);
                resolve(ctx);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                clearInterval(timer);
                reject(new Error('等待 SillyTavern 就绪超时'));
            }
        }, 150);
    });
}

/** 安全地取上下文。确认关键字段已就绪，避免拿到半成品。 */
function tryGetContext() {
    try {
        const st = /** @type {any} */ (globalThis).SillyTavern;
        if (st && typeof st.getContext === 'function') {
            const ctx = st.getContext();
            if (ctx && ctx.eventSource && ctx.chatMetadata !== undefined) return ctx;
        }
    } catch {
        /* 还没就绪 */
    }
    return null;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

/** 启动扩展。 */
async function boot() {
    if (runtime.booted) return;
    const ctx = await waitForContext();
    runtime.booted = true;

    const settings = getSettings(ctx);
    console.log(`${TAG} 加载中…（扩展目录 ${EXT_FOLDER}）`);

    const app = new GuideController(ctx, settings);
    app.setContextLoader(tryGetContext);
    app.setSettingsLoader(() => getSettings(tryGetContext() ?? app.ctx));
    runtime.app = app;

    // ── 唯一的设置入口是悬浮窗（点头像 / 双击气泡 / /bg-config）──
    //
    // 这里曾经还挂一份面板到酒馆的「扩展设置」区。用户要求砍掉：
    // 「你把拓展里面的设置界面砍了吧，能通过悬浮窗打开设置就不需要那个了」。
    // 理由成立 —— 同一份设置有两个入口，除了让人疑惑「改哪个才生效」之外
    // 没有任何好处，而且侧栏那份要单独维护一套排版。
    //
    // 所以设置只走 `createSettingsWindow`（见下面的悬浮窗挂载）。

    // 1) 悬浮窗（同时是设置入口）
    try {
        if (settings.ui.showAvatar !== false) {
            // 默认立绘用随包的内置图（assets/beatrice.png，已抠掉白底）。
            // 路径必须是「相对插件目录」的 —— 插件目录名取决于用户安装时的文件夹名
            //（`beatrice-guide-main` 之类），源码里写不死，所以启动时解析一次。
            //
            // 用户想换成自己的立绘，就在设置里填自定义路径，它会覆盖这个默认值。
            const defaultAvatar = `assets/beatrice.png`;
            const wanted = String(settings.ui.customImage ?? '').trim() || defaultAvatar;
            settings.ui.customImageSrc = resolveAssetUrl(wanted, EXT_FOLDER);

            const ui = createFloatingBeatrice({
                settings,
                extensionFolder: EXT_FOLDER,
                onAvatarClick: () => handleAvatarClick(),
                onReobserve: async () => {
                    if (app.inflight) {
                        toast('碧翠丝正在观测，请等本次完成后再重新观测。', 'info');
                        return;
                    }
                    const outcome = await app.askNow({ force: true });
                    await app._install(outcome, '重新观测');
                },
                onAvatarMove: (pos) => {
                    app.settings.ui.avatarPos = pos;
                    app.refreshContext();
                    saveSettings(app.ctx, { silent: true });
                },
                onBubbleClose: () => {},
            });
            runtime.ui = ui;
            app.ui = ui;

            /**
             * 点头像的行为。
             *
             * ── 这里改过一次，原因是用户实测反馈
             *
             * 第一版：通道没配好时点她 → 只弹一句「需要配置 API」，用户没任何办法
             * 就地解决。改成「把酒馆的扩展设置侧栏滚出来」之后，用户的反应是
             * 「你添加的设置就在右边是什么意思？不可以写一个插件单独的 api 设置界面让我进去填写吗？」
             * —— 完全合理。点一个小精灵，结果右边的侧栏自己动了，这不是任何人期待的行为。
             *
             * 现在：**点她 = 打开插件自己的设置窗**。这是唯一的行为，不分状态。
             * 简单、可预期，而且用户永远能在那里把问题解决掉。
             * 想让她说话用斜杠命令 `/bg-now`，或者配好之后她本来就会自己出声。
             */
            function handleAvatarClick() {
                openPluginSettings();
            }

            /**
             * 打开插件自己的设置窗。
             *
             * @param {string} [tab] 指定落在哪个标签页；不传时按通道状态自动选
             *   （没配好 → 'llm'，配好了 → 保持上次的页面）
             * @returns {boolean} 是否成功打开
             */
            function openPluginSettings(tab) {
                try {
                    if (!runtime.settingsWindow) {
                        const win = createSettingsWindow({
                            app,
                            onClose: () => {},
                        });
                        runtime.settingsWindow = win;
                        if (typeof document !== 'undefined' && document.body) document.body.appendChild(win.node);
                    }
                    // 没配好通道时直接落在「辅助 API」那一页 —— 那是用户要解决的问题所在
                    const status = app.channelStatus();
                    const target = tab || (status.ready ? undefined : 'llm');
                    runtime.settingsWindow.open(target);
                    app.log(
                        status.ready
                            ? `已打开设置窗${target ? `（${target}）` : ''}`
                            : `已打开设置窗（${status.reason}）`,
                    );
                    return true;
                } catch (e) {
                    const detail = describeError(e);
                    console.error(`${TAG} 打开设置窗失败`, e);
                    // 让失败可见：这是用户点悬浮窗的唯一入口，
                    // 静默失败等于「点了没反应」，最难排查。
                    app.log(`打开设置窗失败：${detail}`);
                    runtime.lastSettingsWindowError = detail;
                    try {
                        toast(`${EXT_NAME}：打开设置窗失败 — ${detail}`, 'error', 10000);
                    } catch {
                        /* ignore */
                    }
                    // 打开设置窗是唯一入口，它挂了就没有别的界面可用了 ——
                    // 所以这里必须把原因说清楚，而不是只弹一句「失败」。
                    toast(
                        `${EXT_NAME}：打开设置窗失败 — ${detail}\n请打开控制台（F12）查看详情，或到 GitHub 提 Issue。`,
                        'error',
                        15000,
                    );
                    return false;
                }
            }

            // 暴露给控制器与斜杠命令用
            app.openSettingsWindow = openPluginSettings;

            if (typeof document !== 'undefined' && document.body) document.body.appendChild(ui.node);
        }
    } catch (e) {
        console.error(`${TAG} 挂载悬浮窗失败`, e);
    }

    // 2) 事件挂接
    app.realmWorldbookGuard = installRealmWorldbookGuard(tryGetContext, live => live.extensionSettings?.beatriceGuide ?? app.settings);
    if (!app.realmWorldbookGuard.supported) {
        app.log('当前宿主不支持生成前关闭人神对抗规则世界书；请手动取消挂载，不能保证碧翠丝正文隔离。');
        toast('无法自动隔离人神规则世界书，请在碧翠丝模式手动取消挂载该书。', 'warning');
    }
    globalThis.window?.addEventListener?.('pagehide', () => app.realmWorldbookGuard?.dispose?.(), { once: true });
    hookEvents(app, ctx);
    runtime.stopDisplayObserver = observeDisplayedGuidance(() => tryGetContext() ?? app.ctx);
    globalThis.window?.addEventListener?.('pagehide', () => runtime.stopDisplayObserver?.(), { once: true });

    // 3) 斜杠命令
    registerSlashCommands(app);

    // 4) 记住启动成功，方便排查
    app.log(`已就绪。扩展目录 ${EXT_FOLDER}。点悬浮窗里的贝翠丝可以手动让她说话。`);
    console.log(`${TAG} 已就绪 v${app.version}。点右下角的贝翠丝可以手动让她说话。`);
    exposeDebugApi(app);
}

/**
 * 挂接酒馆事件。
 *
 * 事件名全部取自本机实测的 `tavern_events` 表。注意几个反直觉的值（写错就静默失效）：
 *   CHAT_CHANGED            → `'chat_id_changed'`
 *   GENERATION_AFTER_COMMANDS → `'GENERATION_AFTER_COMMANDS'`（唯一全大写的字符串）
 *   CHARACTER_DELETED       → `'characterDeleted'`（驼峰）
 *
 * @param {GuideController} app
 * @param {any} ctx
 */
function hookEvents(app, ctx) {
    const events = ctx.eventTypes ?? /** @type {any} */ (globalThis).event_types ?? {};
    const source = ctx.eventSource;

    if (!source?.on) {
        console.warn(`${TAG} 没有可用的 eventSource，自动引导功能将不可用（手动点悬浮窗仍可工作）`);
        return;
    }

    /** 安全注册：事件常量缺失时跳过而不是崩溃。 */
    const listen = (/** @type {string} */ key, /** @type {Function} */ handler) => {
        const eventName = events[key];
        if (!eventName) {
            console.warn(`${TAG} 事件 ${key} 在当前酒馆里不存在，跳过监听`);
            return;
        }
        try {
            source.on(eventName, (...args) => {
                const oldChat = app.ctx?.chat;
                const oldMetadata = app.ctx?.chatMetadata;
                app.refreshContext();
                if (key !== 'CHAT_CHANGED' && (oldChat !== app.ctx?.chat || oldMetadata !== app.ctx?.chatMetadata)) app.onChatChanged();
                return handler(...args);
            });
        } catch (e) {
            console.error(`${TAG} 监听 ${key} 失败`, e);
        }
    };

    // ── 核心时序：正文开始生成 → 并发发起辅助请求 ──────────────────────
    // 这是整个插件最要紧的一行。放这里而不是 GENERATION_ENDED，
    // 才能让辅助模型与正文模型**同时**工作，正文结束时结果已经到手。
    const proseStart = (type, options, dryRun) => {
        if (dryRun === true || type === 'quiet' || type === 'impersonate') {
            app.debug('跳过非正文生成生命周期事件');
            return;
        }
        app.onGenerationStart();
    };
    listen('GENERATION_AFTER_COMMANDS', proseStart);

    // 兜底：有些酒馆/某些触发路径不发 GENERATION_AFTER_COMMANDS
    listen('GENERATION_STARTED', proseStart);

    // ── 正文结束 → 兑现结果并注入 ──────────────────────────────────────
    listen('GENERATION_ENDED', () => app.onGenerationEnd());

    // 用户点了「停止生成」→ 取消在途请求（省额度，也避免半截结果突然冒出来）
    listen('GENERATION_STOPPED', () => app.onGenerationStopped());

    // ── 防回环：识别并跳过自家注入的消息 ───────────────────────────────
    listen('MESSAGE_RECEIVED', (/** @type {number} */ messageId) => {
        app.onMessageReceived(messageId);
    });

    // ── 补做「还没渲染成功」的正文追加 ─────────────────────────────────
    //
    // `GENERATION_ENDED` 触发时楼层**可能还没渲染进 DOM**，那时
    // `updateMessageBlock` 是空操作（而且不报错）。display_text 已经写在
    // 消息数据上了，所以楼层一渲染出来就立刻补一次，她的话就会出现。
    // 没有这条，用户看到的就是「正文末尾没有接入碧翠丝说话」。
    listen('CHARACTER_MESSAGE_RENDERED', (/** @type {number} */ messageId) => {
        const id = Number(messageId);
        const n = flushPendingAppends(app.ctx, id);
        if (n > 0) app.log(`已补上第 #${id} 条正文末尾的引导`);
        // 楼层刚铺出来 —— 如果数据里有她的话而页面上没有，就在这里补上。
        // 这一步同时兜住「刷新页面 / 切走再切回来」：那时内存登记早就没了，
        // 唯一还记得这件事的是消息数据里的记号。
        repairDisplayedGuidance(app.ctx, id);
    });
    listen('MESSAGE_UPDATED', (/** @type {number} */ messageId) => {
        // 消息被编辑 / 主题重渲染 → 把待补的补上；已经落地的也重新应用一次
        //（有些主题重渲染时会用 mes 覆盖掉显示，导致她的话消失）
        app.syncAdversaryDirector();
        const id = Number(messageId);
        flushPendingAppends(app.ctx, Number.isFinite(id) ? id : undefined);
        if (Number.isFinite(id)) repairDisplayedGuidance(app.ctx, id);
    });

    for (const key of ['MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
        if (events[key]) listen(key, () => app.syncAdversaryDirector());
    }

    // 切换聊天 → 记忆、缓存、悬浮窗全部重置
    listen('CHAT_CHANGED', () => {
        // 待补登记属于旧聊天 —— 那些下标拿到新聊天里用会张冠李戴，直接丢掉
        clearPendingAppends();
        app.onChatChanged();
        runtime.ui?.setVisible?.(app.settings.ui.showAvatar !== false);
        console.log(`${TAG} 已切换聊天，引导记忆已重置`);
        // 切回来时楼层是重新铺的，而 `mes` 里本来就不含她的话 —— 等酒馆
        // 渲染完再补一次（这一步靠数据里的记号，不需要内存登记）。
        scheduleRepair(app.ctx);
    });

    // 世界书被编辑 → 钩子缓存失效
    listen('WORLDINFO_UPDATED', () => app.onWorldbookChanged());
    listen('WORLDINFO_ENTRIES_LOADED', () => app.onWorldbookChanged());

    // 设置保存 → 同步悬浮窗显隐（用户可能在别处改了设置）
    listen('SETTINGS_UPDATED', () => {
        app.refreshSettings();
        runtime.ui?.setVisible?.(app.settings.ui.showAvatar !== false);
    });

    // 应用就绪 → 让已打开的设置窗重读一次环境
    //
    // 侧栏面板砍掉之后这里没有界面要重画了。保留这个监听是为了一个实际场景：
    // 用户可能先打开设置窗发现「没找到连接配置」，然后去酒馆里新建一个 ——
    // 这时把设置窗关掉，下次打开就会重新探测，新配置就出现在下拉框里了。
    listen('APP_READY', () => {
        const win = runtime.settingsWindow;
        if (win?.isOpen) {
            win.close?.();
            runtime.settingsWindow = null;
        }
        // ⚠️ 这一行必须在这里：接管酒馆的 `updateMessageBlock`。
        //
        // 实测（TauriTavern）：它的渲染路径**不认** `extra.display_text`。
        // 我们自己补一次 DOM，那次补只活到下一次重渲染为止 —— 流式收尾、
        // 滚动重排、切走切回、改字号……任何一次都会把她的话抹掉。
        // 包住这个函数之后，**任何**一次宿主发起的渲染都会带上她的话。
        runtime.patchedRender = patchUpdateMessageBlock(app.ctx);
        if (!runtime.patchedRender) {
            console.warn(`${TAG} 没能接管 updateMessageBlock —— 只能靠监视与渲染事件补显示`);
        }
        // 页面刚加载完：数据里可能留着上次会话写下的引导，而页面是按 `mes`
        // 铺出来的 —— 不补一次，用户会以为「引导没了」。
        scheduleRepair(app.ctx);
    });
}

/**
 * 补渲染的尝试时刻（毫秒）。
 *
 * 三个点而不是一个：酒馆铺楼层有快有慢，慢的时候（大聊天、虚拟滚动、
 * 主题带进场动画）一次就够不着。多试两次成本几乎为零 —— 幂等，且
 * 只有真的缺了才会去改 DOM。
 */
const REPAIR_DELAYS_MS = [120, 600, 1800];

/**
 * 过一小会儿把页面上缺的引导补上。
 *
 * 为什么要延时：`APP_READY` / `CHAT_CHANGED` 触发时楼层**可能还在铺**，
 * 此刻查 DOM 一定是「没有」。等一拍再扫，命中率高得多。
 * 扫全部（不传下标）是因为这两个事件都不给具体楼层号。
 *
 * 重复调用是安全的：`repairDisplayedGuidance` 幂等，显示对了就什么都不做。
 *
 * @param {any} ctx
 */
function scheduleRepair(ctx) {
    for (const delay of REPAIR_DELAYS_MS) {
        setTimeout(() => {
            try {
                const live = tryGetContext() ?? runtime.app?.ctx ?? ctx;
                if (live.chat !== ctx.chat || live.chatMetadata !== ctx.chatMetadata) return;
                const n = repairDisplayedGuidance(live);
                if (n > 0) console.log(`${TAG} 已补回 ${n} 条被重渲染覆盖掉的引导`);
            } catch (e) {
                console.warn(`${TAG} 补渲染失败：${describeError(e)}`);
            }
        }, delay);
    }
}

// ---------------------------------------------------------------------------
// 斜杠命令
// ---------------------------------------------------------------------------

/**
 * 注册斜杠命令。
 * 只用 ST 官方那套 `SlashCommandParser.addCommandObject(SlashCommand.fromProps(...))`，
 * 拿不到就静默跳过（插件主体功能不依赖命令行）。
 *
 * @param {GuideController} app
 */
function registerSlashCommands(app) {
    const ctx = app.ctx;
    const parser = /** @type {any} */ (globalThis).SlashCommandParser ?? ctx?.SlashCommandParser;
    const SlashCommand = /** @type {any} */ (globalThis).SlashCommand ?? ctx?.SlashCommand;

    if (!parser?.addCommandObject || !SlashCommand?.fromProps) {
        console.warn(`${TAG} 当前酒馆不支持斜杠命令注册，跳过（不影响主要功能）`);
        return;
    }

    /** 统一包一层：命令回调里出错不要炸掉酒馆。 */
    const safe =
        (/** @type {string} */ name, /** @type {Function} */ fn) =>
        async (/** @type {any[]} */ ...args) => {
            try {
                app.refreshContext();
                return await fn(...args);
            } catch (e) {
                console.error(`${TAG} 命令 /${name} 执行出错`, e);
                return `${EXT_NAME}：执行出错 — ${describeError(e)}`;
            }
        };

    /** 注册一个命令。 */
    const add = (/** @type {any} */ props) => {
        try {
            parser.addCommandObject(SlashCommand.fromProps({ ...props, callback: safe(props.name, props.callback) }));
        } catch (e) {
            console.error(`${TAG} 注册命令 /${props.name} 失败`, e);
        }
    };

    add({
        name: 'bg-config',
        aliases: ['贝翠丝设置', '引导设置'],
        helpString: '打开碧翠丝自己的设置窗口。用法：/bg-config',
        callback: async () => {
            app.openSettingsWindow?.();
            return `${EXT_NAME}：设置窗口已打开。`;
        },
    });

    add({
        name: 'bg-now',
        aliases: ['贝翠丝', 'beatrix', '引导'],
        helpString: '立刻让贝翠丝说一句（不看节奏设置，直接调一次辅助 API）。用法：/bg-now',
        callback: async () => {
            const status = app.channelStatus();
            if (!status.ready) {
                // 没配好就顺手把设置窗打开 —— 只回一句错误，用户还是不知道去哪改
                app.openSettingsWindow?.();
                return `${EXT_NAME}：还不能说话 — ${status.reason}\n（设置窗口已打开，配好再试）`;
            }
            const outcome = await app.askNow({ force: true });
            if (!outcome?.ok) return `${EXT_NAME}：没能说话 — ${outcome?.error ?? '未知原因'}`;
            await app._install(outcome, '斜杠命令');
            return `${EXT_NAME}：「${outcome.result.guidance || outcome.result.commentary}」`;
        },
    });

    add({
        name: 'bg-test',
        aliases: ['贝翠丝自检', '禁书库自检'],
        helpString: '跑一次完整链路自检：通道 → 线索 → 出话 → 接正文，逐步摊开结果。用法：/bg-test',
        callback: async () => {
            const lines = [`${EXT_NAME} 自检`];
            const step = (/** @type {string} */ label, /** @type {string} */ value) => lines.push(`${label}：${value}`);

            // ① 通道
            const status = app.channelStatus();
            step('① 通道', status.ready ? `就绪（${app.settings.llm.mode}）` : `未就绪 — ${status.reason}`);

            // ② 线索
            try {
                const collected = await app.previewHooks();
                step('② 线索', `扫描 ${collected.books.length} 本书 / ${collected.scanned} 条条目 → 命中 ${collected.hooks.length} 条`);
                step('　来源书', collected.books.join('、') || '（没有关联任何世界书）');
                if (collected.hooks.length) {
                    step('　前几条', collected.hooks.slice(0, 5).map((/** @type {any} */ h) => h.label).join('、'));
                } else {
                    step('　⚠️', '一条都没命中 —— 条目标题里要写 [引导] / [地点] 这类标签');
                }
                for (const err of collected.errors) step('　读取错误', err);
            } catch (e) {
                step('② 线索', `读取失败 — ${describeError(e)}`);
            }

            // ③ 线索池现状（这一轮能不能出声，全看它）
            const pool = app.currentHookPool();
            step('③ 线索池', pool.hooks.length ? `${pool.hooks.length} 条可用` : '❌ 空的（这一轮不会出声）');
            if (pool.hooks.length) {
                step('　前几条', pool.hooks.slice(0, 5).map((/** @type {any} */ h) => h.label).join('、'));
            } else {
                step('　怎么办', '到设置 → 📖 世界书线索 → 点「🔎 让 AI 通读世界书」，或用「📋 列出条目让我自己挑」');
            }

            // ④ 出话
            if (!status.ready) {
                lines.push('④ 出话：跳过（通道没配好）', '⑤ 接正文：跳过');
                return lines.join('\n');
            }
            const outcome = await app.askNow({});
            if (!outcome?.ok) {
                step('④ 出话', `失败 — ${outcome?.error ?? '未知原因'}`);
                for (const n of outcome?.notes ?? []) step('　提示', n);
                lines.push('⑤ 接正文：跳过（没有内容可接）');
                return lines.join('\n');
            }
            step('③ 出话', `成功（${outcome.result.emotion}）`);
            step('　引导', outcome.result.guidance || '（空）');
            step('　吐槽', outcome.result.commentary || '（空）');
            step('　用到线索', (outcome.result.hooks_used ?? []).join('、') || '（无）');
            step('　通道/线索池', `${outcome.meta?.mode ?? '?'} / ${outcome.hooks?.length ?? 0} 条`);

            // ④ 接正文 —— 不走事件，直接对当前最新一条 AI 消息试一次，看能不能落地
            app.refreshContext();
            if (!app.lifecycleValid(outcome.lifecycle, outcome.targetSnapshot)) {
                step('⑤ 接正文', '结果已作废（聊天、模式或正文改变）');
                return lines.join('\n');
            }
            const chat = app.ctx.chat ?? [];
            const targetIdx = Number.isInteger(outcome.targetMessageId) ? outcome.targetMessageId : -1;
            step('⑤ 找目标', targetIdx >= 0 ? `第 #${targetIdx} 条（聊天共 ${chat.length} 条）` : '找不到 AI 正文消息');
            if (targetIdx >= 0) {
                const appended = appendGuidanceToMessage(app.ctx, targetIdx, outcome.result, app.settings);
                step(
                    '⑤ 接正文',
                    appended.ok
                        ? `成功（数据 ✅，渲染 ${appended.rendered ? '✅' : '⏳ 待补'}）`
                        : `失败 — ${appended.error}`,
                );
                step('　待补渲染', `${pendingAppendCount()} 条`);
                step('　updateMessageBlock', typeof ctx.updateMessageBlock === 'function' ? '有' : '❌ 没有');
                step('　messageFormatting', typeof ctx.messageFormatting === 'function' ? '有' : '❌ 没有（兜底会退成纯文本）');
            }
            step('呈现方式', String(app.settings.injection?.mode ?? '?'));
            return lines.join('\n');
        },
    });

    add({
        name: 'bg-hooks',
        aliases: ['贝翠丝线索', '引导线索'],
        helpString: '列出当前命中哪些世界书线索（不调 LLM）。用法：/bg-hooks',
        callback: async () => {
            const c = await app.previewHooks();
            const lines = [`${EXT_NAME}：扫描 ${c.books.length} 本书 / ${c.scanned} 条条目，命中 ${c.hooks.length} 条线索。`];
            if (c.books.length) lines.push(`来源：${c.books.join('、')}`);
            for (const h of c.hooks.slice(0, 20)) {
                lines.push(`· [${h.tags.join('/') || '常驻'}] ${h.label}`);
            }
            if (c.hooks.length > 20) lines.push(`（还有 ${c.hooks.length - 20} 条未显示）`);
            if (!c.hooks.length) lines.push('一条都没命中 —— 检查条目标题里有没有写 [引导] / [地点] 这类标签。');
            return lines.join('\n');
        },
    });

    add({
        name: 'bg-status',
        aliases: ['贝翠丝状态'],
        helpString: '查看贝翠丝当前的状态与统计。用法：/bg-status',
        callback: async () => {
            const st = app.state();
            return [
                `${EXT_NAME} v${st.version}　${st.enabled ? '已启用' : '已停用'}`,
                `代码修订：${CODE_REVISION}`,
                `通道：${st.llmMode}　节奏：${st.cadence}　呈现：${st.injectionMode}`,
                // 线索池是**持久化**的（存在本聊天的 chatMetadata 里）。
                // 单独列出来，是因为「上次生成用了什么」在刚重启时必然是空的，
                // 会让人误以为池子没保存（用户问过这个）。
                `线索池：${st.hookPool.count} 条（${st.hookPool.fresh ? '可用' : st.hookPool.note}）` +
                    (st.hookPool.indexed ? '（索引模式）' : '') +
                    (st.hookPool.books.length ? `　来自：${st.hookPool.books.join('、')}` : ''),
                // 两段式的第一段结论：她认为演到哪、挑了哪几条。
                // 用户提的需求就是「判断目前是第几章，再找对应剧情」，
                // 所以这个判断必须能直接看到，否则挑偏了没法排查。
                st.located
                    ? `定位：演到「${st.located.phase}」　挑了 ${st.located.picks.length}/${st.located.total} 条` +
                      (st.located.labels.length ? `：${st.located.labels.join('、')}` : '')
                    : '定位：还没跑过',
                `轮次：第 ${st.turnIndex} 轮（计数 ${st.turnCounter}）　已引导 ${st.guidedTurns} 轮　注入 ${st.injectedCount} 条`,
                `待补渲染：${st.pendingAppends} 条`,
                // 她的话「到底在不在页面上」。
                //
                // 用户实测踩过：诊断说「已接在第 #4 条正文末尾」，页面上却
                // 一个字都没有。所以这里把「数据里有」与「页面上有」分开报，
                // 并说清这台酒馆认不认 display_text —— 一眼就能分清是
                //「酒馆的渲染不吃这一套」还是「我们压根没写进去」。
                (() => {
                    const d = st.display ?? {};
                    const parts = [`呈现：数据里 ${d.inData ?? 0} 条 / 页面上 ${d.onScreen ?? 0} 条`];
                    if (d.missing?.length) parts.push(`缺第 ${d.missing.join('、')} 条`);
                    parts.push(
                        d.hostHonorsDisplay === false
                            ? '本机酒馆不认 display_text（靠补显示兜着）'
                            : d.hostHonorsDisplay === true
                              ? '本机酒馆认 display_text'
                              : '还没试过',
                    );
                    if (d.patched === false) parts.push('⚠️ 没能接管重渲染');
                    if (d.watchRepairs) parts.push(`已补回 ${d.watchRepairs} 次`);
                    return parts.join('　');
                })(),
                st.lastError ? `上次错误：${st.lastError}` : '上次运行：正常',
                st.lastResult ? `上次说话：「${st.lastResult.guidance || st.lastResult.commentary}」` : '还没说过话',
            ].join('\n');
        },
    });

    add({
        name: 'bg-clear',
        aliases: ['贝翠丝重置'],
        helpString: '清空本聊天的引导记忆（去重历史）。用法：/bg-clear',
        callback: async () => {
            await app.clearMemory();
            return `${EXT_NAME}：本聊天的引导记忆已清空。`;
        },
    });

    add({
        name: 'bg-toggle',
        aliases: ['贝翠丝开关'],
        helpString: '临时开关贝翠丝（不改设置文件之外的持久化）。用法：/bg-toggle',
        callback: async () => {
            app.settings.enabled = !app.settings.enabled;
            await app.persistSettings();
            app.log(app.settings.enabled ? '已启用（斜杠命令）' : '已停用（斜杠命令）');
            return `${EXT_NAME}：已${app.settings.enabled ? '启用' : '停用'}。`;
        },
    });

    console.log(`${TAG} 已注册斜杠命令：/bg-config /bg-now /bg-hooks /bg-status /bg-clear /bg-toggle`);
}

// ---------------------------------------------------------------------------
// 调试入口
// ---------------------------------------------------------------------------

/** 暴露调试用的全局对象，方便在控制台里排查。 */
function exposeDebugApi(/** @type {GuideController} */ app) {
    /** @type {any} */ (globalThis).BeatriceGuide = {
        version: app.version,
        app,
        get ui() {
            return runtime.ui;
        },
        /** 打印状态。 */
        state: () => app.state(),
        /** 手动让她说一句。 */
        speak: () => app.askNow({ force: true }).then((o) => app._install(o, '调试')),
        /** 预览命中的线索。 */
        hooks: () => app.previewHooks(),
        /** 当前生效的设置。 */
        settings: () => app.settings,
        /** 立即落盘设置。 */
        save: () => app.persistSettings(),
        /** 悬浮窗组件本身。 */
        floating: () => runtime.ui,
        /** 打开插件自己的设置窗。返回是否成功。 */
        config: (/** @type {string} */ tab) => app.openSettingsWindow?.(tab),
        /**
         * 上一次打开设置窗失败的原因。
         *
         * 有值就说明「点头像 → 开设置」这条路坏了 —— 冒烟测试没法覆盖
         * 真实 DOM 里的渲染异常，所以留一个可在控制台/测试里查的出口。
         */
        get settingsWindowError() {
            return runtime.lastSettingsWindowError ?? '';
        },
        /** 设置窗组件本身。 */
        settingsWindow: () => runtime.settingsWindow,
    };
    console.log(`${TAG} 调试入口：window.BeatriceGuide（试试 BeatriceGuide.state()）`);
}

// ---------------------------------------------------------------------------
// 入口：等 DOM 就绪后启动
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            boot().catch(reportBootFailure);
        });
    } else {
        boot().catch(reportBootFailure);
    }
}

/** 启动失败时给出可操作的提示，而不是静默死掉。 */
function reportBootFailure(/** @type {any} */ error) {
    console.error(`${TAG} 启动失败`, error);
    try {
        toast(
            `${EXT_NAME} 启动失败：${String(error?.message ?? error)}。请打开控制台（F12）查看详情，或到 GitHub 提 Issue。`,
            'error',
            12000,
        );
    } catch {
        /* 什么都做不了 */
    }
}

export { boot, runtime, EXT_FOLDER, EXT_ID };
