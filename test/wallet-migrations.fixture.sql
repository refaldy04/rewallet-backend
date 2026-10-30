-- Synthetic application schema matching the four public tables in schema.sql.
-- This file is used only by the isolated PostgreSQL migration tests.
CREATE TABLE public.users (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email varchar(225) NOT NULL UNIQUE,
    password varchar(255) NOT NULL,
    username varchar(255) NOT NULL UNIQUE,
    pin varchar(6)
);
CREATE TABLE public.profile (
    id integer GENERATED ALWAYS AS IDENTITY,
    fullname varchar(255), balance money, picture varchar(255),
    user_id integer, phone_number varchar(25)
);
CREATE TABLE public.transaction_type (
    id integer GENERATED ALWAYS AS IDENTITY,
    name varchar(100) NOT NULL, description text
);
CREATE TABLE public.transaction (
    id integer GENERATED ALWAYS AS IDENTITY,
    amount money NOT NULL, recipient_id integer NOT NULL,
    sender_id integer, notes text, "time" timestamp without time zone NOT NULL,
    type_id integer NOT NULL
);

-- Simulate Supabase grants; the new tables must revoke these client privileges.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

INSERT INTO public.users (email, password, username, pin) VALUES
    ('first@example.invalid', 'synthetic-password', 'first', '012345'),
    ('second@example.invalid', 'synthetic-password', 'second', NULL);
INSERT INTO public.profile (user_id, balance) VALUES
    (1, 125000::numeric::money), (2, 0::numeric::money);
INSERT INTO public.transaction_type (name) VALUES ('Old top up'), ('Old transfer');
INSERT INTO public.transaction (amount, sender_id, recipient_id, "time", type_id) VALUES
    (100000::numeric::money, 1, 1, timestamp '2022-07-01 10:00:00', 1),
    (15000::numeric::money, 1, 2, timestamp '2022-07-02 10:00:00', 2);

CREATE SCHEMA test_support;
CREATE FUNCTION test_support.assert_true(condition boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF condition IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Assertion failed: %', message;
    END IF;
END
$$;
CREATE FUNCTION test_support.expect_error(command text, expected_state text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    actual_state text;
BEGIN
    BEGIN
        EXECUTE command;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
        IF NOT (actual_state = ANY (string_to_array(expected_state, ','))) THEN
            RAISE EXCEPTION 'Expected SQLSTATE %, got %: %', expected_state, actual_state, SQLERRM;
        END IF;
        RETURN;
    END;
    RAISE EXCEPTION 'Expected SQLSTATE %, command unexpectedly succeeded: %', expected_state, command;
END
$$;
