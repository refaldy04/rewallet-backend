require('dotenv').config();

async function main() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const args = process.argv.slice(2);
  const single = args.length === 2 || args.length === 4;
  if (args.length && (!single || args[0] !== '--topup-id' || (args.length === 4 && args[2] !== '--payment-request-id'))) {
    throw new Error('Usage: npm run payments:reconcile -- [--topup-id UUID [--payment-request-id pr-ID]]');
  }
  const db = require('../src/helpers/db');
  try {
    require('../src/helpers/xenditConfig').credentials();
    const topup = require('../src/services/topup');
    if (args.length) {
      const result = await topup.reconcile(args[1], args[3]);
      console.log(JSON.stringify({ id: result.id, status: result.status, transaction_id: result.transaction_id }));
      return;
    }
    const events = await topup.retryEvents(20);
    // Bounded, sequential work. This command never creates a payment or retries a provider POST.
    const { rows } = await db.query(`SELECT id FROM public.payment_requests WHERE status <> 'SUCCEEDED'
      AND (payment_request_id IS NOT NULL OR status='CREATED') ORDER BY updated_at, id LIMIT 20`);
    let refreshed = 0;
    let failed = 0;
    for (const row of rows) {
      try { await topup.reconcile(row.id); refreshed++; } catch { failed++; }
    }
    const unknown = (await db.query("SELECT count(*)::integer AS count FROM public.payment_requests WHERE status='UNKNOWN' AND payment_request_id IS NULL")).rows[0].count;
    console.log(JSON.stringify({ events, payments: { selected: rows.length, refreshed, failed, unknown_needing_review: unknown } }));
    if (events.failed || failed || unknown) process.exitCode = 1;
  } finally { await db.end(); }
}

main().catch(() => {
  // Do not print raw provider/database errors, payment payloads or credentials.
  console.error('Payment reconciliation failed. Check configuration, command arguments and the private payment inbox.');
  process.exitCode = 1;
});
