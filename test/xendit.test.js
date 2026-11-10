const { test } = require('node:test');
const assert = require('node:assert/strict');
const xendit = require('../src/services/xendit');

test('Xendit v3 transport uses the pinned API, Basic auth and a bounded timeout without retries', async (t) => {
  Object.assign(process.env, { XENDIT_ENABLED: 'true', XENDIT_SECRET_KEY: 'synthetic-test-key',
    XENDIT_WEBHOOK_TOKEN: 'synthetic-callback', XENDIT_BUSINESS_ID: 'synthetic-business' });
  const calls = [];
  let upstream = () => new Response(JSON.stringify({ payment_request_id: 'pr-synthetic' }), { status: 201 });
  t.mock.method(global, 'fetch', async (...args) => { calls.push(args); return upstream(); });
  assert.deepEqual(await xendit.request('POST', '/payment_requests', { type: 'PAY' }), { payment_request_id: 'pr-synthetic' });
  const [url, options] = calls[0];
  assert.equal(url, 'https://api.xendit.co/v3/payment_requests');
  assert.equal(options.headers.Authorization, `Basic ${Buffer.from('synthetic-test-key:').toString('base64')}`);
  assert.equal(options.headers['api-version'], '2024-11-11');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.body, '{"type":"PAY"}');
  assert.equal(options.headers['Idempotency-Key'], undefined); // Not promised by the v3 create contract.

  for (const [status, definitive] of [[400, true], [401, true], [408, false], [409, false], [429, false], [500, false]]) {
    upstream = () => new Response(JSON.stringify({ error_code: 'TEST_FAILURE', message: 'private upstream details' }), { status });
    const before = calls.length;
    await assert.rejects(xendit.request('POST', '/payment_requests', {}), (err) => {
      assert.equal(err.definitive, definitive);
      assert.equal(err.code, 'TEST_FAILURE');
      assert.doesNotMatch(err.message, /private/);
      return true;
    });
    assert.equal(calls.length, before + 1);
  }
  upstream = () => { throw new Error('synthetic-test-key private fetch error'); };
  await assert.rejects(xendit.request('GET', '/payments/py-synthetic'), (err) => err.code === 'XENDIT_OUTCOME_UNKNOWN' && !err.message.includes('synthetic-test-key'));
  upstream = () => new Response('<html>private non-JSON response</html>');
  await assert.rejects(xendit.request('GET', '/payment_requests/pr-synthetic'), (err) => err.code === 'INVALID_XENDIT_RESPONSE');
  await assert.rejects(xendit.request('GET', '//untrusted.invalid'), /Invalid Xendit resource/);
});
