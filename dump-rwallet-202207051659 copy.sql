--
-- PostgreSQL database dump
--

-- Dumped from database version 14.3
-- Dumped by pg_dump version 14.3

-- Started on 2022-07-05 16:59:49

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

DROP DATABASE rwallet;
--
-- TOC entry 3337 (class 1262 OID 16516)
-- Name: rwallet; Type: DATABASE; Schema: -; Owner: postgres
--

CREATE DATABASE rwallet WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE = 'Indonesian_Indonesia.1252';


ALTER DATABASE rwallet OWNER TO postgres;

\connect rwallet

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- TOC entry 3 (class 2615 OID 2200)
-- Name: public; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO postgres;

--
-- TOC entry 3338 (class 0 OID 0)
-- Dependencies: 3
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 212 (class 1259 OID 16526)
-- Name: profile; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.profile (
    id integer NOT NULL,
    fullname character varying(255),
    balance money,
    picture character varying(255),
    user_id integer,
    phone_number character varying(25)
);


ALTER TABLE public.profile OWNER TO postgres;

--
-- TOC entry 211 (class 1259 OID 16525)
-- Name: profile_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.profile ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.profile_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- TOC entry 214 (class 1259 OID 16541)
-- Name: transaction; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transaction (
    id integer NOT NULL,
    amount money NOT NULL,
    recipient_id integer NOT NULL,
    sender_id integer,
    notes text,
    "time" timestamp without time zone NOT NULL,
    type_id integer NOT NULL
);


ALTER TABLE public.transaction OWNER TO postgres;

--
-- TOC entry 213 (class 1259 OID 16540)
-- Name: transaction_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.transaction ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.transaction_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- TOC entry 216 (class 1259 OID 16552)
-- Name: transaction_type; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.transaction_type (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text
);


ALTER TABLE public.transaction_type OWNER TO postgres;

--
-- TOC entry 215 (class 1259 OID 16551)
-- Name: transaction_type_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.transaction_type ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.transaction_type_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- TOC entry 210 (class 1259 OID 16518)
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(225) NOT NULL,
    password character varying(255) NOT NULL,
    username character varying(255) NOT NULL,
    pin character varying(6) NOT NULL
);


ALTER TABLE public.users OWNER TO postgres;

--
-- TOC entry 209 (class 1259 OID 16517)
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.users ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- TOC entry 3327 (class 0 OID 16526)
-- Dependencies: 212
-- Data for Name: profile; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.profile (id, fullname, balance, picture, user_id, phone_number) FROM stdin;
1	Refaldy Bagas Anggana	Rp100.000,00	http://blablabla	1	\N
3	Christiano Ronaldo	Rp80.000,00	http://wkwkwk	3	\N
5	Christiano Ronaldo	Rp1.000,00	http://www.wkwkw.com	3	08123456789
4	Vinsmoke Sanji	Rp1.000,00	http://hahahah	4	089765433678
6	Christiano Ronaldo	Rp10.000,00	http://www.wkwkw.com	3	08223456789
\.


--
-- TOC entry 3329 (class 0 OID 16541)
-- Dependencies: 214
-- Data for Name: transaction; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.transaction (id, amount, recipient_id, sender_id, notes, "time", type_id) FROM stdin;
1	Rp120.000,00	1	1	hallo	2022-06-20 00:00:00	1
11	Rp10.000,00	2	2	hhhh	2022-04-03 00:00:00	2
14	Rp10.000,00	3	3	tes	2022-01-01 00:00:00	3
18	Rp2.000,00	3	3	tes	2022-01-01 00:00:00	3
19	Rp2.000,00	3	3	tes	2022-01-01 00:00:00	3
22	Rp2.000,00	3	3	tes	2022-01-01 05:00:00	3
23	Rp12,00	3	3	tes	2022-11-30 00:00:00	3
24	Rp12,00	3	3	tes	2022-11-30 00:00:00	3
25	Rp1.000,00	3	3	tes	2022-11-30 00:00:00	3
26	Rp1.000,00	3	3	tes	2022-11-30 00:00:00	3
27	Rp1.000,00	3	3	tes	2022-11-30 00:00:00	3
28	Rp100,00	3	3	tes	2022-11-30 00:00:00	3
20	Rp75.000,00	7	7	update brow	2022-07-25 00:00:00	7
29	Rp10.000,00	3	3	tes	2022-11-30 00:00:00	3
\.


