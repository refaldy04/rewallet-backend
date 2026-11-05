const { createHash } = require('node:crypto');
const db = require('../helpers/db');
const pin = require('../helpers/pin');
const { httpError } = require('../helpers/security');

const MAX_BALANCE = 9223372036854775807n;
const columns = 'id, reference_id, sender_id, recipient_id, amount, currency, status, notes, "time", created_at, type_id';

function normalize(senderId, data, headerKey) {
  const rawRecipient = data.recipient_id;
  if (!['string', 'number'].includes(typeof rawRecipient) || !/^[0-9]{1,10}$/.test(String(rawRecipient))) throw httpError(400, 'Invalid recipient_id');

  const recipientId = Number(rawRecipient);
  if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId > 2147483647) throw httpError(400, 'Invalid recipient_id');

  if (recipientId === senderId) throw httpError(400, 'Cannot transfer to yourself');

  const rawAmount = data.amount;
  if ((typeof rawAmount !== 'string' && !Number.isSafeInteger(rawAmount)) || !/^[0-9]{1,19}$/.test(String(rawAmount))) throw httpError(400, 'Amount must be whole rupiah; use a decimal string for large amounts');

  const amount = BigInt(rawAmount);
  if (amount <= 0n || amount > MAX_BALANCE) throw httpError(400, 'Amount is outside the supported range');

  if (data.currency !== undefined && data.currency !== 'IDR') throw httpError(400, 'Only IDR transfers are supported');

  if (data.notes !== undefined && data.notes !== null && typeof data.notes !== 'string') throw httpError(400, 'Invalid notes');

  if (headerKey !== undefined && data.idempotency_key !== undefined && headerKey !== data.idempotency_key) throw httpError(400, 'Idempotency keys do not match');

  const key = headerKey ?? data.idempotency_key;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) throw httpError(400, 'Supply an Idempotency-Key of 1 to 128 visible ASCII characters');

  const payload = { type: 'TRANSFER', sender_id: senderId, recipient_id: recipientId, amount: amount.toString(), currency: 'IDR', notes: data.notes ?? null };

  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return { ...payload, key, fingerprint };
}

module.exports = async (senderId, data, headerKey) => {
  const request = normalize(senderId, data, headerKey);
  const client = await db.connect();
  let active = false;
  let rollbackError;
  
  try {
    await client.query('BEGIN');
    active = true;
    const pinFailure = await pin.verifyInTransaction(client, senderId, data.pin);
    if (pinFailure) {
      // No financial writes have occurred. Persist the shared PIN attempt budget.
      await client.query('COMMIT');
      active = false;
      throw pinFailure;
    }

    // The sender's PIN row lock also serializes requests from that sender. Check
    // retries before checking current funds, which may already have been spent.
    const existing = await client.query(`SELECT ${columns}, request_fingerprint,
      (SELECT code FROM public.transaction_type WHERE id = type_id) AS type_code
      FROM public.transaction WHERE sender_id=$1 AND idempotency_key=$2`, [senderId, request.key]);
    if (existing.rows[0]) {
      const { request_fingerprint: fingerprint, ...transaction } = existing.rows[0];
      if (fingerprint !== request.fingerprint || transaction.type_code !== 'TRANSFER') throw httpError(409, 'Idempotency key was already used for a different request');
      if (transaction.status !== 'SUCCEEDED') throw httpError(409, 'Transfer is not in a succeeded state');
      await client.query('COMMIT');
      active = false;
      return transaction;
    }

    // Every transfer locks both wallets in the same order to avoid deadlocks.
    const { rows: wallets } = await client.query(`SELECT id, user_id, balance FROM public.wallets
      WHERE user_id = ANY($1::integer[]) AND currency='IDR' ORDER BY user_id FOR UPDATE`, [[senderId, request.recipient_id]]);
    const sender = wallets.find((wallet) => wallet.user_id === senderId);
    const recipient = wallets.find((wallet) => wallet.user_id === request.recipient_id);
    if (!sender) throw httpError(409, 'Sender wallet is unavailable');
    if (!recipient) throw httpError(404, 'Recipient wallet not found');
    const amount = BigInt(request.amount);
    if (BigInt(sender.balance) < amount) throw httpError(409, 'Insufficient balance');
    if (BigInt(recipient.balance) + amount > MAX_BALANCE) throw httpError(409, 'Recipient balance limit exceeded');

    const result = await client.query(`INSERT INTO public.transaction
      (sender_id, recipient_id, amount, currency, notes, "time", type_id, status, idempotency_key, request_fingerprint)
      SELECT $1, $2, $3::bigint, 'IDR', $4, now() AT TIME ZONE 'UTC', id, 'SUCCEEDED', $5, $6
      FROM public.transaction_type WHERE code='TRANSFER' RETURNING ${columns}`,
    [senderId, request.recipient_id, request.amount, request.notes, request.key, request.fingerprint]);
    if (result.rowCount !== 1) throw new Error('Canonical TRANSFER type is unavailable');
    const transaction = { ...result.rows[0], type_code: 'TRANSFER' };

    const debit = await client.query('UPDATE public.wallets SET balance=balance-$2::bigint WHERE id=$1 AND balance >= $2::bigint', [sender.id, request.amount]);
    if (debit.rowCount !== 1) throw httpError(409, 'Insufficient balance');
    const credit = await client.query('UPDATE public.wallets SET balance=balance+$2::bigint WHERE id=$1', [recipient.id, request.amount]);
    if (credit.rowCount !== 1) throw new Error('Recipient wallet update failed');
    const entries = await client.query(`INSERT INTO public.wallet_entries (wallet_id, transaction_id, direction, amount)
      VALUES ($1, $3, 'DEBIT', $4::bigint), ($2, $3, 'CREDIT', $4::bigint)`, [sender.id, recipient.id, transaction.id, request.amount]);
    if (entries.rowCount !== 2) throw new Error('Transfer ledger is incomplete');

    await client.query('COMMIT');
    active = false;
    return transaction;
  } catch (err) {
    if (active) {
      try { await client.query('ROLLBACK'); } catch (failure) { rollbackError = failure; }
    }
    throw err;
  } finally {
    client.release(rollbackError);
  }
};
