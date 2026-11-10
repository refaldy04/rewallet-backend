const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { credentialVersion } = require('../src/helpers/security');

const postgresAvailable = !spawnSync('initdb', ['--version'], { windowsHide: true }).error;

test('Xendit top ups against disposable PostgreSQL, mocked provider and real HTTP routes', {
  skip: postgresAvailable ? false : 'Install PostgreSQL binaries on PATH for integration checks', timeout: 120000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw9-topup-'));
  const data = path.join(root, 'data');
  const run = (command, args, silent = false) => execFileSync(command, args, { windowsHide: true, stdio: silent ? 'ignore' : 'pipe', timeout: 30000 });
  let started = false;
  let db;
  let server;
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    run('initdb', ['-D', data, '-U', 'topup_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start'], true);
    started = true;
    Object.assign(process.env, { DATABASE_URL: `postgresql://topup_test@127.0.0.1:${port}/postgres`,
      APP_SECRET: 'synthetic-topup-test-secret-never-used-in-production', XENDIT_ENABLED: 'true',
      XENDIT_SECRET_KEY: 'synthetic-test-key', XENDIT_WEBHOOK_TOKEN: 'synthetic-callback-token', XENDIT_BUSINESS_ID: 'synthetic-business',
      XENDIT_ENABLED_CHANNELS: 'DANA,SHOPEEPAY,QRIS', XENDIT_SUCCESS_RETURN_URL: 'https://frontend.example.invalid/topup/return?result=success',
      XENDIT_FAILURE_RETURN_URL: 'https://frontend.example.invalid/topup/return?result=failure', TOPUP_MIN_AMOUNT: '10000', TOPUP_MAX_AMOUNT: '10000000' });
    db = require('../src/helpers/db');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const tables = ['users', 'profile', 'transaction_type', 'transaction', 'wallets', 'wallet_entries', 'payment_requests', 'payment_webhook_events'];
    for (const table of tables) {
      await db.query(schema.match(new RegExp(`^CREATE TABLE public\\.${table} \\([\\s\\S]+?^\\);`, 'm'))[0]);
      const identity = schema.match(new RegExp(`^ALTER TABLE public\\.${table} ALTER COLUMN id ADD GENERATED[\\s\\S]+?^\\);`, 'm'));
      if (identity) await db.query(identity[0]);
    }
    for (const match of schema.matchAll(/^ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT[^;]+;/gm)) {
      if (tables.includes(match[1])) await db.query(match[0]);
    }
    await db.query(schema.match(/^CREATE UNIQUE INDEX transaction_sender_idempotency_key .+;$/m)[0]);
    for (const name of ['wallet_set_updated_at', 'wallet_entries_immutable', 'wallet_transaction_shape', 'wallet_reject_legacy_profile_balance', 'wallet_reject_legacy_transaction']) {
      await db.query(schema.match(new RegExp(`^CREATE FUNCTION public\\.${name}\\(\\)[\\s\\S]+?^\\$\\$;`, 'm'))[0]);
    }
    for (const name of ['wallets_updated_at', 'payment_requests_updated_at', 'wallet_entries_immutable', 'wallet_transaction_shape', 'wallet_reject_legacy_profile_balance', 'wallet_reject_legacy_transaction']) {
      await db.query(schema.match(new RegExp(`^CREATE TRIGGER ${name} .+;$`, 'm'))[0]);
    }
    const password = await bcrypt.hash('synthetic-password', 4);
    await db.query(`INSERT INTO public.users(email, username, password) VALUES
      ('one@example.invalid', 'one', $1), ('two@example.invalid', 'two', $1)`, [password]);
    await db.query(`INSERT INTO public.profile(user_id) VALUES (1), (2);
      INSERT INTO public.transaction_type(name, code) VALUES ('Top up', 'TOPUP');`);
    const tokens = [null, ...[1, 2].map((id) => jwt.sign({ id, credentialVersion: credentialVersion(password) }, process.env.APP_SECRET, { algorithm: 'HS256', expiresIn: '1h' }))];
    const xendit = require('../src/services/xendit');
    const topup = require('../src/services/topup');
    const calls = [];
    let responder;
    const snapshot = (body, extra = {}) => ({ ...body, business_id: 'synthetic-business', payment_request_id: 'pr-synthetic',
      status: 'REQUIRES_ACTION', actions: body.channel_code === 'QRIS' ? [{ type: 'PRESENT_TO_CUSTOMER', descriptor: 'QR_STRING', value: 'synthetic-qr' }] :
        [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://checkout.example.invalid/pay' }], ...extra });
    t.mock.method(xendit, 'request', async (method, resource, body) => {
      calls.push({ method, resource, body });
      return responder(method, resource, body);
    });
    const app = require('../index');
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, { method = 'GET', user = 1, key, body, headers = {} } = {}) {
      const res = await fetch(`${base}${route}`, { method, headers: { ...(user ? { Authorization: `Bearer ${tokens[user]}` } : {}),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await res.json();
      assert.doesNotMatch(JSON.stringify(payload), /synthetic-test-key|synthetic-callback-token|request_fingerprint|pin_hash|"password"/);
      return { status: res.status, body: payload };
    }
    const create = (body = {}, options = {}) => request('/topup', { method: 'POST', key: 'topup-key', body: { amount: '25000', channel_code: 'DANA', ...body }, ...options });
    const callback = (payload, token = 'synthetic-callback-token') => request('/webhooks/xendit/payments', {
      method: 'POST', user: null, headers: { 'x-callback-token': token }, body: payload });
    function capture(body = calls.find((call) => call.method === 'POST').body, extra = {}) {
      return { event: 'payment.capture', business_id: 'synthetic-business', data: { ...body, business_id: 'synthetic-business',
        payment_request_id: 'pr-synthetic', payment_id: 'py-synthetic', status: 'SUCCEEDED',
        captures: [{ capture_id: 'cap-synthetic', capture_amount: body.request_amount, capture_timestamp: '2026-11-09T01:02:03.000Z' }], ...extra } };
    }
    async function assertBalance(amount = '0', count = 0) {
      const wallets = (await db.query('SELECT user_id, balance FROM public.wallets ORDER BY user_id')).rows;
      assert.deepEqual(wallets, [{ user_id: 1, balance: amount }, { user_id: 2, balance: '0' }]);
      const ledger = (await db.query(`SELECT count(*)::integer AS count, coalesce(sum(amount), 0)::text AS total FROM public.wallet_entries`)).rows[0];
      assert.equal(ledger.count, count); assert.equal(ledger.total, amount);
      const credits = (await db.query('SELECT * FROM public.transaction ORDER BY id')).rows;
      assert.equal(credits.length, count);
      if (count) { assert.equal(credits[0].sender_id, null); assert.equal(credits[0].recipient_id, 1); assert.equal(credits[0].status, 'SUCCEEDED'); }
    }
    t.beforeEach(async () => {
      calls.length = 0;
      responder = (method, resource, body) => { assert.equal(method, 'POST'); return snapshot(body); };
      await db.query('TRUNCATE public.wallet_entries, public.transaction, public.wallets, public.payment_requests, public.payment_webhook_events RESTART IDENTITY CASCADE');
      await db.query('INSERT INTO public.wallets(user_id) VALUES (1), (2)');
    });

    await t.test('authenticated catalogue uses the explicit merchant allowlist and whole-rupiah limits', async () => {
      assert.equal((await request('/topup/methods', { user: null })).status, 401);
      const methods = await request('/auth/topup/methods');
      assert.equal(methods.status, 200);
      assert.deepEqual(methods.body.result.map((item) => item.channel_code), ['DANA', 'SHOPEEPAY', 'QRIS']);
      assert.ok(methods.body.result.every((item) => item.min_amount === '10000' && item.max_amount === '10000000'));
      process.env.XENDIT_ENABLED_CHANNELS = 'QRIS';
      try { assert.deepEqual((await request('/topup/methods')).body.result.map((item) => item.channel_code), ['QRIS']); }
      finally { process.env.XENDIT_ENABLED_CHANNELS = 'DANA,SHOPEEPAY,QRIS'; }
    });

    await t.test('creates a PAY request and returns provider actions without crediting funds', async () => {
      const result = await create();
      assert.equal(result.status, 201); assert.equal(result.body.result.status, 'REQUIRES_ACTION');
      assert.equal(result.body.result.amount, '25000');
      const sent = calls[0];
      assert.equal(sent.resource, '/payment_requests');
      assert.equal(sent.body.request_amount, 25000); assert.equal(sent.body.type, 'PAY'); assert.equal(sent.body.capture_method, 'AUTOMATIC');
      const url = new URL(sent.body.channel_properties.success_return_url);
      assert.equal(url.searchParams.get('topup_id'), result.body.result.id); assert.equal(url.searchParams.get('result'), 'success');
      assert.equal(result.body.result.actions[0].descriptor, 'WEB_URL');
      await assertBalance();
    });

    await t.test('QRIS returns presentation instructions and does not pretend to have a redirect', async () => {
      const result = await create({ channel_code: 'QRIS' });
      assert.equal(result.status, 201); assert.deepEqual(calls[0].body.channel_properties, {});
      assert.equal(result.body.result.actions[0].descriptor, 'QR_STRING'); await assertBalance();
    });

    await t.test('concurrent same-key retries create one provider request; changed payload conflicts', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => create()));
      assert.ok(results.every((item) => [200, 201, 202].includes(item.status)));
      assert.equal(new Set(results.map((item) => item.body.result.id)).size, 1);
      assert.equal(calls.length, 1);
      assert.equal((await create({ amount: 25000, currency: 'IDR' })).status, 200);
      assert.equal((await create({ amount: '26000' })).status, 409);
      assert.equal((await create({ channel_code: 'QRIS' })).status, 409);
      // A successful replay is still available if this channel is later disabled.
      process.env.XENDIT_ENABLED_CHANNELS = 'QRIS';
      try { assert.equal((await create()).status, 200); } finally { process.env.XENDIT_ENABLED_CHANNELS = 'DANA,SHOPEEPAY,QRIS'; }
      await assertBalance();
    });

    await t.test('idempotency is scoped per authenticated owner', async () => {
      let counter = 0;
      responder = (method, resource, body) => snapshot(body, { payment_request_id: `pr-${++counter}` });
      const one = await create(); const two = await create({}, { user: 2 });
      assert.equal(one.status, 201); assert.equal(two.status, 201); assert.notEqual(one.body.result.id, two.body.result.id); assert.equal(calls.length, 2);
    });

    await t.test('rejects invalid money, disabled channels, forged ownership/state and absent idempotency', async () => {
      for (const amount of ['0', '-1', '1.5', 1.5, '9007199254740992', '9999', '10000001', true]) assert.equal((await create({ amount })).status, 400);
      for (const body of [{ channel_code: 'CARDS' }, { currency: 'USD' }, { user_id: 2 }, { recipient_id: 2 }, { status: 'SUCCEEDED' }, { channel_properties: {} }, { idempotency_key: 'different' }]) assert.equal((await create(body)).status, 400);
      assert.equal((await create({}, { key: undefined })).status, 400);
      assert.equal((await create({}, { user: null })).status, 401); assert.equal(calls.length, 0); await assertBalance();
    });

    await t.test('status/refresh are owner-only; return query strings never prove payment', async () => {
      const id = (await create()).body.result.id;
      assert.equal((await request(`/topups/${id}?status=SUCCEEDED`)).body.result.status, 'REQUIRES_ACTION');
      assert.equal((await request(`/topups/${id}`, { user: 2 })).status, 404);
      assert.equal((await request(`/topups/${id}/refresh`, { method: 'POST', user: 2 })).status, 404);
      assert.equal((await request('/topups/not-a-uuid')).status, 400); assert.equal(calls.length, 1); await assertBalance();
    });

    await t.test('invalid token, business and partial captures never credit a wallet', async () => {
      await create(); const payload = capture();
      assert.equal((await callback(payload, 'wrong')).status, 401);
      assert.equal((await callback({ ...payload, business_id: 'other-business' })).status, 403);
      assert.equal((await callback(capture(undefined, { captures: [{ ...payload.data.captures[0], capture_amount: 100 }] }))).status, 400);
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.payment_webhook_events')).rows[0].n, 0); await assertBalance();
    });

    await t.test('concurrent duplicate captures credit exactly one transaction and one immutable ledger entry', async () => {
      const initial = await create(); const payload = capture(undefined, { metadata: { user_id: 2 } });
      const results = await Promise.all(Array.from({ length: 12 }, () => callback(payload)));
      assert.ok(results.every((result) => result.status === 200));
      await assertBalance('25000', 1);
      const settled = (await request(`/topups/${initial.body.result.id}`)).body.result;
      assert.equal(settled.status, 'SUCCEEDED'); assert.ok(settled.transaction_id); assert.deepEqual(settled.actions, []);
      assert.equal((await create()).body.result.transaction_id, settled.transaction_id);
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.payment_webhook_events')).rows[0].n, 1);
      assert.equal((await request('/historyTransaction')).body.result[0].type_code, 'TOPUP');
    });

    await t.test('webhook arriving before the create response binds by reference and cannot be regressed', async () => {
      responder = async (method, resource, body) => { assert.equal((await callback(capture(body))).status, 200); return snapshot(body); };
      const initial = await create(); assert.equal(initial.status, 201); assert.equal(initial.body.result.status, 'SUCCEEDED');
      assert.deepEqual(initial.body.result.actions, []); await assertBalance('25000', 1);
    });

    await t.test('ambiguous creation is UNKNOWN, retry never creates again, and a late capture recovers it', async () => {
      responder = () => { throw new xendit.XenditError('XENDIT_OUTCOME_UNKNOWN'); };
      const initial = await create(); assert.equal(initial.status, 202); assert.equal(initial.body.result.status, 'UNKNOWN');
      assert.equal((await create()).status, 202); assert.equal(calls.length, 1); await assertBalance();
      assert.equal((await callback(capture())).status, 200); await assertBalance('25000', 1);
    });

    await t.test('definite provider rejections stay failed and redact upstream details', async () => {
      responder = () => { throw new xendit.XenditError('CHANNEL_NOT_ACTIVATED', true); };
      const initial = await create(); assert.equal(initial.body.result.status, 'FAILED');
      assert.equal(initial.body.result.failure_code, 'CHANNEL_NOT_ACTIVATED');
      assert.equal((await create()).status, 200); assert.equal(calls.length, 1); await assertBalance();
    });

    await t.test('amount and provider identity mismatches are retained in the failed inbox', async () => {
      await create();
      const payload = capture(undefined, { request_amount: 26000, captures: [{ capture_id: 'cap-synthetic', capture_amount: 26000, capture_timestamp: '2026-11-09T01:02:03.000Z' }] });
      assert.equal((await callback(payload)).status, 503); await assertBalance();
      const event = (await db.query('SELECT * FROM public.payment_webhook_events')).rows[0];
      assert.equal(event.processing_status, 'FAILED'); assert.equal(event.attempt_count, 1);
      assert.equal((await callback(capture())).status, 409); // Conflicting data cannot overwrite stored evidence.
      assert.equal((await db.query('SELECT payload FROM public.payment_webhook_events')).rows[0].payload.data.request_amount, 26000);
    });

    await t.test('country, currency, channel, flow and provider ID must match before any credit', async () => {
      await create();
      const mismatches = [{ currency: 'USD' }, { country: 'PH' }, { channel_code: 'QRIS' }, { type: 'PAY_AND_SAVE' },
        { capture_method: 'MANUAL' }, { reference_id: 'topup-unknown-reference' }, { payment_request_id: 'pr-other' }];
      for (const [index, mismatch] of mismatches.entries()) {
        const payload = capture(undefined, { ...mismatch, payment_id: `py-mismatch-${index}` });
        payload.data.captures[0].capture_id = `cap-mismatch-${index}`;
        assert.equal((await callback(payload)).status, 503);
        await assertBalance();
      }
      assert.equal((await callback(capture())).status, 200); await assertBalance('25000', 1);
    });

    await t.test('failed payments may later capture; late failures never undo a settled payment', async () => {
      const initial = await create();
      const failed = { ...capture(), event: 'payment.failure', data: { ...capture().data, status: 'FAILED', failure_code: 'INSUFFICIENT_BALANCE' } };
      assert.equal((await callback(failed)).status, 200); assert.equal((await topup.get(1, initial.body.result.id)).status, 'FAILED'); await assertBalance();
      assert.equal((await callback(capture())).status, 200);
      assert.equal((await callback({ ...failed, data: { ...failed.data, payment_id: 'py-late-failure' } })).status, 200);
      assert.equal((await topup.get(1, initial.body.result.id)).status, 'SUCCEEDED'); await assertBalance('25000', 1);
    });

    await t.test('a second distinct capture for one top up is retained for review without double credit', async () => {
      await create(); assert.equal((await callback(capture())).status, 200);
      const payload = capture(); payload.data.captures[0].capture_id = 'cap-second';
      assert.equal((await callback(payload)).status, 503); await assertBalance('25000', 1);
    });

    await t.test('ledger failure rolls back every financial write and the durable inbox can be replayed', async () => {
      await create();
      await db.query(`CREATE FUNCTION public.reject_test_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
        CREATE TRIGGER reject_test_credit BEFORE INSERT ON public.wallet_entries FOR EACH ROW EXECUTE FUNCTION public.reject_test_credit()`);
      try { assert.equal((await callback(capture())).status, 503); await assertBalance(); }
      finally { await db.query('DROP TRIGGER reject_test_credit ON public.wallet_entries; DROP FUNCTION public.reject_test_credit()'); }
      assert.deepEqual(await topup.retryEvents(), { selected: 1, processed: 1, failed: 0 });
      await assertBalance('25000', 1); assert.equal((await callback(capture())).status, 200); await assertBalance('25000', 1);
    });

    await t.test('wallet balance overflow retains capture evidence without partial financial writes', async () => {
      await create();
      await db.query("UPDATE public.wallets SET balance=9223372036854775807 WHERE user_id=1");
      assert.equal((await callback(capture())).status, 503);
      assert.equal((await db.query('SELECT balance FROM public.wallets WHERE user_id=1')).rows[0].balance, '9223372036854775807');
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.transaction')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.wallet_entries')).rows[0].n, 0);
      await db.query('UPDATE public.wallets SET balance=0 WHERE user_id=1');
      assert.equal((await topup.retryEvents()).processed, 1); await assertBalance('25000', 1);
    });

    await t.test('lost commit acknowledgement is safe to retry after credit already committed', async () => {
      await create();
      const connect = db.connect.bind(db); let fail = true;
      const mock = t.mock.method(db, 'connect', async (...args) => {
        if (args.length) return connect(...args); // pg.Pool.query uses the callback overload.
        const client = await connect(...args); const query = client.query.bind(client);
        client.query = async (...queryArgs) => { const result = await query(...queryArgs); if (queryArgs[0] === 'COMMIT' && fail) { client.query = query; fail = false; throw new Error('lost COMMIT acknowledgement'); } return result; };
        return client;
      });
      try { assert.equal((await callback(capture())).status, 503); } finally { mock.mock.restore(); }
      assert.equal((await callback(capture())).status, 200); await assertBalance('25000', 1);
    });

    await t.test('reconciliation requires verified payment capture, not just a successful Payment Request', async () => {
      const initial = await create(); const sent = calls[0].body;
      responder = () => snapshot(sent, { status: 'SUCCEEDED', actions: [] });
      assert.equal((await request(`/topups/${initial.body.result.id}/refresh`, { method: 'POST' })).body.result.status, 'PENDING'); await assertBalance();
      responder = (method, resource) => resource.startsWith('/payment_requests/') ? snapshot(sent, { status: 'SUCCEEDED', latest_payment_id: 'py-synthetic', actions: [] }) : capture(sent).data;
      const refreshed = await request(`/topups/${initial.body.result.id}/refresh`, { method: 'POST' });
      assert.equal(refreshed.status, 200); assert.equal(refreshed.body.result.status, 'SUCCEEDED'); await assertBalance('25000', 1);
      assert.equal((await callback(capture(sent))).status, 200); await assertBalance('25000', 1);
    });

    await t.test('operator recovery verifies a supplied provider ID before binding an UNKNOWN request', async () => {
      responder = () => { throw new xendit.XenditError('XENDIT_OUTCOME_UNKNOWN'); };
      const initial = await create(); const sent = calls[0].body;
      responder = () => snapshot(sent, { reference_id: 'some-other-reference' });
      await assert.rejects(topup.reconcile(initial.body.result.id, 'pr-synthetic'), /identity or amount mismatch/);
      assert.equal((await topup.get(1, initial.body.result.id)).payment_request_id, null);
      responder = (method, resource) => resource.startsWith('/payment_requests/') ? snapshot(sent, { latest_payment_id: 'py-synthetic' }) : capture(sent).data;
      assert.equal((await topup.reconcile(initial.body.result.id, 'pr-synthetic')).status, 'SUCCEEDED');
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1); await assertBalance('25000', 1);
    });

    await t.test('stale reservations become UNKNOWN and are never automatically submitted again', async () => {
      responder = () => { throw new xendit.XenditError('XENDIT_OUTCOME_UNKNOWN'); };
      const initial = await create();
      await db.query("UPDATE public.payment_requests SET status='CREATED', created_at=now()-interval '10 minutes' WHERE id=$1", [initial.body.result.id]);
      assert.equal((await topup.reconcile(initial.body.result.id)).status, 'UNKNOWN');
      assert.equal((await create()).status, 202); assert.equal(calls.length, 1); await assertBalance();
    });

    await t.test('equivalent capture timestamps from lookup/webhook deduplicate, and unsafe actions are rejected', async () => {
      await create();
      assert.equal((await callback(capture())).status, 200);
      const equivalent = capture(); equivalent.data.captures[0].capture_timestamp = '2026-11-09T01:02:03Z';
      assert.equal((await callback(equivalent)).status, 200); await assertBalance('25000', 1);
      responder = (method, resource, body) => snapshot(body, { payment_request_id: 'pr-unsafe', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'javascript:alert(1)' }] });
      const unsafe = await create({}, { key: 'unsafe-action' });
      assert.equal(unsafe.status, 202); assert.equal(unsafe.body.result.status, 'UNKNOWN'); assert.deepEqual(unsafe.body.result.actions, []);
      await assertBalance('25000', 1);
    });

    await t.test('disabled integration and invalid return URLs fail before contacting the provider', async () => {
      process.env.XENDIT_ENABLED = 'false';
      try { assert.equal((await create()).status, 503); } finally { process.env.XENDIT_ENABLED = 'true'; }
      const saved = process.env.XENDIT_SUCCESS_RETURN_URL; process.env.XENDIT_SUCCESS_RETURN_URL = 'javascript:alert(1)';
      try { assert.equal((await create()).status, 503); } finally { process.env.XENDIT_SUCCESS_RETURN_URL = saved; }
      assert.equal(calls.length, 0); await assertBalance();
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], true);
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
