const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const db = require('../helpers/db');
const { httpError } = require('../helpers/security');
const config = require('../helpers/xenditConfig');
const xendit = require('./xendit');

const MAX_BALANCE = 9223372036854775807n;
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED']);
const states = new Set(['PENDING', 'REQUIRES_ACTION', 'ACCEPTING_PAYMENTS', 'AUTHORIZED', ...terminal]);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const money = (value) => Number.isSafeInteger(value) && value > 0;

function receipt(row) {
  const { id, reference_id, payment_request_id, transaction_id, amount, currency, country,
    channel_code, status, actions, failure_code, expires_at, paid_at, created_at, updated_at } = row;
  return { id, reference_id, payment_request_id, transaction_id, amount, currency, country, channel_code,
    status, actions: terminal.has(status) ? [] : actions, failure_code, expires_at, paid_at, created_at, updated_at };
}

async function transaction(work) {
  const client = await db.connect();
  let active = false;
  let rollbackError;
  try {
    await client.query('BEGIN'); active = true;
    const result = await work(client);
    await client.query('COMMIT'); active = false;
    return result;
  } catch (err) {
    if (active) { try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; } }
    throw err;
  } finally { client.release(rollbackError); }
}

async function findOwned(userId, id) {
  if (!uuid(id)) throw httpError(400, 'Invalid top up ID');
  const { rows } = await db.query('SELECT * FROM public.payment_requests WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!rows[0]) throw httpError(404, 'Top up not found');
  return rows[0];
}

function normalize(userId, body, headerKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid top up request');
  if (Object.keys(body).some((key) => !['amount', 'channel_code', 'currency', 'idempotency_key'].includes(key))) throw httpError(400, 'Unsupported top up field');
  if (body.currency !== undefined && body.currency !== 'IDR') throw httpError(400, 'Only IDR top ups are supported');
  if (typeof body.channel_code !== 'string' || !/^[A-Z_]{1,50}$/.test(body.channel_code)) throw httpError(400, 'Invalid channel_code');
  const raw = body.amount;
  if ((typeof raw !== 'string' && !Number.isSafeInteger(raw)) || !/^[0-9]{1,16}$/.test(String(raw)) || !money(Number(raw))) throw httpError(400, 'Amount must be positive whole rupiah within the safe integer range');
  if (headerKey !== undefined && body.idempotency_key !== undefined && headerKey !== body.idempotency_key) throw httpError(400, 'Idempotency keys do not match');
  const key = headerKey ?? body.idempotency_key;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw httpError(400, 'Supply an Idempotency-Key of 1 to 128 visible ASCII characters');
  const payload = { type: 'TOPUP', user_id: userId, amount: String(Number(raw)), currency: 'IDR', channel_code: body.channel_code };
  return { ...payload, key, fingerprint: hash(payload) };
}

function verifyIdentity(row, data, businessId) {
  if (!data || data.business_id !== businessId || data.reference_id !== row.reference_id || data.type !== 'PAY' ||
      data.capture_method !== 'AUTOMATIC' || data.country !== row.country || data.currency !== row.currency ||
      data.channel_code !== row.channel_code || !money(data.request_amount) || String(data.request_amount) !== row.amount ||
      !identifier(data.payment_request_id) || (row.payment_request_id && row.payment_request_id !== data.payment_request_id)) {
    throw httpError(409, 'Payment identity or amount mismatch');
  }
}

function safeActions(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw httpError(502, 'Invalid Xendit payment actions');
  return value.map((action) => {
    if (!action || !['REDIRECT_CUSTOMER', 'PRESENT_TO_CUSTOMER', 'API_POST_REQUEST'].includes(action.type) ||
        typeof action.descriptor !== 'string' || !/^[A-Z_]{1,100}$/.test(action.descriptor) ||
        typeof action.value !== 'string' || !action.value || action.value.length > 16384) throw httpError(502, 'Invalid Xendit payment actions');
    if (action.descriptor.endsWith('_URL')) {
      let url;
      try { url = new URL(action.value); } catch { throw httpError(502, 'Invalid Xendit action URL'); }
      if (url.username || url.password || ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'].includes(url.protocol) ||
          (action.descriptor === 'WEB_URL' && url.protocol !== 'https:')) throw httpError(502, 'Invalid Xendit action URL');
    }
    return { type: action.type, descriptor: action.descriptor, value: action.value };
  });
}

async function applySnapshot(id, data) {
  const { businessId } = config.credentials();
  return transaction(async (client) => {
    const row = (await client.query('SELECT * FROM public.payment_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw httpError(404, 'Top up not found');
    verifyIdentity(row, data, businessId);
    if (!states.has(data.status)) throw httpError(502, 'Invalid Xendit payment status');
    // A Payment Request status alone is not capture evidence. Only the payment processor credits funds.
    let status = data.status === 'SUCCEEDED' ? 'PENDING' : data.status;
    if (terminal.has(row.status) || (row.status === 'AUTHORIZED' && !terminal.has(status))) status = row.status;
    const actions = terminal.has(status) ? [] : safeActions(data.actions);
    const expiry = data.channel_properties?.expires_at;
    if (expiry != null && (typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry)))) throw httpError(502, 'Invalid Xendit expiry');
    const failure = status === 'FAILED' ? xendit.failureCode(data.failure_code, row.failure_code ?? 'PAYMENT_FAILED') : null;
    return (await client.query(`UPDATE public.payment_requests SET payment_request_id=$2, status=$3, actions=$4::jsonb,
      expires_at=coalesce($5::timestamptz, expires_at), failure_code=$6 WHERE id=$1 RETURNING *`,
    [id, data.payment_request_id, status, JSON.stringify(actions), expiry ?? null, failure])).rows[0];
  });
}

async function create(userId, body, headerKey) {
  config.credentials(); // Disabled/missing configuration remains fail-closed with HTTP 503.
  const input = normalize(userId, body, headerKey);
  const existing = (await db.query('SELECT * FROM public.payment_requests WHERE user_id=$1 AND idempotency_key=$2', [userId, input.key])).rows[0];
  const replay = (row) => {
    if (row.request_fingerprint !== input.fingerprint) throw httpError(409, 'Idempotency key was already used for a different request');
    return { payment: receipt(row), replayed: true };
  };
  if (existing) return replay(existing);
  const settings = config.checkout();
  const method = settings.methods.find((item) => item.channel_code === input.channel_code);
  if (!method) throw httpError(400, 'Payment channel is not enabled');
  if (BigInt(input.amount) < BigInt(method.min_amount) || BigInt(input.amount) > BigInt(method.max_amount)) throw httpError(400, 'Amount is outside this payment channel limit');
  const id = randomUUID();
  // This committed reservation is also the one-shot create claim. A retry NEVER repeats the provider POST.
  const reserved = await db.query(`INSERT INTO public.payment_requests
    (id, user_id, reference_id, amount, channel_code, idempotency_key, request_fingerprint)
    SELECT $1, $2, $3, $4::bigint, $5, $6, $7 WHERE EXISTS
      (SELECT 1 FROM public.wallets WHERE user_id=$2 AND currency='IDR')
    ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
  [id, userId, `topup-${id}`, input.amount, input.channel_code, input.key, input.fingerprint]);
  if (!reserved.rows[0]) {
    const concurrent = (await db.query('SELECT * FROM public.payment_requests WHERE user_id=$1 AND idempotency_key=$2', [userId, input.key])).rows[0];
    if (concurrent) return replay(concurrent);
    throw httpError(409, 'IDR wallet is unavailable');
  }
  const row = reserved.rows[0];
  let updated;
  try {
    const result = await xendit.request('POST', '/payment_requests', { reference_id: row.reference_id, type: 'PAY', country: 'ID', currency: 'IDR',
      request_amount: Number(row.amount), capture_method: 'AUTOMATIC', channel_code: row.channel_code,
      channel_properties: config.properties(method, settings, id), description: 'Wallet top up' });
    updated = await applySnapshot(id, result);
  } catch (err) {
    // Even a lost DB acknowledgement after a successful provider response must not cause another POST.
    updated = (await db.query(`UPDATE public.payment_requests SET status=$2, failure_code=$3
      WHERE id=$1 AND status='CREATED' RETURNING *`,
    [id, err instanceof xendit.XenditError && err.definitive ? 'FAILED' : 'UNKNOWN',
      err instanceof xendit.XenditError ? err.code : 'XENDIT_OUTCOME_UNKNOWN'])).rows[0];
    if (!updated) updated = (await db.query('SELECT * FROM public.payment_requests WHERE id=$1', [id])).rows[0];
  }
  return { payment: receipt(updated), replayed: false };
}

function eventFacts(payload) {
  const data = payload?.data;
  return { event: payload?.event, business_id: payload?.business_id,
    data: data && { business_id: data.business_id, reference_id: data.reference_id, payment_request_id: data.payment_request_id,
      payment_id: data.payment_id, type: data.type, capture_method: data.capture_method, country: data.country,
      currency: data.currency, channel_code: data.channel_code, request_amount: data.request_amount, status: data.status,
      captures: payload.event === 'payment.capture' ? data.captures?.map((capture) => ({ capture_id: capture.capture_id,
        capture_amount: capture.capture_amount, capture_timestamp: new Date(capture.capture_timestamp).toISOString() })) : undefined } };
}

function validateEvent(payload) {
  const { businessId } = config.credentials();
  const data = payload?.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !data || typeof data !== 'object' || Array.isArray(data) ||
      !identifier(data.payment_request_id) || !identifier(data.payment_id) || !identifier(data.reference_id)) throw httpError(400, 'Invalid payment webhook');
  if (payload.business_id !== businessId || data.business_id !== businessId) throw httpError(403, 'Unexpected Xendit business');
  const status = { 'payment.capture': 'SUCCEEDED', 'payment.failure': 'FAILED', 'payment.authorization': 'AUTHORIZED' }[payload.event];
  if (!status || data.status !== status || !money(data.request_amount)) throw httpError(400, 'Invalid payment webhook state');
  if (payload.event === 'payment.capture') {
    if (!Array.isArray(data.captures) || data.captures.length !== 1 || !identifier(data.captures[0]?.capture_id) ||
        !money(data.captures[0].capture_amount) || data.captures[0].capture_amount !== data.request_amount ||
        typeof data.captures[0].capture_timestamp !== 'string' || !Number.isFinite(Date.parse(data.captures[0].capture_timestamp))) throw httpError(400, 'Invalid full payment capture');
  }
  return data;
}

async function processEvent(id) {
  try {
    return await transaction(async (client) => {
      const event = (await client.query('SELECT * FROM public.payment_webhook_events WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!event) throw httpError(404, 'Payment event not found');
      if (['PROCESSED', 'IGNORED'].includes(event.processing_status)) return true;
      const data = validateEvent(event.payload);
      const row = (await client.query('SELECT * FROM public.payment_requests WHERE reference_id=$1 FOR UPDATE', [data.reference_id])).rows[0];
      if (!row) throw httpError(404, 'Payment reference not found');
      verifyIdentity(row, data, config.credentials().businessId);
      if (event.event_type === 'payment.capture') {
        const capture = data.captures[0];
        if (row.status === 'SUCCEEDED') {
          if (row.payment_id !== data.payment_id || row.capture_id !== capture.capture_id) throw httpError(409, 'Payment already credited by a different capture');
        } else {
          if (row.transaction_id) throw httpError(409, 'Payment transaction needs review');
          const wallet = (await client.query("SELECT id, balance FROM public.wallets WHERE user_id=$1 AND currency='IDR' FOR UPDATE", [row.user_id])).rows[0];
          if (!wallet || BigInt(wallet.balance) + BigInt(row.amount) > MAX_BALANCE) throw httpError(409, 'Wallet unavailable or balance limit exceeded');
          const credit = await client.query(`INSERT INTO public.transaction
            (reference_id, amount, recipient_id, sender_id, "time", type_id, status, currency, notes, idempotency_key, request_fingerprint)
            SELECT $1::uuid, $2::bigint, $3, NULL, now() AT TIME ZONE 'UTC', id, 'SUCCEEDED', 'IDR', 'Top up via Xendit', $1::text, $4
            FROM public.transaction_type WHERE code='TOPUP' RETURNING id`, [row.id, row.amount, row.user_id, row.request_fingerprint]);
          if (credit.rowCount !== 1) throw new Error('Canonical TOPUP type is unavailable');
          await client.query("INSERT INTO public.wallet_entries(wallet_id, transaction_id, direction, amount) VALUES ($1, $2, 'CREDIT', $3::bigint)", [wallet.id, credit.rows[0].id, row.amount]);
          await client.query('UPDATE public.wallets SET balance=balance+$2::bigint WHERE id=$1', [wallet.id, row.amount]);
          await client.query(`UPDATE public.payment_requests SET payment_request_id=$2, payment_id=$3, capture_id=$4, paid_at=$5::timestamptz,
            transaction_id=$6, status='SUCCEEDED', actions='[]'::jsonb, failure_code=NULL WHERE id=$1`,
          [row.id, data.payment_request_id, data.payment_id, capture.capture_id, capture.capture_timestamp, credit.rows[0].id]);
        }
      } else if (!terminal.has(row.status)) {
        await client.query(`UPDATE public.payment_requests SET payment_request_id=$2, status=$3, failure_code=$4 WHERE id=$1`,
          [row.id, data.payment_request_id, data.status, data.status === 'FAILED' ? xendit.failureCode(data.failure_code, 'PAYMENT_FAILED') : null]);
      }
      await client.query(`UPDATE public.payment_webhook_events SET processing_status='PROCESSED', processed_at=now(),
        attempt_count=attempt_count+1, last_error=NULL WHERE id=$1`, [id]);
      return true;
    });
  } catch (err) {
    // The inbox insert committed before processing. Failed financial writes roll back together and are replayable.
    await db.query(`UPDATE public.payment_webhook_events SET processing_status='FAILED', attempt_count=attempt_count+1,
      last_error=$2 WHERE id=$1 AND processing_status NOT IN ('PROCESSED', 'IGNORED')`,
    [id, err.expose ? err.message : 'Payment processing failed']);
    return false;
  }
}

async function recordEvent(payload) {
  const data = validateEvent(payload);
  const captureId = payload.event === 'payment.capture' ? data.captures[0].capture_id : null;
  const key = hash([payload.event, data.payment_id, captureId]);
  const result = await db.query(`INSERT INTO public.payment_webhook_events
    (dedup_key, event_type, payment_request_id, payment_id, capture_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (dedup_key) DO NOTHING RETURNING *`, [key, payload.event, data.payment_request_id, data.payment_id, captureId, JSON.stringify(payload)]);
  const event = result.rows[0] ?? (await db.query('SELECT * FROM public.payment_webhook_events WHERE dedup_key=$1', [key])).rows[0];
  if (hash(eventFacts(event.payload)) !== hash(eventFacts(payload))) throw httpError(409, 'Conflicting duplicate payment event');
  return processEvent(event.id);
}

async function webhook(token, payload) {
  const expected = config.credentials().webhookToken;
  if (typeof token !== 'string' || !timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(expected).digest())) throw httpError(401, 'Invalid Xendit callback token');
  if (!['payment.capture', 'payment.authorization', 'payment.failure'].includes(payload?.event)) return { received: true, ignored: true };
  if (!await recordEvent(payload)) throw httpError(503, 'Payment event stored; processing will be retried');
  return { received: true };
}

async function reconcile(id, providerId) {
  config.credentials();
  if (!uuid(id)) throw httpError(400, 'Invalid top up ID');
  let row = (await db.query('SELECT * FROM public.payment_requests WHERE id=$1', [id])).rows[0];
  if (!row) throw httpError(404, 'Top up not found');
  if (row.status === 'SUCCEEDED') return receipt(row);
  const requestId = providerId ?? row.payment_request_id;
  if (!requestId) {
    row = (await db.query(`UPDATE public.payment_requests SET status='UNKNOWN' WHERE id=$1 AND status='CREATED'
      AND created_at < now()-interval '5 minutes' RETURNING *`, [id])).rows[0] ?? row;
    return receipt(row);
  }
  if (!identifier(requestId)) throw httpError(400, 'Invalid Xendit Payment Request ID');
  const snapshot = await xendit.request('GET', `/payment_requests/${requestId}`);
  if (snapshot.payment_request_id !== requestId) throw httpError(502, 'Unexpected Xendit Payment Request ID');
  row = await applySnapshot(id, snapshot);
  if (snapshot.latest_payment_id != null) {
    if (!identifier(snapshot.latest_payment_id)) throw httpError(502, 'Invalid Xendit payment ID');
    const payment = await xendit.request('GET', `/payments/${snapshot.latest_payment_id}`);
    if (payment.payment_id !== snapshot.latest_payment_id || payment.payment_request_id !== requestId) throw httpError(502, 'Unexpected Xendit payment ID');
    verifyIdentity(row, payment, config.credentials().businessId);
    const event = { SUCCEEDED: 'payment.capture', FAILED: 'payment.failure', AUTHORIZED: 'payment.authorization' }[payment.status];
    if (event && !await recordEvent({ event, business_id: payment.business_id, data: payment })) throw httpError(503, 'Payment event stored; processing will be retried');
    if (['CANCELED', 'EXPIRED'].includes(payment.status)) await applySnapshot(id, { ...payment, actions: [] });
  }
  return receipt((await db.query('SELECT * FROM public.payment_requests WHERE id=$1', [id])).rows[0]);
}

async function refresh(userId, id) {
  await findOwned(userId, id); // Check ownership before contacting Xendit.
  return reconcile(id);
}

async function retryEvents(limit = 20) {
  const { rows } = await db.query(`SELECT id FROM public.payment_webhook_events WHERE processing_status IN ('RECEIVED', 'FAILED')
    ORDER BY attempt_count, received_at, id LIMIT $1`, [limit]);
  let processed = 0;
  for (const event of rows) if (await processEvent(event.id)) processed++;
  return { selected: rows.length, processed, failed: rows.length - processed };
}

module.exports = { create, get: async (userId, id) => receipt(await findOwned(userId, id)),
  methods: () => config.checkout().methods, webhook, refresh, reconcile, retryEvents };
