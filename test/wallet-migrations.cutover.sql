SELECT test_support.assert_true((SELECT count(*) = 3 FROM public.wallets), 'every user gets one wallet');
SELECT test_support.assert_true((SELECT balance = 125000 FROM public.wallets WHERE user_id = 1), 'copy current balance without replaying history');
SELECT test_support.assert_true((SELECT balance = 0 FROM public.wallets WHERE user_id = 2), 'zero balances remain zero');
SELECT test_support.assert_true((SELECT count(*) = 1 FROM public.wallet_entries), 'only positive opening balances create entries');
SELECT test_support.assert_true((SELECT count(*) = 2 FROM public.transaction WHERE status = 'LEGACY'), 'keep historical transactions');
SELECT test_support.assert_true((SELECT count(*) = 1 FROM public.transaction t JOIN public.transaction_type tt ON tt.id = t.type_id WHERE tt.code = 'OPENING_BALANCE' AND t.status = 'SUCCEEDED' AND t.sender_id IS NULL AND t.created_at IS NOT NULL), 'opening entry has explicit provenance');
SELECT test_support.assert_true(NOT EXISTS (
    SELECT 1 FROM public.wallets w LEFT JOIN public.wallet_entries e ON e.wallet_id = w.id
    GROUP BY w.id HAVING w.balance <> coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
), 'opening ledger reconciles with wallet balances');

BEGIN;
SELECT test_support.expect_error('UPDATE public.profile SET balance = 1::numeric::money WHERE user_id = 1', '23514');
SELECT test_support.expect_error('UPDATE public.profile SET user_id = 2 WHERE user_id = 1', '23514');
SELECT test_support.expect_error('DELETE FROM public.transaction WHERE id = 1', '23514');
SELECT test_support.expect_error('UPDATE public.transaction SET notes = ''edited'' WHERE id = 1', '23514');
SELECT test_support.expect_error($sql$
    INSERT INTO public.transaction(amount, sender_id, recipient_id, "time", type_id)
    VALUES (1000, 1, 2, now(), 2)
$sql$, '23514');
SELECT test_support.expect_error('UPDATE public.wallet_entries SET amount = 1', '23514');
SELECT test_support.expect_error('DELETE FROM public.wallet_entries', '23514');
SELECT test_support.expect_error('UPDATE public.wallets SET balance = -1 WHERE user_id = 1', '23514');

-- Exercise one successful atomic transfer with a shared transaction/ledger.
INSERT INTO public.transaction (amount, sender_id, recipient_id, "time", type_id, status, idempotency_key, request_fingerprint)
SELECT 2000, 1, 2, now(), id, 'SUCCEEDED', 'transfer-1', repeat('b', 64)
FROM public.transaction_type WHERE code = 'TRANSFER';
UPDATE public.wallets SET balance = balance - 2000 WHERE user_id = 1 AND balance >= 2000;
UPDATE public.wallets SET balance = balance + 2000 WHERE user_id = 2;
INSERT INTO public.wallet_entries (wallet_id, transaction_id, direction, amount)
SELECT w.id, t.id, CASE WHEN w.user_id = 1 THEN 'DEBIT' ELSE 'CREDIT' END, 2000
FROM public.wallets w CROSS JOIN public.transaction t
WHERE w.user_id IN (1, 2) AND t.idempotency_key = 'transfer-1';
SELECT test_support.expect_error($sql$
    INSERT INTO public.transaction (amount, sender_id, recipient_id, "time", type_id, status, idempotency_key, request_fingerprint)
    SELECT 2000, 1, 2, now(), id, 'SUCCEEDED', 'transfer-1', repeat('b', 64)
    FROM public.transaction_type WHERE code = 'TRANSFER'
$sql$, '23505');
SELECT test_support.expect_error($sql$
    INSERT INTO public.wallet_entries(wallet_id, transaction_id, direction, amount)
    SELECT wallet_id, transaction_id, direction, amount FROM public.wallet_entries LIMIT 1
$sql$, '23505');
SELECT test_support.assert_true(NOT EXISTS (
    SELECT 1 FROM public.wallets w LEFT JOIN public.wallet_entries e ON e.wallet_id = w.id
    GROUP BY w.id HAVING w.balance <> coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
), 'transfer preserves ledger reconciliation');
ROLLBACK;
