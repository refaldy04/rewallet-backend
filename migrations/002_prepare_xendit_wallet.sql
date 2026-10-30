-- Stage 1: schema preparation for the exact application schema in schema.sql.
-- Read migrations/README.md first. This does NOT activate Xendit or move balances.
-- Run as the database owner, in one session. On any error, the whole migration
-- rolls back. Re-running an applied migration is deliberately rejected.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_catalog.pg_advisory_xact_lock(48009, 1);

CREATE TABLE IF NOT EXISTS public.app_schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.app_schema_migrations WHERE version = '002_prepare_xendit_wallet') THEN
        RAISE EXCEPTION '002_prepare_xendit_wallet has already been applied';
    END IF;
    IF to_regclass('public.wallets') IS NOT NULL
       OR to_regclass('public.wallet_entries') IS NOT NULL
       OR to_regclass('public.payment_requests') IS NOT NULL
       OR to_regclass('public.payment_webhook_events') IS NOT NULL THEN
        RAISE EXCEPTION 'Wallet/payment tables already exist; inspect their schema before migrating';
    END IF;
END
$guard$;

-- Prevent concurrent application writes while validating and altering data.
LOCK TABLE public.users, public.profile, public.transaction, public.transaction_type
    IN SHARE ROW EXCLUSIVE MODE;

DO $validate$
DECLARE
    problems text[] := ARRAY[]::text[];
BEGIN
    IF EXISTS (SELECT id FROM public.profile GROUP BY id HAVING count(*) > 1)
       OR EXISTS (SELECT id FROM public.transaction GROUP BY id HAVING count(*) > 1)
       OR EXISTS (SELECT id FROM public.transaction_type GROUP BY id HAVING count(*) > 1) THEN
        problems := array_append(problems, 'duplicate IDs');
    END IF;
    IF EXISTS (SELECT user_id FROM public.profile GROUP BY user_id HAVING count(*) > 1) THEN
        problems := array_append(problems, 'more than one profile per user');
    END IF;
    IF EXISTS (SELECT 1 FROM public.profile p WHERE p.user_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p.user_id)) THEN
        problems := array_append(problems, 'profile has a missing/invalid user');
    END IF;
    IF EXISTS (SELECT 1 FROM public.profile WHERE balance IS NULL OR balance::numeric < 0
               OR balance::numeric <> trunc(balance::numeric)
               OR balance::numeric > 9223372036854775807::numeric) THEN
        problems := array_append(problems, 'balance is NULL, negative, fractional, or outside BIGINT');
    END IF;
    IF EXISTS (SELECT 1 FROM public.transaction WHERE amount IS NULL OR amount::numeric <= 0
               OR amount::numeric <> trunc(amount::numeric)
               OR amount::numeric > 9223372036854775807::numeric) THEN
        problems := array_append(problems, 'amount is nonpositive, fractional, or outside BIGINT');
    END IF;
    IF EXISTS (SELECT 1 FROM public.transaction t
               WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = t.recipient_id)
                  OR (t.sender_id IS NOT NULL AND NOT EXISTS
                      (SELECT 1 FROM public.users u WHERE u.id = t.sender_id))
                  OR NOT EXISTS (SELECT 1 FROM public.transaction_type tt WHERE tt.id = t.type_id)) THEN
        problems := array_append(problems, 'transaction has an invalid sender, recipient, or type');
    END IF;
    IF cardinality(problems) > 0 THEN
        RAISE EXCEPTION 'Migration stopped: %', array_to_string(problems, '; ')
            USING HINT = 'Run 001_wallet_preflight.sql. Reconcile the reported data, then retry. No balances were changed.';
    END IF;
END
$validate$;

ALTER TABLE public.profile
    ADD CONSTRAINT profile_pkey PRIMARY KEY (id),
    ALTER COLUMN user_id SET NOT NULL,
    ADD CONSTRAINT profile_user_id_key UNIQUE (user_id),
    ADD CONSTRAINT profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
    ALTER COLUMN balance SET DEFAULT 0::numeric::money,
    ALTER COLUMN balance SET NOT NULL,
    ADD CONSTRAINT profile_balance_rupiah_check CHECK (
        balance::numeric >= 0 AND balance::numeric = trunc(balance::numeric)
        AND balance::numeric <= 9223372036854775807::numeric
    );

ALTER TABLE public.transaction_type
    ADD CONSTRAINT transaction_type_pkey PRIMARY KEY (id),
    ADD COLUMN code text;
