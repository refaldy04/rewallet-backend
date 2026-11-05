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

test('atomic transfers against disposable PostgreSQL and real HTTP routes', { skip: postgresAvailable ? false : 'Install PostgreSQL binaries on PATH for integration checks', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw9-transfer-'));
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
    run('initdb', ['-D', data, '-U', 'transfer_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    const startupLog = path.join(root, 'pg_ctl.log');
    const startupOutput = fs.openSync(startupLog, 'w');
    try {
      execFileSync('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start'],
        { windowsHide: true, stdio: ['ignore', startupOutput, startupOutput], timeout: 30000 });
    } catch (err) {
      const log = path.join(root, 'postgres.log');
      throw new Error(`Disposable PostgreSQL startup failed: ${fs.readFileSync(startupLog, 'utf8')} ${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'No server log'}`, { cause: err });
    } finally {
      fs.closeSync(startupOutput);
    }
    started = true;
    process.env.DATABASE_URL = `postgresql://transfer_test@127.0.0.1:${port}/postgres`;
    process.env.APP_SECRET = 'synthetic-transfer-test-secret-never-used-in-production';
    db = require('../src/helpers/db');

    // Use the reference schema, including its constraints, indexes and cutover guards.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const tables = ['users', 'profile', 'transaction_type', 'transaction', 'wallets', 'wallet_entries'];
    for (const table of tables) {
      await db.query(schema.match(new RegExp(`^CREATE TABLE public\\.${table} \\([\\s\\S]+?^\\);`, 'm'))[0]);
      await db.query(schema.match(new RegExp(`^ALTER TABLE public\\.${table} ALTER COLUMN id ADD GENERATED[\\s\\S]+?^\\);`, 'm'))[0]);
    }
    for (const match of schema.matchAll(/^ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT[^;]+;/gm)) {
      if (tables.includes(match[1])) await db.query(match[0]);
    }
    await db.query(schema.match(/^CREATE UNIQUE INDEX transaction_sender_idempotency_key .+;$/m)[0]);
    for (const name of ['wallet_set_updated_at', 'wallet_entries_immutable', 'wallet_transaction_shape', 'wallet_reject_legacy_profile_balance', 'wallet_reject_legacy_transaction']) {
      await db.query(schema.match(new RegExp(`^CREATE FUNCTION public\\.${name}\\(\\)[\\s\\S]+?^\\$\\$;`, 'm'))[0]);
    }
    for (const name of ['wallets_updated_at', 'wallet_entries_immutable', 'wallet_transaction_shape', 'wallet_reject_legacy_profile_balance', 'wallet_reject_legacy_transaction']) {
      await db.query(schema.match(new RegExp(`^CREATE TRIGGER ${name} .+;$`, 'm'))[0]);
    }
    const password = await bcrypt.hash('synthetic-password', 4);
    const pinHash = await bcrypt.hash('001234', 4);
    await db.query(`INSERT INTO public.users(email, username, password) VALUES
      ('one@example.invalid', 'one', $1), ('two@example.invalid', 'two', $1), ('three@example.invalid', 'three', $1);
    `, [password]);
    await db.query(`INSERT INTO public.profile(id, user_id, balance) VALUES
      (3, 1, 0::numeric::money), (1, 2, 0::numeric::money), (2, 3, 0::numeric::money);
      INSERT INTO public.transaction_type(name, code) VALUES
      ('Transfer', 'TRANSFER'), ('Opening balance', 'OPENING_BALANCE');`);
    const tokens = [null, ...[1, 2, 3].map((id) => jwt.sign({ id, credentialVersion: credentialVersion(password) }, process.env.APP_SECRET, { algorithm: 'HS256', expiresIn: '1h' }))];
    const app = require('../index');
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(body = {}, { sender = 1, key = 'transfer-key', route = '/transfer', headers = {} } = {}) {
      const res = await fetch(`${base}${route}`, { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(sender ? { Authorization: `Bearer ${tokens[sender]}` } : {}),
        ...(key === null ? {} : { 'Idempotency-Key': key }), ...headers,
      }, body: JSON.stringify({ pin: '001234', recipient_id: 2, amount: '100', ...body }) });
      const payload = await res.json();
      assert.doesNotMatch(JSON.stringify(payload), /"(?:pin|pin_hash|password|pin_failed_attempts|pin_locked_until|request_fingerprint)"\s*:/);
      return { status: res.status, body: payload, headers: res.headers };
    }
    async function reset(balances = ['1000', '0', '0']) {
      await db.query('TRUNCATE public.wallet_entries, public.transaction, public.wallets RESTART IDENTITY CASCADE');
      await db.query('UPDATE public.users SET pin=NULL, pin_hash=$1, pin_failed_attempts=0, pin_locked_until=NULL', [pinHash]);
      await db.query(`INSERT INTO public.wallets(user_id, balance)
        SELECT ordinality::integer, balance FROM unnest($1::bigint[]) WITH ORDINALITY AS initial(balance, ordinality)`, [balances]);
      await db.query(`WITH opening AS (
        INSERT INTO public.transaction(amount, recipient_id, "time", type_id, status)
        SELECT w.balance, w.user_id, now() AT TIME ZONE 'UTC', tt.id, 'SUCCEEDED'
        FROM public.wallets w CROSS JOIN public.transaction_type tt WHERE w.balance > 0 AND tt.code='OPENING_BALANCE'
        RETURNING id, recipient_id, amount)
        INSERT INTO public.wallet_entries(wallet_id, transaction_id, direction, amount)
        SELECT w.id, t.id, 'CREDIT', t.amount FROM opening t JOIN public.wallets w ON w.user_id=t.recipient_id`);
    }
    async function snapshot() {
      return (await db.query(`SELECT
        (SELECT jsonb_agg(w ORDER BY w.user_id) FROM public.wallets w) AS wallets,
        (SELECT jsonb_agg(t ORDER BY t.id) FROM public.transaction t) AS transactions,
        (SELECT jsonb_agg(e ORDER BY e.id) FROM public.wallet_entries e) AS entries`)).rows[0];
    }
    async function assertConsistent(expectedTransfers) {
      const balances = await db.query(`SELECT w.user_id, w.balance,
        coalesce(sum(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS ledger_balance
        FROM public.wallets w LEFT JOIN public.wallet_entries e ON e.wallet_id=w.id GROUP BY w.id ORDER BY w.user_id`);
      for (const wallet of balances.rows) {
        assert.ok(BigInt(wallet.balance) >= 0n);
        assert.equal(wallet.balance, wallet.ledger_balance);
      }
      const { rows: transactions } = await db.query(`SELECT t.* FROM public.transaction t
        JOIN public.transaction_type tt ON tt.id=t.type_id WHERE tt.code='TRANSFER'`);
      assert.equal(transactions.length, expectedTransfers);
      for (const transaction of transactions) {
        assert.equal(transaction.status, 'SUCCEEDED');
        assert.equal(transaction.currency, 'IDR');
        const { rows: entries } = await db.query(`SELECT e.direction, e.amount, w.user_id FROM public.wallet_entries e
          JOIN public.wallets w ON w.id=e.wallet_id WHERE e.transaction_id=$1 ORDER BY e.direction`, [transaction.id]);
        assert.deepEqual(entries, [
          { direction: 'CREDIT', amount: transaction.amount, user_id: transaction.recipient_id },
          { direction: 'DEBIT', amount: transaction.amount, user_id: transaction.sender_id },
        ]);
      }
      return balances.rows.map(({ balance }) => balance);
    }
    t.beforeEach(() => reset());

    await t.test('validates authentication, PIN format, recipients, whole rupiah and keys without financial writes', async () => {
      const before = await snapshot();
      assert.equal((await request({}, { sender: null })).status, 401);
      for (const body of [
        { pin: 1234 }, { pin: '12345' }, { pin: 'abcdef' },
        { recipient_id: 1 }, { recipient_id: null }, { recipient_id: true }, { recipient_id: [] },
        { recipient_id: '2x' }, { recipient_id: 2.5 }, { recipient_id: 2147483648 },
        ...[undefined, null, true, [], {}, 0, -1, '0', '1.5', 1.5, '1e2', '100junk', ' 100', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1].map((amount) => ({ amount })),
        { currency: 'USD' }, { notes: {} }, { idempotency_key: 'different' },
      ]) assert.equal((await request(body)).status, 400, JSON.stringify(body));
      for (const key of [null, '', 'x'.repeat(129), 'with space']) assert.equal((await request({}, { key })).status, 400);
      assert.equal((await request({ recipient_id: 999999 })).status, 404);
      assert.deepEqual(await snapshot(), before);
      await db.query('DELETE FROM public.wallets WHERE user_id=3');
      assert.equal((await request({ recipient_id: 3 })).status, 404);
      assert.equal((await request({ recipient_id: 2 }, { sender: 3 })).status, 409);
      await assertConsistent(0);
    });

    await t.test('persists wrong PIN attempts and shares lockout with other PIN endpoints', async () => {
      const before = await snapshot();
      const guesses = await Promise.all(Array.from({ length: 8 }, () => request({ pin: '999999' })));
      assert.equal(guesses.filter(({ status }) => status === 400).length, 4);
      assert.equal(guesses.filter(({ status }) => status === 429).length, 4);
      assert.equal((await db.query('SELECT pin_failed_attempts FROM public.users WHERE id=1')).rows[0].pin_failed_attempts, 5);
      const locked = await request({}, { route: '/checkPin' });
      assert.equal(locked.status, 429);
      assert.ok(Number(locked.headers.get('retry-after')) > 0);
      assert.equal((await request()).status, 429);
      assert.deepEqual(await snapshot(), before);
      await db.query("UPDATE public.users SET pin_locked_until=now() - interval '1 second' WHERE id=1");
      assert.equal((await request()).status, 200);
      assert.deepEqual((await db.query('SELECT pin_failed_attempts, pin_locked_until FROM public.users WHERE id=1')).rows[0], { pin_failed_attempts: 0, pin_locked_until: null });
      await assertConsistent(1);
    });

    await t.test('requires a configured PIN and upgrades legacy PINs in the transfer transaction', async () => {
      await db.query('UPDATE public.users SET pin_hash=NULL WHERE id=1');
      assert.equal((await request()).status, 409);
      await db.query("UPDATE public.users SET pin='001234' WHERE id=1");
      assert.equal((await request()).status, 200);
      const user = (await db.query('SELECT pin, pin_hash FROM public.users WHERE id=1')).rows[0];
      assert.equal(user.pin, null);
      assert.ok(await bcrypt.compare('001234', user.pin_hash));
      await assertConsistent(1);
    });

    await t.test('successful transfer uses authenticated user, user_id, canonical type and server timestamps', async () => {
      const result = await request({ sender_id: 3, type_id: 9999, status: 'FAILED', time: '2000-01-01', notes: 'Lunch' });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.result.sender_id, 1);
      assert.equal(result.body.result.recipient_id, 2);
      assert.equal(result.body.result.amount, '100');
      assert.equal(result.body.result.notes, 'Lunch');
      assert.equal(result.body.result.type_code, 'TRANSFER');
      assert.ok(new Date(result.body.result.created_at) > new Date('2026-01-01'));
      assert.deepEqual(await assertConsistent(1), ['900', '100', '0']);
      assert.deepEqual((await db.query('SELECT balance::numeric::text AS balance FROM public.profile ORDER BY user_id')).rows.map(({ balance }) => balance), ['0.00', '0.00', '0.00']);
    });

    await t.test('retries return the same result after funds are spent and normalize JSON/form values', async () => {
      const initial = await request({ amount: '1000', notes: null });
      assert.equal(initial.status, 200);
      const retry = await request({ amount: 1000, recipient_id: '02', currency: 'IDR' }, { route: '/auth/transfer' });
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.body, initial.body);
      const form = await fetch(`${base}/transfer`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[1]}` },
        body: new URLSearchParams({ pin: '001234', recipient_id: '2', amount: '1000', idempotency_key: 'transfer-key' }) });
      assert.equal(form.status, 200);
      assert.deepEqual(await form.json(), initial.body);
      assert.deepEqual(await assertConsistent(1), ['0', '1000', '0']);
    });

    await t.test('parallel duplicates create exactly one transfer and changed payloads conflict', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => request()));
      for (const result of results) {
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(result.body, results[0].body);
      }
      for (const body of [{ amount: '101' }, { recipient_id: 3 }, { notes: 'different' }]) assert.equal((await request(body)).status, 409);
      assert.equal((await request({ pin: '999999' })).status, 400);
      // The same key belongs to a different namespace for another sender.
      assert.equal((await request({ recipient_id: 3, amount: 50 }, { sender: 2 })).status, 200);
      assert.deepEqual(await assertConsistent(2), ['900', '50', '50']);
    });

    await t.test('insufficient funds leave no transaction or poisoned idempotency key', async () => {
      const before = await snapshot();
      assert.equal((await request({ amount: 1001 })).status, 409);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await request({ amount: 1000 })).status, 200);
      await assertConsistent(1);
    });

    await t.test('concurrent different keys cannot overspend or diverge from the ledger', async () => {
      const results = await Promise.all(Array.from({ length: 16 }, (_, i) => request({ recipient_id: i % 2 ? 2 : 3 }, { key: `parallel-${i}` })));
      assert.equal(results.filter(({ status }) => status === 200).length, 10, JSON.stringify(results));
      assert.equal(results.filter(({ status }) => status === 409).length, 6);
      const balances = await assertConsistent(10);
      assert.equal(balances[0], '0');
      assert.equal(balances.reduce((sum, balance) => sum + BigInt(balance), 0n), 1000n);
    });

    await t.test('opposing transfers complete without foreign-key or wallet-lock deadlocks', async () => {
      await reset(['1000', '1000', '0']);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => request({ recipient_id: i % 2 ? 1 : 2, amount: 50 }, { sender: i % 2 ? 2 : 1, key: `opposing-${i}` })));
      for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(await assertConsistent(12), ['1000', '1000', '0']);
    });

    await t.test('large whole rupiah amounts preserve precision and recipient overflow rolls back', async () => {
      await reset(['9007199254740993', '0', '0']);
      const result = await request({ amount: '9007199254740993' });
      assert.equal(result.status, 200);
      assert.equal(result.body.result.amount, '9007199254740993');
      assert.deepEqual(await assertConsistent(1), ['0', '9007199254740993', '0']);
      await reset(['10', '9223372036854775807', '0']);
      const before = await snapshot();
      assert.equal((await request({ amount: '1' })).status, 409);
      assert.deepEqual(await snapshot(), before);
      await assertConsistent(0);
    });

    await t.test('ledger failure rolls back both balances and the transaction, allowing retry', async () => {
      const before = await snapshot();
      await db.query(`CREATE FUNCTION public.test_reject_credit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.direction='CREDIT' THEN RAISE EXCEPTION 'Synthetic ledger failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_reject_credit BEFORE INSERT ON public.wallet_entries FOR EACH ROW EXECUTE FUNCTION public.test_reject_credit();`);
      try {
        assert.equal((await request()).status, 500);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await db.query('DROP TRIGGER test_reject_credit ON public.wallet_entries; DROP FUNCTION public.test_reject_credit()');
      }
      assert.equal((await request()).status, 200);
      assert.deepEqual(await assertConsistent(1), ['900', '100', '0']);
    });

    await t.test('PIN checks and all financial writes use one checked-out connection', async (t) => {
      const transfer = require('../src/services/transfer');
      const connect = db.connect;
      let connections = 0;
      const connectionMock = t.mock.method(db, 'connect', function (...args) { connections++; return connect.apply(this, args); });
      const queryMock = t.mock.method(db, 'query', () => { throw new Error('Pool queries cannot participate in a transfer'); });
      try {
        const first = await transfer(1, { pin: '001234', recipient_id: 2, amount: 100 }, 'one-connection');
        assert.equal(connections, 1);
        assert.deepEqual(await transfer(1, { pin: '001234', recipient_id: 2, amount: '100' }, 'one-connection'), first);
        assert.equal(connections, 2);
      } finally {
        connectionMock.mock.restore();
        queryMock.mock.restore();
      }
      await assertConsistent(1);
    });

    await t.test('retry after a lost COMMIT acknowledgement cannot duplicate a committed transfer', async (t) => {
      const transfer = require('../src/services/transfer');
      const connect = db.connect;
      const connectionMock = t.mock.method(db, 'connect', async function (...args) {
        const client = await connect.apply(this, args);
        const query = client.query;
        client.query = async function (...queryArgs) {
          const result = await query.apply(this, queryArgs);
          if (queryArgs[0] === 'COMMIT') {
            client.query = query;
            throw new Error('Synthetic lost COMMIT acknowledgement');
          }
          return result;
        };
        return client;
      });
      try {
        await assert.rejects(transfer(1, { pin: '001234', recipient_id: 2, amount: 100 }, 'lost-commit'), /lost COMMIT acknowledgement/);
      } finally {
        connectionMock.mock.restore();
      }
      const retry = await request({}, { key: 'lost-commit' });
      assert.equal(retry.status, 200);
      assert.deepEqual(await assertConsistent(1), ['900', '100', '0']);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], true);
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
