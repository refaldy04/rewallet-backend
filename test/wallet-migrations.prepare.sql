SELECT test_support.assert_true((SELECT count(*) = 0 FROM public.wallets), 'preparation must not copy live balances');
SELECT test_support.assert_true((SELECT count(*) = 0 FROM public.wallet_entries), 'preparation must not create ledger entries');
SELECT test_support.assert_true((SELECT count(*) = 2 FROM public.transaction WHERE status = 'LEGACY' AND created_at IS NULL), 'do not invent historical success or timezone');
SELECT test_support.assert_true((SELECT data_type = 'bigint' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'transaction' AND column_name = 'amount'), 'transaction amounts use integer rupiah');
SELECT test_support.assert_true((SELECT amount = 100000 FROM public.transaction WHERE id = 1), 'money conversion preserves nominal value');
SELECT test_support.assert_true((SELECT code = 'LEGACY_1' FROM public.transaction_type WHERE id = 1), 'legacy type IDs must stay unchanged');
SELECT test_support.assert_true((SELECT pin = '012345' AND pin_hash IS NULL FROM public.users WHERE id = 1), 'never copy plaintext into pin_hash');
SELECT test_support.assert_true((SELECT count(*) = 3 FROM public.transaction_type WHERE code IN ('TOPUP', 'TRANSFER', 'OPENING_BALANCE')), 'canonical types exist without guessing legacy mapping');
SELECT test_support.assert_true((SELECT count(*) = 3 FROM pg_constraint WHERE contype = 'p' AND conrelid IN ('public.profile'::regclass, 'public.transaction'::regclass, 'public.transaction_type'::regclass)), 'add all missing primary keys');

-- New legacy registration receives a zero profile balance, without prematurely
-- creating a second active wallet source of truth.
INSERT INTO public.users (email, password, username) VALUES ('third@example.invalid', 'synthetic-password', 'third');
INSERT INTO public.profile (user_id) VALUES (3);
SELECT test_support.assert_true((SELECT balance::numeric = 0 FROM public.profile WHERE user_id = 3), 'profile default is zero');

BEGIN;
SELECT test_support.expect_error('INSERT INTO public.profile(user_id) VALUES (1)', '23505');
SELECT test_support.expect_error('INSERT INTO public.profile(user_id) VALUES (9999)', '23503');
SELECT test_support.expect_error('UPDATE public.profile SET balance = (-1)::numeric::money WHERE user_id = 1', '23514');
SELECT test_support.expect_error('UPDATE public.profile SET balance = 1.25::numeric::money WHERE user_id = 1', '23514');
SELECT test_support.expect_error('UPDATE public.profile SET balance = NULL WHERE user_id = 1', '23502');
SELECT test_support.expect_error('DELETE FROM public.users WHERE id = 1', '23001,23503');
SELECT test_support.expect_error('UPDATE public.transaction SET amount = 0 WHERE id = 1', '23514');
SELECT test_support.expect_error('UPDATE public.transaction SET recipient_id = 9999 WHERE id = 1', '23503');

SELECT test_support.expect_error($sql$
    INSERT INTO public.transaction(amount, sender_id, recipient_id, "time", type_id, status, idempotency_key, request_fingerprint)
    SELECT 1000, 1, 1, now(), id, 'SUCCEEDED', 'self-transfer', repeat('a', 64)
    FROM public.transaction_type WHERE code = 'TRANSFER'
$sql$, '23514');
SELECT test_support.expect_error($sql$
    INSERT INTO public.transaction(amount, sender_id, recipient_id, "time", type_id, status)
    SELECT 1000, NULL, 2, now(), id, 'SUCCEEDED'
    FROM public.transaction_type WHERE code = 'TRANSFER'
$sql$, '23514');
SELECT test_support.expect_error($sql$
    INSERT INTO public.transaction(amount, sender_id, recipient_id, "time", type_id, status)
    SELECT 1000, 1, 1, now(), id, 'SUCCEEDED'
    FROM public.transaction_type WHERE code = 'TOPUP'
$sql$, '23514');

INSERT INTO public.payment_requests (user_id, reference_id, amount, channel_code, idempotency_key, request_fingerprint)
VALUES (1, 'test-topup-1', 1000, 'QRIS', 'topup-retry', repeat('a', 64));
SELECT test_support.expect_error($sql$
    INSERT INTO public.payment_requests (user_id, reference_id, amount, channel_code, idempotency_key, request_fingerprint)
    VALUES (1, 'test-topup-2', 1000, 'QRIS', 'topup-retry', repeat('a', 64))
$sql$, '23505');
SELECT test_support.expect_error('UPDATE public.payment_requests SET status = ''SUCCEEDED''', '23514');

-- A valid webhook may arrive before the payment request response is saved.
INSERT INTO public.payment_webhook_events (dedup_key, event_type, payment_request_id, payment_id, capture_id, payload)
VALUES ('capture:py-test:cap-test', 'payment.capture', 'pr-not-yet-saved', 'py-test', 'cap-test', '{}'::jsonb);
SELECT test_support.expect_error($sql$
    INSERT INTO public.payment_webhook_events(dedup_key, event_type, payment_request_id, payload)
    VALUES ('capture:py-test:cap-test', 'payment.capture', 'pr-not-yet-saved', '{}'::jsonb)
$sql$, '23505');
SELECT test_support.expect_error('UPDATE public.payment_webhook_events SET processing_status = ''PROCESSED''', '23514');
ROLLBACK;

DO $test$
DECLARE
    table_name text;
    api_role text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['app_schema_migrations', 'wallets', 'wallet_entries', 'payment_requests', 'payment_webhook_events'] LOOP
        PERFORM test_support.assert_true((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || table_name)::regclass), 'RLS enabled on ' || table_name);
        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            PERFORM test_support.assert_true(NOT has_table_privilege(api_role, 'public.' || table_name, 'SELECT'), 'no client SELECT grant on ' || table_name);
            PERFORM test_support.assert_true(NOT has_table_privilege(api_role, 'public.' || table_name, 'INSERT'), 'no client INSERT grant on ' || table_name);
        END LOOP;
    END LOOP;
END
$test$;
