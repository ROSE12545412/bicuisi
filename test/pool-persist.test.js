import { strict as assert } from "node:assert";
import { test, describe } from "./_harness.js";
import { getChatData, saveChatData, setHookPool, isHookPoolFresh, blankChatData } from "../src/core/store.js";
import { defaultSettings } from "../src/config.js";
import { CHAT_KEY } from "../src/config.js";

/**
 * 模拟一个「聊天文件」。
 *
 * `disk` 是 `{ value: string }`（初始空串）。`saveMetadata` 把内存里的
 * `chatMetadata` 序列化进 `disk.value`；把同一个 `disk` 再传一次进来，
 * 就相当于「重新打开这个聊天」（从磁盘反序列化）。
 * 传 `undefined` 相当于「另一条全新的聊天线」。
 */
function makeCtx(disk) {
  return {
    chatMetadata: disk?.value ? JSON.parse(disk.value) : {},
    saveSettingsDebounced: async () => {},
    async saveMetadata() {
      disk.value = JSON.stringify(this.chatMetadata);
    },
  };
}

describe("线索池的持久化（用户问过「是不是不会自己保存」）", () => {
  const BOOKS = ["我的世界书"];
  const HOOKS = [
    { book: "我的世界书", uid: 4, label: "旧城区的传言", content: "夜里有人搬箱子。", kind: "线索", why: "x" },
    { book: "我的世界书", uid: 5, label: "卖花女人的眼神", content: "她看了你三次。", kind: "人物", why: "y" },
  ];

  test("⭐ 存进 chatMetadata 之后 saveMetadata 能把它写出去", async () => {
    const disk = { value: "" };
    const ctx = makeCtx(disk);
    const data = getChatData(ctx);
    setHookPool(data, HOOKS, BOOKS);

    const res = await saveChatData(ctx, data, { silent: true });
    assert.equal(res.ok, true, `保存失败：${res.error}`);

    // 「磁盘」上必须真的有
    const onDisk = JSON.parse(disk.value)[CHAT_KEY];
    assert.ok(onDisk?.hookPool, "磁盘上没有 hookPool —— 等于没保存");
    assert.equal(onDisk.hookPool.hooks.length, 2);
    assert.deepEqual(onDisk.hookPool.books, BOOKS);
  });

  test("⭐ 重新打开聊天（从磁盘恢复）→ 池子还在，且判定为新鲜", async () => {
    const disk = { value: "" };
    // 第一次：建立并保存
    {
      const ctx = makeCtx(disk);
      const data = getChatData(ctx);
      setHookPool(data, HOOKS, BOOKS);
      await saveChatData(ctx, data, { silent: true });
    }
    // 第二次：全新的 ctx，只有磁盘内容（模拟重启酒馆 / 重开聊天）
    {
      const ctx = makeCtx(disk);
      const data = getChatData(ctx);
      assert.ok(data.hookPool, "重启后池子丢了 —— 那就是「不会自己保存」");
      assert.equal(data.hookPool.hooks.length, 2);
      assert.deepEqual(data.hookPool.hooks.map((h) => h.label), ["旧城区的传言", "卖花女人的眼神"]);
      assert.equal(isHookPoolFresh(data, defaultSettings(), BOOKS), true, "恢复后应该判定为可用");
    }
  });

  test("换聊天 → 干净开局（池子不串场）", async () => {
    const disk = { value: "" };
    {
      const ctx = makeCtx(disk);
      const data = getChatData(ctx);
      setHookPool(data, HOOKS, BOOKS);
      await saveChatData(ctx, data, { silent: true });
    }
    const fresh = getChatData(makeCtx(undefined)); // 另一条聊天线
    assert.equal(fresh.hookPool, null, "池子不该串到别的聊天");
  });

  test("宿主只支持 saveChat（没有 saveMetadata）也能存上", async () => {
    let written = "";
    const ctx = {
      chatMetadata: {},
      saveSettingsDebounced: async () => {},
      async saveChat() {
        written = JSON.stringify(this.chatMetadata);
      },
    };
    const data = getChatData(ctx);
    setHookPool(data, HOOKS, BOOKS);
    const res = await saveChatData(ctx, data, { silent: true });
    assert.equal(res.ok, true);
    assert.ok(JSON.parse(written)[CHAT_KEY]?.hookPool, "走 saveChat 回落时没存上");
  });

  test("⚠️ 两个保存接口都没有 → 明确报错，而不是假装成功", async () => {
    const ctx = { chatMetadata: {}, saveSettingsDebounced: async () => {} };
    const data = getChatData(ctx);
    setHookPool(data, HOOKS, BOOKS);
    const res = await saveChatData(ctx, data, { silent: true });
    assert.equal(res.ok, false, "存不上就要说存不上");
    assert.match(res.error, /saveMetadata|saveChat/);
    // 但内存里仍然可用（本次会话不受影响）
    assert.ok(ctx.chatMetadata[CHAT_KEY].hookPool);
  });

  test("空池子不写进磁盘（不留下半截数据）", () => {
    const data = blankChatData();
    assert.equal(data.hookPool, null);
    setHookPool(data, [], BOOKS);
    assert.equal(data.hookPool.hooks.length, 0);
    // 读回来时「空 hooks」会被判为不可用 —— 免得拿一个空池子去引导
    assert.equal(isHookPoolFresh(data, defaultSettings(), BOOKS), false);
  });
});
