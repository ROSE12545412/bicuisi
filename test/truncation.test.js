import { strict as assert } from "node:assert";
import { test, describe } from "./_harness.js";
import { looksTruncated, parseGuideResult } from "../src/llm/guide.js";
import { defaultSettings } from "../src/config.js";

describe("输出被 token 上限截断的识别（用户实测：气泡里只有半句话）", () => {
    test("⭐ 用户实际看到的那个残句必须被判为截断", () => {
        // 用户原文：「这是碧翠丝的气泡发言被截断了」
        // 半截 JSON 解析不出来，原来的兜底会把残句当引导贴到界面上。
        assert.equal(looksTruncated("{\"guidance\":\"哼，光顾着发呆，旁边"), true);
    });

    test("括号没配平 → 截断", () => {
        assert.equal(looksTruncated("{\"guidance\":\"abc\""), true);
        assert.equal(looksTruncated("{\"guidance\":\"abc\"}"), false);
        assert.equal(looksTruncated("{\"picks\":[{\"a\":1}"), true);
    });

    test("字符串没闭合 → 截断", () => {
        assert.equal(looksTruncated("{\"guidance\":\"没写完"), true);
    });

    test("完整输出不误判", () => {
        const good = JSON.stringify({ guidance: "哼。", commentary: "笨蛋。", emotion: "smug" });
        assert.equal(looksTruncated(good), false);
        assert.equal(looksTruncated("```json\n" + good + "\n```"), false);
    });

    test("转义引号不会让计数错乱", () => {
        const s = JSON.stringify({ guidance: "他说\"走\"。", commentary: "哼。" });
        assert.equal(looksTruncated(s), false);
    });

    test("⭐ 截断时 parseGuideResult 要报可操作的错，而不是把残句当内容", () => {
        const settings = defaultSettings();
        const r = parseGuideResult("{\"guidance\":\"哼，光顾着发呆，旁边", settings);
        assert.equal(r.ok, false);
        assert.equal(r.truncated, true, "要标记成 truncated，上层才能区分");
        assert.match(r.error, /token/, "要告诉用户去调 token 上限");
        assert.match(r.error, /最多输出 token/, "错误信息要能直接照做");
        // 关键：绝不能把半句话当成内容返回
        assert.equal(r.result.guidance, "");
        assert.equal(r.result.commentary, "");
    });

    test("正常的完整输出照常解析", () => {
        const settings = defaultSettings();
        const r = parseGuideResult(
            JSON.stringify({ guidance: "哼，收摊收得有点早啊。", commentary: "笨蛋。", emotion: "smug" }),
            settings,
        );
        assert.equal(r.ok, true);
        assert.equal(r.result.guidance, "哼，收摊收得有点早啊。");
    });
});