UPDATE public.transaction_type SET code = 'LEGACY_' || id::text;
ALTER TABLE public.transaction_type
    ADD CONSTRAINT transaction_type_code_key UNIQUE (code);
-- code stays nullable for legacy administrative inserts during preparation.
INSERT INTO public.transaction_type (name, description, code) VALUES
    ('Wallet top up', 'Confirmed one-off external payment', 'TOPUP'),
    ('Wallet transfer', 'Transfer between application users', 'TRANSFER'),
    ('Opening balance', 'Reviewed balance snapshot at wallet cutover', 'OPENING_BALANCE');

ALTER TABLE public.users
    ALTER COLUMN pin DROP NOT NULL,
    ADD COLUMN pin_hash text,
    ADD COLUMN pin_failed_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN pin_locked_until timestamptz,
    ADD CONSTRAINT users_pin_hash_check CHECK (pin_hash IS NULL OR length(pin_hash) > 0),
    ADD CONSTRAINT users_pin_failed_attempts_check CHECK (pin_failed_attempts >= 0);
-- Existing PINs are not copied to pin_hash: the backend must hash/reset them.

ALTER TABLE public.transaction
    ADD CONSTRAINT transaction_pkey PRIMARY KEY (id),
    ALTER COLUMN amount TYPE bigint USING (amount::numeric::bigint),
    ADD CONSTRAINT transaction_amount_check CHECK (amount > 0),
    ADD CONSTRAINT transaction_recipient_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT transaction_sender_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT transaction_type_fkey FOREIGN KEY (type_id) REFERENCES public.transaction_type(id) ON DELETE RESTRICT,
    ADD COLUMN currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
    ADD COLUMN status text NOT NULL DEFAULT 'LEGACY'
        CHECK (status IN ('LEGACY', 'PENDING', 'SUCCEEDED', 'FAILED', 'REVERSED')),
    ADD COLUMN reference_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    ADD COLUMN idempotency_key text CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    ADD COLUMN request_fingerprint text CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD COLUMN created_at timestamptz,
    ADD CONSTRAINT transaction_new_timestamp_check CHECK (status = 'LEGACY' OR created_at IS NOT NULL);
-- Add the default separately so historical rows retain created_at = NULL.
ALTER TABLE public.transaction ALTER COLUMN created_at SET DEFAULT now();
CREATE UNIQUE INDEX transaction_sender_idempotency_key
    ON public.transaction (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX transaction_sender_created_idx ON public.transaction (sender_id, created_at DESC);
CREATE INDEX transaction_recipient_created_idx ON public.transaction (recipient_id, created_at DESC);
CREATE INDEX transaction_type_idx ON public.transaction (type_id);

CREATE TABLE public.wallets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
    balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, currency)
);

CREATE TABLE public.wallet_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    wallet_id bigint NOT NULL REFERENCES public.wallets(id) ON DELETE RESTRICT,
    transaction_id integer NOT NULL REFERENCES public.transaction(id) ON DELETE RESTRICT,
    direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount bigint NOT NULL CHECK (amount > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, wallet_id)
);
CREATE INDEX wallet_entries_wallet_created_idx ON public.wallet_entries (wallet_id, created_at DESC, id DESC);

CREATE TABLE public.payment_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    transaction_id integer UNIQUE REFERENCES public.transaction(id) ON DELETE RESTRICT,
    reference_id text NOT NULL UNIQUE CHECK (length(reference_id) BETWEEN 1 AND 255),
    payment_request_id text UNIQUE,
    payment_id text UNIQUE,
    capture_id text UNIQUE,
    amount bigint NOT NULL CHECK (amount > 0),
    currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
    country text NOT NULL DEFAULT 'ID' CHECK (country = 'ID'),
    channel_code text NOT NULL CHECK (length(channel_code) > 0),
    status text NOT NULL DEFAULT 'CREATED' CHECK (status IN (
        'CREATED', 'PENDING', 'UNKNOWN', 'REQUIRES_ACTION', 'ACCEPTING_PAYMENTS',
        'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'
    )),
    idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array'),
    failure_code text,
    expires_at timestamptz,
    paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key),
    CONSTRAINT payment_requests_success_check CHECK (
        status <> 'SUCCEEDED' OR
        (payment_request_id IS NOT NULL AND payment_id IS NOT NULL
         AND capture_id IS NOT NULL AND paid_at IS NOT NULL)
    )
);
CREATE INDEX payment_requests_user_created_idx ON public.payment_requests (user_id, created_at DESC);
CREATE INDEX payment_requests_unfinished_idx ON public.payment_requests (updated_at)
    WHERE status IN ('CREATED', 'PENDING', 'UNKNOWN', 'REQUIRES_ACTION', 'ACCEPTING_PAYMENTS', 'AUTHORIZED');

