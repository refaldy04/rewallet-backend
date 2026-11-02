const bcrypt = require('bcrypt');
const { timingSafeEqual } = require('node:crypto');
const db = require('./db');
const { httpError } = require('./security');

const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;
const validPin = (pin) => typeof pin === 'string' && pin.length === 6 && /^\d{6}$/.test(pin);

// All PIN endpoints share durable counters and serialize on the same user row.
async function operate(id, pin, { create = false, newPin } = {}) {
  if (!validPin(pin) || (newPin !== undefined && !validPin(newPin))) throw httpError(400, 'PIN must contain exactly six digits');
  const client = await db.connect();
  let failure;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, pin, pin_hash, pin_failed_attempts, pin_locked_until, clock_timestamp() AS now FROM public.users WHERE id=$1 FOR UPDATE', [id]);
    const user = rows[0];
    if (!user) throw httpError(401, 'Authentication required');
    if (create) {
      if (user.pin_hash || user.pin !== null) throw httpError(409, 'PIN already set');
    } else {
      if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date(user.now)) {
        throw Object.assign(httpError(429, 'Too many PIN attempts. Try again later'), { retryAfter: Math.max(1, Math.ceil((new Date(user.pin_locked_until) - new Date(user.now)) / 1000)) });
      }
      if (!user.pin_hash && user.pin === null) throw httpError(409, 'Set a PIN first');
      const matches = user.pin_hash
        ? await bcrypt.compare(pin, user.pin_hash)
        : validPin(user.pin) && timingSafeEqual(Buffer.from(pin), Buffer.from(user.pin));
      if (!matches) {
        const attempts = (user.pin_locked_until ? 0 : user.pin_failed_attempts) + 1;
        await client.query("UPDATE public.users SET pin_failed_attempts=$2::integer, pin_locked_until=CASE WHEN $2::integer >= $3::integer THEN clock_timestamp() + interval '15 minutes' ELSE NULL END WHERE id=$1", [id, attempts, MAX_ATTEMPTS]);
        failure = httpError(attempts >= MAX_ATTEMPTS ? 429 : 400, attempts >= MAX_ATTEMPTS ? 'Too many PIN attempts. Try again later' : 'Invalid PIN');
        if (attempts >= MAX_ATTEMPTS) failure.retryAfter = LOCK_SECONDS;
      }
    }
    if (!failure) {
      // A successful legacy verification upgrades the PIN and erases plaintext.
      const hash = create || newPin !== undefined || !user.pin_hash ? await bcrypt.hash(newPin ?? pin, 12) : user.pin_hash;
      await client.query('UPDATE public.users SET pin_hash=$2, pin=NULL, pin_failed_attempts=0, pin_locked_until=NULL WHERE id=$1', [id, hash]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Failed attempts must commit before returning an error.
  if (failure) throw failure;
}

exports.create = (id, pin) => operate(id, pin, { create: true });
exports.verify = (id, pin) => operate(id, pin);
exports.change = (id, pin, newPin) => {
  if (!validPin(newPin)) throw httpError(400, 'New PIN must contain exactly six digits');
  return operate(id, pin, { newPin });
};
