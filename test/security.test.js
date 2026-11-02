const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { inspect } = require('node:util');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../src/helpers/security');

test('JWT configuration rejects missing and blank secrets', () => {
  const previous = process.env.APP_SECRET;
  try {
    delete process.env.APP_SECRET;
    assert.throws(jwtSecret, /APP_SECRET/);
    process.env.APP_SECRET = '   ';
    assert.throws(jwtSecret, /APP_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
});

const postgresAvailable = !spawnSync('initdb', ['--version'], { windowsHide: true }).error;

test('security regressions against disposable PostgreSQL and real HTTP routes', { skip: postgresAvailable ? false : 'Install PostgreSQL binaries on PATH for integration checks', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw9-security-'));
  const data = path.join(root, 'data');
  let started = false;
  let server;
  let db;
  const applicationLogs = [];
  const captureLog = (...args) => applicationLogs.push(args.map((value) => typeof value === 'string' ? value : inspect(value, { depth: 4 })).join(' '));
  t.mock.method(console, 'log', captureLog);
  t.mock.method(console, 'error', captureLog);
  const run = (command, args, silent = false) => execFileSync(command, args, { windowsHide: true, stdio: silent ? 'ignore' : 'pipe', timeout: 30000 });
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    run('initdb', ['-D', data, '-U', 'security_test', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    // pg_ctl descendants must not inherit captured pipes on Windows.
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start'], true);
    started = true;
    process.env.DATABASE_URL = `postgresql://security_test@127.0.0.1:${port}/postgres`;
    process.env.APP_SECRET = 'synthetic-security-test-secret-never-used-in-production';
    process.env.ADMIN_USER_IDS = '1';
    db = require('../src/helpers/db');

    // Extract the actual application table definitions from the requested reference.
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    for (const table of ['users', 'profile', 'transaction_type', 'transaction']) {
      const definition = schema.match(new RegExp(`^CREATE TABLE public\\.${table} \\([\\s\\S]+?^\\);`, 'm'));
      const identity = schema.match(new RegExp(`^ALTER TABLE public\\.${table} ALTER COLUMN id ADD GENERATED[\\s\\S]+?^\\);`, 'm'));
      assert.ok(definition && identity, `Missing ${table} in schema.sql`);
      await db.query(definition[0]);
      await db.query(identity[0]);
    }
    await db.query(`ALTER TABLE public.users ADD PRIMARY KEY (id), ADD UNIQUE (email), ADD UNIQUE (username);
      ALTER TABLE public.profile ADD PRIMARY KEY (id), ADD UNIQUE (user_id), ADD FOREIGN KEY (user_id) REFERENCES public.users(id);
      INSERT INTO public.transaction_type(name) VALUES ('Synthetic');`);
    const password = 'synthetic-password';
    const hash = await bcrypt.hash(password, 4);
    await db.query(`INSERT INTO public.users(email, username, password, pin) VALUES
      ('admin@example.invalid', 'admin', $1, '012345'),
      ('member@example.invalid', 'member', $1, NULL),
      ('other@example.invalid', 'other', $1, '654321');`, [hash]);
    // Deliberately collide profile IDs with a different user's ID.
    await db.query(`INSERT INTO public.profile(id, user_id, fullname, balance, phone_number) VALUES
      (2, 1, 'Admin', 100::numeric::money, '081111111111'),
      (3, 2, 'Member', 200::numeric::money, '082222222222'),
      (1, 3, 'Other', 300::numeric::money, '083333333333');
      SELECT setval('public.profile_id_seq', 3);`);

    const app = require('../index');
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const secrets = ['012345', '654321', password, hash];
    async function request(route, { method = 'GET', token, body, headers = {} } = {}) {
      const res = await fetch(`${base}${route}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await res.json();
      const serialized = JSON.stringify(payload);
      for (const secret of secrets) assert.equal(serialized.includes(secret), false, `Response leaked a credential on ${route}`);
      assert.doesNotMatch(serialized, /"(?:pin|pin_hash|password|pin_failed_attempts|pin_locked_until)"\s*:/);
      return { status: res.status, body: payload, headers: res.headers };
    }
    async function login(email, supplied = password) {
      const res = await request('/auth/login', { method: 'POST', body: { email, password: supplied } });
      assert.equal(res.status, 200);
      return res.body.result.token;
    }
    const admin = await login('admin@example.invalid');
    let member = await login('member@example.invalid');
    const other = await login('other@example.invalid');

    await t.test('all admin routers reject anonymous and ordinary accounts on every method', async () => {
      for (const prefix of ['', '/auth']) {
        for (const route of ['user', 'profile', 'transaction', 'transactionType']) {
          for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
            const url = `/admin/${route}${method === 'PATCH' || method === 'DELETE' ? '/1' : ''}`;
            assert.equal((await request(url, { method })).status, 401);
            assert.equal((await request(url, { method, token: member })).status, 403);
          }
        }
        // Both public auth route mounts enforce authentication.
        assert.equal((await request(`${prefix}/createPin`, { method: 'POST', body: { email: 'other@example.invalid', pin: '111111' } })).status, 401);
        assert.equal((await request(`${prefix}/resetPassword/3`, { method: 'PATCH', body: { newpassword: 'stolen-password' } })).status, 401);
      }
      assert.equal((await request('/admin/user', { token: admin })).status, 200);
      assert.equal((await request('/admin/profile', { token: admin })).status, 200);
      const savedIds = process.env.ADMIN_USER_IDS;
      delete process.env.ADMIN_USER_IDS;
      assert.equal((await request('/admin/user', { token: admin })).status, 403);
      process.env.ADMIN_USER_IDS = savedIds;
    });

    await t.test('malformed, expired, forged and previous unbound JWTs are rejected promptly', async () => {
      for (const Authorization of ['Basic abc', 'Bearer', 'Bearer ', 'Bearer invalid', 'Bearer invalid extra']) {
        assert.equal((await request('/profile', { headers: { Authorization } })).status, 401);
      }
      const claims = jwt.decode(member);
      for (const token of [
        jwt.sign({ id: 2 }, process.env.APP_SECRET),
        jwt.sign({ ...claims, exp: 1 }, process.env.APP_SECRET),
        jwt.sign(claims, 'previous-fallback-test-secret'),
        jwt.sign(claims, process.env.APP_SECRET, { algorithm: 'HS384' }),
        jwt.sign({ ...claims, id: '2' }, process.env.APP_SECRET),
      ]) assert.equal((await request('/profile', { token })).status, 401);
    });

    await t.test('profile updates affect only the authenticated owner and reject protected fields', async () => {
      for (const route of ['/profile', '/auth/profile']) {
        const res = await request(route, { method: 'PATCH', token: member, body: { fullname: 'Member updated' } });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.result.map((row) => row.user_id), [2]);
      }
      for (const body of [{ balance: '999999' }, { user_id: 3 }, { id: 1 }, { pin: '123456' }, { role: 'admin' }, { fullname: 'Injected', balance: 1 }]) {
        assert.equal((await request('/profile', { method: 'PATCH', token: member, body })).status, 400);
      }
      const { rows } = await db.query('SELECT user_id, fullname, balance::numeric::integer AS balance FROM public.profile ORDER BY user_id');
      assert.deepEqual(rows, [{ user_id: 1, fullname: 'Admin', balance: 100 }, { user_id: 2, fullname: 'Member updated', balance: 200 }, { user_id: 3, fullname: 'Other', balance: 300 }]);
      const recipients = await request('/allProfile', { token: member });
      assert.equal(recipients.status, 200);
      for (const row of recipients.body.result) assert.deepEqual(Object.keys(row).sort(), ['fullname', 'id', 'picture', 'user_id']);
      const injection = await request(`/allProfile?search=${encodeURIComponent("' UNION SELECT * FROM users --")}`, { token: member });
      assert.equal(injection.status, 200);
      assert.deepEqual(injection.body.result, []);
      assert.equal((await request('/admin/user?sortBy=password;DROP%20TABLE%20users', { token: admin })).status, 200);
      const adminEdit = await request('/admin/profile/1', { method: 'PATCH', token: admin, body: { fullname: 'Other updated by admin' } });
      assert.equal(adminEdit.status, 200);
      assert.deepEqual(adminEdit.body.result.map((row) => row.user_id), [3]);
      assert.equal((await db.query('SELECT fullname FROM public.profile WHERE user_id=1')).rows[0].fullname, 'Admin');
      assert.equal((await request('/admin/profile/1', { method: 'PATCH', token: admin, body: { balance: 1 } })).status, 400);
      assert.equal((await request('/admin/profile/1', { method: 'PATCH', token: admin, body: { user_id: 1 } })).status, 400);
    });

    await t.test('PIN creation is authenticated, owner-scoped, hashed and cannot overwrite a PIN', async () => {
      const res = await request('/createPin', { method: 'POST', token: member, body: { email: 'other@example.invalid', pin: '001234' } });
      assert.equal(res.status, 200);
      secrets.push('001234');
      const { rows } = await db.query('SELECT pin, pin_hash FROM public.users WHERE id=2');
      assert.equal(rows[0].pin, null);
      assert.ok(await bcrypt.compare('001234', rows[0].pin_hash));
      secrets.push(rows[0].pin_hash);
      assert.equal((await request('/createPin', { method: 'POST', token: member, body: { pin: '999999' } })).status, 409);
      assert.equal((await db.query('SELECT pin FROM public.users WHERE id=3')).rows[0].pin, '654321');
      assert.equal((await request('/checkPin', { method: 'POST', token: member, body: { pin: '001234' } })).status, 200);
      assert.equal((await request('/changePin', { method: 'PATCH', token: member, body: { pin: '001234', newpin: 'abc123' } })).status, 400);
      assert.equal((await request('/changePin', { method: 'PATCH', token: member, body: { pin: '001234', newpin: '123' } })).status, 400);
      assert.equal((await request('/changePin', { method: 'PATCH', token: member, body: { pin: '001234', newpin: '123456\n' } })).status, 400);
      assert.equal((await request('/changePin', { method: 'PATCH', token: member, body: { pin: '001234', newpin: '009876' } })).status, 200);
      secrets.push('009876');
      assert.ok(await bcrypt.compare('009876', (await db.query('SELECT pin_hash FROM public.users WHERE id=2')).rows[0].pin_hash));
    });

    await t.test('legacy PIN verification migrates to bcrypt and clears plaintext', async () => {
      assert.equal((await request('/checkPin', { method: 'POST', token: other, body: { pin: '654321' } })).status, 200);
      const { rows } = await db.query('SELECT pin, pin_hash FROM public.users WHERE id=3');
      assert.equal(rows[0].pin, null);
      assert.ok(await bcrypt.compare('654321', rows[0].pin_hash));
    });

    await t.test('simultaneous failed guesses share a persistent lock across PIN endpoints', async () => {
      const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => request(i % 3 === 0 ? '/checkPin' : i % 3 === 1 ? '/changePin' : '/transfer', { method: i % 3 === 1 ? 'PATCH' : 'POST', token: member, body: { pin: '999999', newpin: '111111' } })));
      assert.equal(attempts.filter((res) => res.status === 400).length, 4, JSON.stringify(attempts.map(({ status, body }) => ({ status, body }))));
      assert.equal(attempts.filter((res) => res.status === 429).length, 8);
      const locked = (await db.query('SELECT pin_failed_attempts, pin_locked_until FROM public.users WHERE id=2')).rows[0];
      assert.equal(locked.pin_failed_attempts, 5);
      assert.ok(locked.pin_locked_until > new Date());
      const retry = await request('/checkPin', { method: 'POST', token: member, body: { pin: '009876' } });
      assert.equal(retry.status, 429);
      assert.ok(Number(retry.headers.get('retry-after')) > 0);
      const freshToken = await login('member@example.invalid');
      assert.equal((await request('/auth/checkPin', { method: 'POST', token: freshToken, body: { pin: '009876' } })).status, 429);
      // Expiry opens a fresh budget; successful verification clears it.
      await db.query("UPDATE public.users SET pin_locked_until=now() - interval '1 second' WHERE id=2");
      assert.equal((await request('/checkPin', { method: 'POST', token: member, body: { pin: '999999' } })).status, 400);
      assert.equal((await db.query('SELECT pin_failed_attempts FROM public.users WHERE id=2')).rows[0].pin_failed_attempts, 1);
      assert.equal((await request('/checkPin', { method: 'POST', token: member, body: { pin: '009876' } })).status, 200);
      const reset = (await db.query('SELECT pin_failed_attempts, pin_locked_until FROM public.users WHERE id=2')).rows[0];
      assert.deepEqual(reset, { pin_failed_attempts: 0, pin_locked_until: null });
    });

    await t.test('password reset requires ownership and current password and revokes old sessions', async () => {
      assert.equal((await request('/resetPassword/3', { method: 'PATCH', token: member, body: { password, newpassword: 'stolen-password' } })).status, 403);
      assert.equal((await request('/resetPassword/2', { method: 'PATCH', token: member, body: { newpassword: 'changed-password' } })).status, 400);
      assert.equal((await request('/resetPassword/2', { method: 'PATCH', token: member, body: { password: 'incorrect', newpassword: 'changed-password' } })).status, 401);
      assert.equal((await request('/auth/resetPassword/2', { method: 'PATCH', token: member, body: { password, newpassword: 'changed-password' } })).status, 200);
      assert.equal((await request('/profile', { token: member })).status, 401);
      assert.equal((await request('/login', { method: 'POST', body: { email: 'member@example.invalid', password } })).status, 401);
      member = await login('member@example.invalid', 'changed-password');
      assert.equal((await request('/changePassword', { method: 'PATCH', token: member, body: { password: 'changed-password', newpassword: password } })).status, 200);
      assert.equal((await request('/profile', { token: member })).status, 401);
      member = await login('member@example.invalid');
    });

    await t.test('registration, admin user reads and validation errors never return credentials', async () => {
      assert.equal((await request('/register', { method: 'POST', body: { email: 'new@example.invalid', username: 'new-user', password, pin: '777777', role: 'admin' } })).status, 201);
      const newUser = (await db.query("SELECT pin, pin_hash, password FROM public.users WHERE email='new@example.invalid'")).rows[0];
      assert.equal(newUser.pin, null);
      assert.equal(newUser.pin_hash, null);
      assert.ok(await bcrypt.compare(password, newUser.password));
      assert.equal((await request('/admin/user', { token: admin })).status, 200);
      assert.equal((await request('/admin/user/1', { token: admin })).status, 200);
      assert.equal((await request('/register', { method: 'POST', body: { email: 'bad', username: 'bad', password: 'tiny' } })).status, 400);
      assert.equal((await request('/admin/user/3', { method: 'PATCH', token: admin, body: { username: 'updated-other' } })).status, 200);
      assert.equal((await request('/admin/user/3', { method: 'PATCH', token: admin, body: { pin: '777777' } })).status, 400);
      const checkEmail = await request('/checkEmail', { method: 'POST', body: { email: 'member@example.invalid' } });
      const noEmail = await request('/checkEmail', { method: 'POST', body: { email: 'missing@example.invalid' } });
      assert.deepEqual(checkEmail.body, noEmail.body);
    });

    await t.test('legacy financial endpoints cannot credit arbitrary balances or write transactions', async () => {
      assert.equal((await request('/topup', { method: 'POST', token: member, body: { recipient_id: 3, amount: 10000 } })).status, 503);
      assert.equal((await request('/transfer', { method: 'POST', token: member, body: { pin: '009876', recipient_id: 3, amount: 10000 } })).status, 503);
      assert.equal((await db.query('SELECT count(*)::integer AS count FROM public.transaction')).rows[0].count, 0);
      const res = await request('/profile', { token: member });
      assert.equal(res.body.result.user_id, 2);
    });

    await t.test('offline PIN migration clears all legacy PINs and is repeatable', async () => {
      const migrate = require('../scripts/migrate-pin-hashes');
      assert.equal(await migrate(), 1);
      assert.equal(await migrate(), 0);
      const { rows } = await db.query('SELECT pin, pin_hash FROM public.users WHERE id=1');
      assert.equal(rows[0].pin, null);
      assert.ok(await bcrypt.compare('012345', rows[0].pin_hash));
    });

    await t.test('transaction history can only read transactions belonging to the caller', async () => {
      await db.query(`INSERT INTO public.transaction(amount, sender_id, recipient_id, "time", type_id) VALUES
        (10, 2, 3, now(), 1), (20, 3, 1, now(), 1)`);
      const memberHistory = await request('/historyTransaction?user_id=3&sender_id=3', { token: member });
      assert.equal(memberHistory.status, 200);
      assert.equal(memberHistory.body.result.length, 1);
      assert.equal(memberHistory.body.result[0].amount, '10');
      const otherHistory = await request('/auth/historyTransaction?user_id=2', { token: other });
      assert.equal(otherHistory.status, 200);
      assert.equal(otherHistory.body.result.length, 1);
      assert.equal(otherHistory.body.result[0].amount, '20');
    });

    await t.test('credentials never appear in application logs', () => {
      for (const secret of secrets) assert.equal(applicationLogs.join('\n').includes(secret), false);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], true);
    // root is created by mkdtemp above and always inside the OS temp directory.
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});
