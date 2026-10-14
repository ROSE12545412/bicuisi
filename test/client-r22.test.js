import { strict as assert } from 'node:assert';
import { test, describe } from './_harness.js';
import { LlmClient, ABORT_MESSAGE, withTimeout } from '../src/llm/client.js';

const custom = { mode: 'custom', temperature: 0, timeoutMs: 3000, custom: { url: 'https://example.invalid/v1', model: 'test' } };
const schema = { name: 'test', value: { type: 'object' } };
const success = () => ({ ok: true, json: async () => ({ content: 'done' }) });
const failure = (status, detail) => ({ ok: false, status, text: async () => detail });
const profile = (sendRequest) => new LlmClient({ ConnectionManagerRequestService: { sendRequest } }, { mode: 'profile', profileId: 'test', timeoutMs: 3000, temperature: 0 });

async function fakeTimers(run) {
    const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const timers = new Map();
    let id = 0;
    globalThis.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
    globalThis.clearTimeout = (key) => timers.delete(key);
    try { await run(timers); }
    finally { Object.assign(globalThis, original); }
}
async function mockFetch(fetch, run) {
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try { await run(); } finally { globalThis.fetch = original; }
}

describe('r22 request-local cancellation and compatibility', () => {
    test('configured temperature zero reaches fetch and meta; explicit request wins', async () => {
        const bodies = [];
        await mockFetch(async (_, opts) => { bodies.push(JSON.parse(opts.body)); return success(); }, async () => {
            const client = new LlmClient({}, custom);
            const result = await client.complete({ user: 'test' });
            assert.equal(result.meta.temperature, 0);
            assert.equal(result.meta.attempts, 1);
            assert.equal(bodies[0].temperature, 0);
            await client.complete({ user: 'test', temperature: 0.2 });
            assert.equal(bodies[1].temperature, 0.2);
        });
    });

    test('timeout aborts local fetch signal, not caller, and remains informative', async () => {
        await fakeTimers(async (timers) => {
            const caller = new AbortController();
            let transportSignal;
            await mockFetch((_, opts) => {
                transportSignal = opts.signal;
                return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
            }, async () => {
                const pending = new LlmClient({}, custom, 'test').complete({ user: 'test', signal: caller.signal });
                assert.notEqual(transportSignal, caller.signal);
                const timer = [...timers.values()][0];
                assert.equal(timer.ms, 3000);
                timer.fn();
                const result = await pending;
                assert.equal(transportSignal.aborted, true);
                assert.equal(caller.signal.aborted, false);
                assert.equal(result.ok, false);
                assert.match(result.error, /超时.*3 秒/);
                assert.notEqual(result.error, ABORT_MESSAGE);
                assert.notEqual(result.aborted, true);
                assert.equal(timers.size, 0);
            });
        });
    });

    test('external abort forwards reason, stops waiting for ignoring profile, and never falls back', async () => {
        await fakeTimers(async (timers) => {
            const caller = new AbortController();
            let local;
            let calls = 0;
            const client = profile((...args) => { calls++; local = args[3].signal; return new Promise(() => {}); });
            const pending = client.complete({ user: 'test', signal: caller.signal });
            caller.abort('stop');
            const result = await pending;
            assert.equal(local.aborted, true);
            assert.equal(local.reason, 'stop');
            assert.equal(result.aborted, true);
            assert.equal(result.error, ABORT_MESSAGE);
            assert.equal(calls, 1);
            assert.equal(timers.size, 0);
        });
    });

    test('pre-aborted request never starts transport; success clears timer and forwarding listener', async () => {
        await fakeTimers(async (timers) => {
            const caller = new AbortController();
            caller.abort();
            let calls = 0;
            let local;
            const client = profile(async (...args) => { calls++; local = args[3].signal; return 'done'; });
            const aborted = await client.complete({ user: 'test', signal: caller.signal });
            assert.equal(aborted.aborted, true);
            assert.equal(aborted.meta.attempts, 0);
            assert.equal(calls, 0);
            const nextCaller = new AbortController();
            assert.equal((await client.complete({ user: 'test', signal: nextCaller.signal })).ok, true);
            assert.equal(timers.size, 0);
            nextCaller.abort();
            assert.equal(local.aborted, false, 'forwarding listener must be detached after completion');
        });
    });

    test('withTimeout keeps its original promise-only API and cleans timer', async () => {
        await fakeTimers(async (timers) => {
            assert.equal(await withTimeout(Promise.resolve('done'), 3000), 'done');
            assert.equal(timers.size, 0);
            const pending = withTimeout(new Promise(() => {}), 3000, 'test ');
            [...timers.values()][0].fn();
            await assert.rejects(pending, /test 超时（3 秒）/);
        });
    });

    test('profile retries only an explicit unsupported fourth-parameter TypeError and counts calls', async () => {
        const arities = [];
        const client = profile(async (...args) => {
            arities.push(args.length);
            if (args.length === 4) throw new TypeError('Fourth parameter is not supported');
            throw new Error('HTTP 500 unavailable');
        });
        const result = await client.complete({ user: 'test' });
        assert.deepEqual(arities, [4, 3]);
        assert.equal(result.meta.attempts, 2);
        assert.match(result.meta.notice, /三参/);
        assert.match(result.error, /HTTP 500/);
    });

    test('profile compatibility success reports two actual transport attempts', async () => {
        const arities = [];
        const result = await profile(async (...args) => {
            arities.push(args.length);
            if (args.length === 4) throw new TypeError('Unsupported fourth argument');
            return 'done';
        }).complete({ user: 'test' });
        assert.equal(result.ok, true);
        assert.deepEqual(arities, [4, 3]);
        assert.equal(result.meta.attempts, 2);
        assert.match(result.meta.notice, /三参/);
    });

    test('profile authentication/server/network/generic TypeErrors do not trigger fallback', async () => {
        for (const error of [new Error('HTTP 401 invalid API key'), new Error('HTTP 500 unavailable'), new TypeError('Failed to fetch'), new TypeError('unsupported'), new TypeError('Cannot read properties of undefined'), new Error('Fourth parameter is not supported')]) {
            let calls = 0;
            const result = await profile(async () => { calls++; throw error; }).complete({ user: 'test' });
            assert.equal(calls, 1, error.message);
            assert.equal(result.meta.attempts, 1);
            assert.equal(result.meta.notice, undefined);
            assert.equal(result.error, error.message);
        }
    });

    test('schema fallback uses realistic 400/422 explicit key errors and records actual attempts', async () => {
        for (const status of [400, 422]) {
            const bodies = [];
            await mockFetch(async (_, opts) => {
                bodies.push(JSON.parse(opts.body));
                return bodies.length === 1 ? failure(status, '{"error":{"message":"Unsupported parameter: response_format"}}') : success();
            }, async () => {
                const result = await new LlmClient({}, custom).complete({ user: 'test', jsonSchema: schema });
                assert.equal(result.ok, true);
                assert.equal(result.meta.attempts, 2);
                assert.match(result.meta.notice, /json_schema/);
                assert.ok(bodies[0].response_format);
                assert.equal(bodies[1].response_format, undefined);
            });
        }
    });

    test('generic unsupported/invalid_argument, 401/500 and absent schema never retry', async () => {
        for (const [status, detail, jsonSchema] of [[400, 'unsupported model', schema], [422, 'invalid_argument', schema], [400, 'unknown field model', schema], [401, 'unsupported response_format', schema], [500, 'invalid json_schema', schema], [400, 'unsupported response_format', undefined]]) {
            let calls = 0;
            await mockFetch(async () => { calls++; return failure(status, detail); }, async () => {
                const result = await new LlmClient({}, custom).complete({ user: 'test', jsonSchema });
                assert.equal(result.ok, false);
                assert.equal(calls, 1, `${status}: ${detail}`);
                assert.equal(result.meta.attempts, 1);
                assert.equal(result.meta.notice, undefined);
                assert.match(result.error, new RegExp(`HTTP ${status}`));
            });
        }
    });

    test('external abort during schema error body prevents fallback', async () => {
        const caller = new AbortController();
        let calls = 0;
        await mockFetch(async () => {
            calls++;
            return { ok: false, status: 400, text: async () => { caller.abort(); return 'unsupported response_format'; } };
        }, async () => {
            const result = await new LlmClient({}, custom).complete({ user: 'test', jsonSchema: schema, signal: caller.signal });
            assert.equal(result.aborted, true);
            assert.equal(calls, 1);
            assert.equal(result.meta.notice, undefined);
        });
    });
});
