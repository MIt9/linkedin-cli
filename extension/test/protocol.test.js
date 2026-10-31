// protocol.js is a classic script (importScripts / <script>), and the repo root is "type":"module",
// so evaluate its source with a fake `module` (same realm, for deepStrictEqual) instead of require().
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const m = { exports: {} };
new Function('module', readFileSync(new URL('../protocol.js', import.meta.url), 'utf8'))(m);
const { DEFAULT_PORT, parsePort, wsUrl, compatible, helloMsg, onServerMessage, shouldReload, errorReply, haltError } = m.exports;
test('parsePort accepts valid ports', () => {
  for (const [v, n] of [[1024, 1024], [65535, 65535], ['47851', 47851], [' 8080 ', 8080]]) assert.strictEqual(parsePort(v), n);
});
test('parsePort rejects garbage', () => {
  for (const v of [1023, 65536, 0, -1, 1.5, '1e4', '80.5', 'abc', '', ' ', null, undefined, NaN, {}, '0x400', '000001024x', '123456'])
    assert.strictEqual(parsePort(v), null, String(v));
});
test('wsUrl builds /ext url and falls back to default', () => {
  assert.strictEqual(wsUrl(9000), 'ws://127.0.0.1:9000/ext');
  assert.strictEqual(wsUrl(undefined), `ws://127.0.0.1:${DEFAULT_PORT}/ext`);
  assert.strictEqual(wsUrl('junk'), 'ws://127.0.0.1:47851/ext');
});

test('compatible = same major.minor', () => {
  assert.ok(compatible('0.8.0', '0.8.5'));
  assert.ok(compatible('1.2.3', '1.2.3'));
  assert.ok(!compatible('0.8.0', '0.9.0'));
  assert.ok(!compatible('1.2.0', '2.2.0'));
  assert.ok(!compatible('0.8.0', undefined));
  assert.ok(!compatible('x', 'x'));
});

test('hello shape', () => {
  assert.deepStrictEqual(helloMsg('0.8.0', 'abc'), { type: 'hello', version: '0.8.0', extensionId: 'abc' });
});

test('ping -> pong, calls dispatch', () => {
  assert.deepStrictEqual(onServerMessage({ type: 'ping' }, '0.8.0'), { reply: { type: 'pong' } });
  assert.deepStrictEqual(onServerMessage({ id: 1, tool: 'post', args: {} }, '0.8.0'), { dispatch: true });
});

test('hello: compatible clears rejection, incompatible blocks with badge', () => {
  const ok = onServerMessage({ type: 'hello', version: '0.8.3' }, '0.8.0');
  assert.deepStrictEqual(ok, { set: { cli_serverVersion: '0.8.3' }, remove: ['cli_rejected'] });
  const bad = onServerMessage({ type: 'hello', version: '0.9.0' }, '0.8.0');
  assert.strictEqual(bad.badge, '!');
  assert.strictEqual(bad.block, true);
  assert.strictEqual(bad.set.cli_serverVersion, '0.9.0');
});

test('reject version_mismatch: persists, badge, blocks, never dispatches', () => {
  const fx = onServerMessage({ type: 'reject', reason: 'version_mismatch', serverVersion: '0.9.0' }, '0.8.0');
  assert.strictEqual(fx.badge, '!');
  assert.strictEqual(fx.block, true);
  assert.ok(!fx.dispatch);
  assert.strictEqual(fx.set.cli_serverVersion, '0.9.0');
  assert.strictEqual(fx.set.cli_rejected.reason, 'version_mismatch');
});

test('resume clears halt state', () => {
  assert.deepStrictEqual(onServerMessage({ type: 'resume' }, '0.8.0'), { remove: ['cli_halted'] });
});

test('HALT errors reply with code and reason; others stay plain', () => {
  assert.deepStrictEqual(errorReply(7, haltError('captcha')), { id: 7, error: 'HALT: captcha', code: 'HALT', reason: 'captcha' });
  assert.deepStrictEqual(errorReply(8, new Error('boom')), { id: 8, error: 'boom' });
  assert.deepStrictEqual(errorReply(9, 'str'), { id: 9, error: 'str' });
});

test('shouldReload only for {type:"reload"}', () => {
  assert.strictEqual(shouldReload({ type: 'reload' }), true);
  for (const v of [{ type: 'resume' }, { type: 'Reload' }, { id: 1, tool: 'post' }, {}, null, undefined, 'reload'])
    assert.strictEqual(shouldReload(v), false, JSON.stringify(v));
});
