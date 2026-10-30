-- Read-only diagnostics for the application tables in schema.sql.
-- Run before 002_prepare_xendit_wallet.sql. Every issue_count must be zero.
-- No user credentials or personal information are returned.
BEGIN TRANSACTION READ ONLY;

WITH issues AS (
    SELECT 'profile_duplicate_id' AS issue, count(*) AS issue_count
    FROM (SELECT id FROM public.profile GROUP BY id HAVING count(*) > 1) duplicates
    UNION ALL
    SELECT 'transaction_duplicate_id', count(*)
    FROM (SELECT id FROM public.transaction GROUP BY id HAVING count(*) > 1) duplicates
    UNION ALL
    SELECT 'transaction_type_duplicate_id', count(*)
    FROM (SELECT id FROM public.transaction_type GROUP BY id HAVING count(*) > 1) duplicates
    UNION ALL
    SELECT 'profile_duplicate_user_id', count(*)
    FROM (SELECT user_id FROM public.profile GROUP BY user_id HAVING count(*) > 1) duplicates
    UNION ALL
    SELECT 'profile_missing_user', count(*) FROM public.profile p
    WHERE p.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.user_id)
    UNION ALL
    SELECT 'profile_invalid_balance', count(*) FROM public.profile
    WHERE balance IS NULL OR balance::numeric < 0
       OR balance::numeric <> trunc(balance::numeric)
       OR balance::numeric > 9223372036854775807::numeric
    UNION ALL
    SELECT 'transaction_invalid_amount', count(*) FROM public.transaction
    WHERE amount IS NULL OR amount::numeric <= 0
       OR amount::numeric <> trunc(amount::numeric)
       OR amount::numeric > 9223372036854775807::numeric
    UNION ALL
    SELECT 'transaction_missing_recipient', count(*) FROM public.transaction t
    WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = t.recipient_id)
    UNION ALL
    SELECT 'transaction_missing_sender', count(*) FROM public.transaction t
    WHERE t.sender_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = t.sender_id)
    UNION ALL
    SELECT 'transaction_missing_type', count(*) FROM public.transaction t
    WHERE NOT EXISTS (SELECT 1 FROM public.transaction_type tt WHERE tt.id = t.type_id)
)
SELECT issue, issue_count FROM issues ORDER BY issue;

-- These do not block schema preparation, but every user needs a profile at cutover.
SELECT count(*) AS users_without_profile_before_cutover
FROM public.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profile p WHERE p.user_id = u.id);

-- Existing types retain their IDs. Preparation labels them LEGACY_<id> rather
-- than guessing which historical type means TOPUP or TRANSFER.
SELECT id, name FROM public.transaction_type ORDER BY id;

-- The original dump has no timezone on transaction.time. The migration keeps
-- historical time unchanged instead of guessing its timezone.
SELECT count(*) AS historical_transactions, min("time") AS earliest_time,
       max("time") AS latest_time
FROM public.transaction;

COMMIT;
