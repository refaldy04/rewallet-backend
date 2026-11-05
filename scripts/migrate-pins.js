const bcrypt = require('bcrypt');
const { Pool } = require('pg');

class PinMigrationError extends Error {}

const hashPattern = /^\$2[ab]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/;
const validPin = (pin) => typeof pin === 'string' && /^[0-9]{6}$/.test(pin);

// Each account commits independently so a rerun resumes after a failure.
async function migratePins(pool) {
  const client = await pool.connect();
  const counts = { hashed: 0, cleared: 0 };
  let locked = false;
  let active = false;
  let releaseError;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(48009, 2) AS locked');
    locked = lock.rows[0].locked;
    if (!locked) throw new PinMigrationError('Another PIN migration is running. Retry after it finishes.');

    // Validate without fetching credentials into the preflight result.
    const preflight = await client.query(`SELECT
      EXISTS (SELECT 1 FROM public.users WHERE pin IS NOT NULL AND pin !~ '^[0-9]{6}$') AS invalid_pin,
      EXISTS (SELECT 1 FROM public.users WHERE pin IS NOT NULL AND pin_hash IS NOT NULL AND pin_hash !~ $1) AS invalid_hash`, [hashPattern.source]);
    if (preflight.rows[0].invalid_pin) throw new PinMigrationError('Invalid legacy PIN values found. Review the affected accounts before retrying; no values are printed.');
    if (preflight.rows[0].invalid_hash) throw new PinMigrationError('Invalid existing PIN hashes found. Review the affected accounts before retrying; no values are printed.');

    while (true) {
      await client.query('BEGIN');
      active = true;
      const result = await client.query('SELECT id, pin, pin_hash FROM public.users WHERE pin IS NOT NULL ORDER BY id LIMIT 1 FOR NO KEY UPDATE');
      const user = result.rows[0];
      if (!user) {
        await client.query('COMMIT');
        active = false;
        break;
      }
      if (!validPin(user.pin) || (user.pin_hash !== null && !hashPattern.test(user.pin_hash))) {
        throw new PinMigrationError('PIN data changed during migration. Stop application traffic and review the affected accounts before retrying.');
      }
      const hash = user.pin_hash ?? await bcrypt.hash(user.pin, 12);
      // Preserve existing hash, attempt counter and lock expiry.
      await client.query('UPDATE public.users SET pin_hash=$2, pin=NULL WHERE id=$1', [user.id, hash]);
      await client.query('COMMIT');
      active = false;
      if (user.pin_hash === null) counts.hashed++;
      counts.cleared++;
    }
    return counts;
  } finally {
    if (active) {
      try { await client.query('ROLLBACK'); } catch (err) { releaseError = err; }
    }
    if (locked && !releaseError) {
      try { await client.query('SELECT pg_advisory_unlock(48009, 2)'); } catch (err) { releaseError = err; }
    }
    client.release(releaseError);
  }
}

async function main() {
  require('dotenv').config();
  if (!process.env.DATABASE_URL?.trim()) throw new PinMigrationError('DATABASE_URL must be configured before running the PIN migration.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const counts = await migratePins(pool);
    console.log(`PIN migration complete: ${counts.hashed} hashed, ${counts.cleared} plaintext values cleared.`);
  } finally {
    await pool.end();
  }
}

module.exports = { migratePins };
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof PinMigrationError ? err.message : 'PIN migration failed. Check database connectivity and the migrated users schema, then retry. No credentials are printed.');
    process.exitCode = 1;
  });
}
