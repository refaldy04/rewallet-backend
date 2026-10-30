-- Stage 2: run ONLY after the wallet backend has been implemented and tested.
-- Stop application writes before running. See migrations/README.md.
-- Imports reviewed current balances once; never replays historical transactions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(48009, 1);

LOCK TABLE public.app_schema_migrations, public.users, public.profile,
    public.transaction, public.transaction_type, public.wallets, public.wallet_entries,
    public.payment_requests, public.payment_webhook_events IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.app_schema_migrations WHERE version = '002_prepare_xendit_wallet') THEN
        RAISE EXCEPTION 'Apply 002_prepare_xendit_wallet first';
    END IF;
    IF EXISTS (SELECT 1 FROM public.app_schema_migrations WHERE version = '003_wallet_cutover') THEN
        RAISE EXCEPTION '003_wallet_cutover has already been applied; balances must not be imported twice';
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallets) OR EXISTS (SELECT 1 FROM public.wallet_entries)
       OR EXISTS (SELECT 1 FROM public.payment_requests) OR EXISTS (SELECT 1 FROM public.payment_webhook_events)
       OR EXISTS (SELECT 1 FROM public.transaction WHERE status <> 'LEGACY') THEN
        RAISE EXCEPTION 'Cutover requires empty wallet/payment tables and no new wallet transactions'
            USING HINT = 'Use a separate test database for integration testing; do not erase real financial records.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.users u WHERE NOT EXISTS
               (SELECT 1 FROM public.profile p WHERE p.user_id = u.id)) THEN
        RAISE EXCEPTION 'Each user must have exactly one reviewed profile before importing balances';
    END IF;
    IF (SELECT count(*) FROM public.transaction_type WHERE code IN ('TOPUP', 'TRANSFER', 'OPENING_BALANCE')) <> 3 THEN
        RAISE EXCEPTION 'Canonical transaction type codes are missing';
    END IF;
END
$guard$;

INSERT INTO public.wallets (user_id, currency, balance)
SELECT user_id, 'IDR', balance::numeric::bigint FROM public.profile;

WITH opening_transactions AS (
    INSERT INTO public.transaction (amount, sender_id, recipient_id, notes, "time", type_id, currency, status)
    SELECT w.balance, NULL, w.user_id, 'Opening balance imported from reviewed profile.balance',
           now() AT TIME ZONE 'UTC', tt.id, 'IDR', 'SUCCEEDED'
    FROM public.wallets w
    CROSS JOIN public.transaction_type tt
    WHERE w.balance > 0 AND tt.code = 'OPENING_BALANCE'
    RETURNING id, recipient_id, amount
)
INSERT INTO public.wallet_entries (wallet_id, transaction_id, direction, amount)
SELECT w.id, t.id, 'CREDIT', t.amount
FROM opening_transactions t JOIN public.wallets w ON w.user_id = t.recipient_id AND w.currency = 'IDR';

-- The old balance remains a frozen snapshot so a stale backend cannot silently
-- keep modifying a second source of truth after cutover.
CREATE FUNCTION public.wallet_reject_legacy_profile_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    IF NEW.balance IS DISTINCT FROM OLD.balance OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'Wallet cutover is active: update wallets through the wallet service, not profile.balance/user_id'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$function$;
CREATE TRIGGER wallet_reject_legacy_profile_balance BEFORE UPDATE ON public.profile
    FOR EACH ROW EXECUTE FUNCTION public.wallet_reject_legacy_profile_balance();

CREATE FUNCTION public.wallet_reject_legacy_transaction() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
    type_code text;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'LEGACY' THEN
        RAISE EXCEPTION 'Historical transactions are read-only after wallet cutover' USING ERRCODE = '23514';
    END IF;
    IF TG_OP <> 'DELETE' THEN
        SELECT code INTO type_code FROM public.transaction_type WHERE id = NEW.type_id;
        IF NEW.status = 'LEGACY' OR type_code IS NULL OR type_code LIKE 'LEGACY_%' THEN
            RAISE EXCEPTION 'Use an explicit wallet status and a canonical transaction type after cutover'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    RETURN OLD;
END
$function$;
CREATE TRIGGER wallet_reject_legacy_transaction BEFORE INSERT OR UPDATE OR DELETE ON public.transaction
    FOR EACH ROW EXECUTE FUNCTION public.wallet_reject_legacy_transaction();
REVOKE ALL ON FUNCTION public.wallet_reject_legacy_profile_balance(),
    public.wallet_reject_legacy_transaction() FROM PUBLIC;
DO $privileges$
DECLARE
    api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.wallet_reject_legacy_profile_balance(), public.wallet_reject_legacy_transaction() FROM %I', api_role);
        END IF;
    END LOOP;
END
$privileges$;

INSERT INTO public.app_schema_migrations (version) VALUES ('003_wallet_cutover');
COMMIT;