CREATE TABLE public.payment_webhook_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dedup_key text NOT NULL UNIQUE CHECK (length(dedup_key) > 0),
    event_type text NOT NULL,
    payment_request_id text NOT NULL,
    payment_id text,
    capture_id text,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    processing_status text NOT NULL DEFAULT 'RECEIVED'
        CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error text,
    CHECK (processing_status NOT IN ('PROCESSED', 'IGNORED') OR processed_at IS NOT NULL)
);
-- Provider IDs remain text without an FK here: a valid webhook may arrive before
-- the create-payment response is committed locally.
CREATE INDEX payment_webhook_events_request_idx ON public.payment_webhook_events (payment_request_id);
CREATE INDEX payment_webhook_events_retry_idx ON public.payment_webhook_events (received_at)
    WHERE processing_status IN ('RECEIVED', 'PROCESSING', 'FAILED');

CREATE FUNCTION public.wallet_set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END
$function$;
CREATE TRIGGER wallets_updated_at BEFORE UPDATE ON public.wallets
    FOR EACH ROW EXECUTE FUNCTION public.wallet_set_updated_at();
CREATE TRIGGER payment_requests_updated_at BEFORE UPDATE ON public.payment_requests
    FOR EACH ROW EXECUTE FUNCTION public.wallet_set_updated_at();

CREATE FUNCTION public.wallet_entries_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    RAISE EXCEPTION 'Wallet entries are append-only; record a compensating transaction instead'
        USING ERRCODE = '23514';
END
$function$;
CREATE TRIGGER wallet_entries_immutable BEFORE UPDATE OR DELETE ON public.wallet_entries
    FOR EACH ROW EXECUTE FUNCTION public.wallet_entries_immutable();

CREATE FUNCTION public.wallet_transaction_shape() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
    type_code text;
BEGIN
    SELECT code INTO type_code FROM public.transaction_type WHERE id = NEW.type_id;
    IF type_code IN ('TOPUP', 'TRANSFER', 'OPENING_BALANCE') THEN
        IF NEW.status = 'LEGACY' THEN
            RAISE EXCEPTION 'Canonical wallet types require an explicit transaction status' USING ERRCODE = '23514';
        END IF;
        IF type_code = 'TRANSFER' AND (
            NEW.sender_id IS NULL OR NEW.sender_id = NEW.recipient_id
            OR NEW.idempotency_key IS NULL OR NEW.request_fingerprint IS NULL
        ) THEN
            RAISE EXCEPTION 'TRANSFER requires distinct users, an idempotency key, and a request fingerprint'
                USING ERRCODE = '23514';
        END IF;
        IF type_code IN ('TOPUP', 'OPENING_BALANCE') AND NEW.sender_id IS NOT NULL THEN
            RAISE EXCEPTION 'TOPUP/OPENING_BALANCE requires sender_id = NULL' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$function$;
CREATE TRIGGER wallet_transaction_shape BEFORE INSERT OR UPDATE ON public.transaction
    FOR EACH ROW EXECUTE FUNCTION public.wallet_transaction_shape();

-- New financial tables are backend-only. Supabase default privileges can grant
-- anon/authenticated access, so revoke those grants explicitly when roles exist.
ALTER TABLE public.app_schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_schema_migrations, public.wallets, public.wallet_entries,
    public.payment_requests, public.payment_webhook_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.wallets_id_seq, public.wallet_entries_id_seq,
    public.payment_webhook_events_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_set_updated_at(), public.wallet_entries_immutable(),
    public.wallet_transaction_shape() FROM PUBLIC;
DO $privileges$
DECLARE
    api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON public.app_schema_migrations, public.wallets, public.wallet_entries, public.payment_requests, public.payment_webhook_events FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON SEQUENCE public.wallets_id_seq, public.wallet_entries_id_seq, public.payment_webhook_events_id_seq FROM %I', api_role);
            EXECUTE format('REVOKE ALL ON FUNCTION public.wallet_set_updated_at(), public.wallet_entries_immutable(), public.wallet_transaction_shape() FROM %I', api_role);
        END IF;
    END LOOP;
END
$privileges$;

INSERT INTO public.app_schema_migrations (version) VALUES ('002_prepare_xendit_wallet');
COMMIT;