--
-- TOC entry 3331 (class 0 OID 16552)
-- Dependencies: 216
-- Data for Name: transaction_type; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.transaction_type (id, name, description) FROM stdin;
1	Transfer	transaction both users
4	subscription	subscribe a service
2	bayar	subscribe a service bayar
\.


--
-- TOC entry 3325 (class 0 OID 16518)
-- Dependencies: 210
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, email, password, username, pin) FROM stdin;
32	reeeeee@gmail.com	$2b$10$KNp5dSrF/VSPpDE7BWy3k.0As5qWMabePdPE2Heg8Q93lEdGADR36	reee	101010
34	reeba@gmail.com	$2b$10$nkvx19bentjl3SHeNaj98.4qMN9foM5LIKejcP.PkyrQbrpB/cKNy	reeeba	101010
2	refaldya@gmail.com	$2b$10$FwDzyXGnBHaw1Gxn7qYo4ejfC8UB8pjjkR8wj3jzWJsb/mfD67UkW	refaldya	090909
35	bagabaga@gmail.com	$2b$10$Ct2DBq3PJ7DVNoSpnl0S/.ZywdFlbv9pACZyPs/6x1nR94sdA2ih6	baga	101010
36	angga@gmail.com	$2b$10$6RAtP86Asskp4tV04nXZVO4t0ljEeG2fujfE3fHTn/rInqy06W6iW	angga	101010
4	bangga@gmail.com	$2b$10$xGi8XVT1L0Y1gxBZsIKvC.Ja77lqy0cCV6zOfKuruGoJF1VULwf.O	bangga	090909
5	nana@gmail.com	$2b$10$ABgv7KbY8sDJFroUmNC80eDQc007dDHqerg7GAUiBdwqeHNJ7XG7e	nana	090909
37	gabas@gmail.com	$2b$10$6eCyqYLGC0YY47zdqGQM9u0otGFfAlR4YyUIs6YJjR3ItipU2ORcS	gabas	101010
38	sabas@gmail.com	$2b$10$4ryz0rROpxB2LYCe/gIB.eCBGogGFyGxIbOUVn7qN3NH3mSFHG3NW	sabas	101010
39	sabasa@mail.com	$2b$10$HS6seTCrNxHvxqv5PmsjiuIbFrU/iD6OQunR5sEkQIQ76emq4Ei/S	sabasa	101010
\.


--
-- TOC entry 3339 (class 0 OID 0)
-- Dependencies: 211
-- Name: profile_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.profile_id_seq', 6, true);


--
-- TOC entry 3340 (class 0 OID 0)
-- Dependencies: 213
-- Name: transaction_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.transaction_id_seq', 29, true);


--
-- TOC entry 3341 (class 0 OID 0)
-- Dependencies: 215
-- Name: transaction_type_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.transaction_type_id_seq', 4, true);


--
-- TOC entry 3342 (class 0 OID 0)
-- Dependencies: 209
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 41, true);


--
-- TOC entry 3180 (class 2606 OID 16537)
-- Name: users email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT email_key UNIQUE (email);


--
-- TOC entry 3182 (class 2606 OID 16539)
-- Name: users username_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT username_key UNIQUE (username);


--
-- TOC entry 3184 (class 2606 OID 16524)
-- Name: users users_pk; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pk PRIMARY KEY (id);


-- Completed on 2022-07-05 16:59:51

--
-- PostgreSQL database dump complete
--

