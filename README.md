# fw9-backend

## About

A backend program for E-Wallet application.

## Built With

[nodejs](https://nodejs.org/en/) <br/>
[express](https://expressjs.com/) <br/>
[express-validator](https://express-validator.github.io/docs/) <br/>
[jsonwebtoken](https://www.npmjs.com/package/jsonwebtoken) <br/>
[bcrypt](https://www.npmjs.com/package/bcrypt) <br/>
[pg](https://www.npmjs.com/package/pg) <br/>
[cloudinary](https://www.npmjs.com/package/cloudinary) <br/>
[multer](https://www.npmjs.com/package/multer) <br/>
[dotenv](https://www.npmjs.com/package/dotenv) <br/>
[cors](https://www.npmjs.com/package/cors) <br/>

## How to Use This Project

### Local runtime

Use Node.js **24.x** for local development and Vercel deployment.
Install an up-to-date patch release within the 24.x series.
See the [official Node.js downloads](https://nodejs.org/en/download).

The `.nvmrc` and `.node-version` files select the 24.x development runtime.
With nvm installed, run `nvm install` and `nvm use` (on nvm-windows,
use `nvm install 24` and `nvm use 24`). Then run:

```sh
npm ci
npm audit
npm start
```

Configure the database, JWT secret and Cloudinary environment variables
before using the corresponding endpoints. The local server listens on port 3334.
Run `npm test` for the Cloudinary adapter, wallet reads/registration, atomic
transfers, Xendit top ups and security regression checks.
Integration tests start a disposable local PostgreSQL cluster when
`initdb` and `pg_ctl` are on PATH, and otherwise report a skip. They use the
application table definitions from `schema.sql`, synthetic data and real HTTP
requests; they never connect to the application's database. Cloudinary tests
use a mocked SDK; live Cloudinary integration still needs separate testing.

For Vercel deployment, use Node.js 24.x in the project's Node.js Version
setting and redeploy. The `engines.node` field in `package.json` also
specifies `24.x` to keep deployment aligned with local development.
Review dependency audit findings separately; upgrading Node.js alone does
not fix vulnerabilities in application dependencies.

### API usage

Registration and PIN setup are separate steps: `/auth/register` creates an
account, profile and zero-balance IDR wallet atomically on one database
connection. A failed insert rolls back all three. Admin account creation at
`POST /admin/user` uses the same setup. Log in at `/auth/login`, then send the returned
Bearer token with `/auth/createPin`. PIN setup always uses the authenticated
account; the old email-based PIN setup is no longer supported. Submit PINs as
six-character strings so leading zeros are preserved.

Profile responses, including admin reads and profile edits, take `balance` from
`wallets` by `profile.user_id` and currency `IDR`. The legacy `profile.balance`
column is no longer returned as the active balance. Balances and transaction
amounts are PostgreSQL `BIGINT` values returned as decimal strings in whole
rupiah, for example `"0"` or `"125000"`.

`GET /historyTransaction` includes transactions where the authenticated user is
the sender or recipient. `direction` is `CREDIT` for incoming transactions and
`DEBIT` for outgoing transactions; legacy self top ups appear once as `CREDIT`.
`fullname` and `picture` describe the other party, and can be null for top ups,
opening balances or missing profiles. Results also include `sender_id`,
`recipient_id`, `type_code`, `status`, `currency`, `reference_id`, `notes` and
`created_at`. Use `type_code` for canonical types rather than hardcoded numeric
IDs, and use `status` to distinguish pending or failed transactions from success.
Pagination counts both directions. New transactions sort by `created_at` first;
legacy rows with no `created_at` follow in descending `time` order. IDs break
timestamp ties. The legacy timestamp remains available without assigning it an
assumed historical timezone.

`POST /transfer` (also `/auth/transfer`) requires a Bearer token, a six-digit
string `pin`, the recipient's **user ID** in `recipient_id`, and a positive
whole-rupiah `amount`. Use a decimal string for amounts above JavaScript's safe
integer range; the maximum is `9223372036854775807`. Optional `notes` must be a
string or null, and optional `currency` must be `IDR`. The sender, transaction
type, success status and timestamps are assigned by the server.

Send a new `Idempotency-Key` header for each intended transfer (1–128 visible
ASCII characters without spaces). Form clients may instead send
`idempotency_key` in the body. If both are supplied, they must match. For example:

```http
POST /transfer
Authorization: Bearer <token>
Idempotency-Key: 4b57b6fa-08cb-4298-9122-4146201407aa
Content-Type: application/json

{"pin":"001234","recipient_id":2,"amount":"10000","notes":"Lunch"}
```

Keep the same key and business payload when retrying, including after a timeout.
Both the initial success and a successful retry return HTTP 200 with the same
transaction in `result`; no balances or ledger entries are applied twice. Keys
are scoped to the authenticated sender. Reusing a key with a different recipient,
amount or notes returns HTTP 409. Equivalent integer strings/numbers, omitted or
null notes, and omitted or explicit `IDR` currency are normalized before hashing.
Every retry still requires the current valid PIN.

Transfers check both IDR wallets and available funds under ordered row locks.
The transaction, debit, credit and two ledger entries commit together on one
connection. Insufficient funds, an unavailable sender wallet or a recipient
balance overflow return HTTP 409; a missing recipient wallet returns HTTP 404.
Rejected transfers leave no financial records, so an uncommitted request can
be retried. Wrong PIN attempts still persist and share the existing lockout.

### Security configuration and API changes

- `APP_SECRET` is mandatory; the server refuses to start without it. Use a
  randomly generated secret of at least 32 bytes and rotate any previously used
  development secret. JWTs use HS256, expire after one hour and are invalidated
  after password changes. Previous tokens require a fresh login.
- `ADMIN_USER_IDS` is an operator-managed comma-separated list of existing
  `public.users.id` values. For example, `ADMIN_USER_IDS=12,34` authorizes those
  two users. No configured IDs means all admin access is denied. The schema has
  no application role column; request fields and JWT role claims cannot grant
  admin access. Every `/admin` router requires authentication and this check.
- `/admin/transaction` and `/admin/transaction/:id` are read-only (`GET`/`HEAD`).
  Creating, editing or deleting financial records returns HTTP 405, including for
  administrators. Transfers and payment credits must update the transaction,
  wallet and ledger together through their wallet service. Corrections require
  a separate compensating financial workflow; generic admin CRUD cannot do that.
- Admin transaction/type IDs are validated before database queries. Missing
  records return JSON HTTP 404, and deleting a transaction type still referenced
  by transactions returns HTTP 409. Database failures use the error middleware
  without returning database details or terminating the HTTP process.
- `PATCH /profile` accepts only `fullname`, `phone_number` and a multipart
  `picture` upload. Other fields are rejected. Updates use exactly
  `profile.user_id = authenticated_user_id`; admin updates by profile ID use
  exactly `profile.id`. Neither editing path changes balance or ownership.
- `/allProfile` is a recipient directory exposing only `id`, `user_id`,
  `fullname` and `picture`. Balances and phone numbers remain private.
- `PATCH /resetPassword/:id` now requires a Bearer token, the caller's own ID,
  `password` (current password) and `newpassword`. `/changePassword` has the same
  credential requirements without the ID parameter. This closes the old public
  ID-only reset; it is **not an unauthenticated forgotten-password recovery
  flow**. Email recovery requires a separate delivery service and an expiring,
  single-use token flow. `/checkEmail` returns a generic response without IDs.
- Login returns `pinSet` instead of `pin`. PINs, password hashes and PIN hashes
  are never included in API results or validation errors. Request/user/SQL
  logging that could expose credentials has been removed.
- PIN setup and changes write bcrypt hashes to `users.pin_hash` and clear
  `users.pin`. Five wrong PIN attempts lock the account's PIN verification for
  15 minutes (HTTP 429 with `Retry-After`). `/checkPin`, `/changePin` and the
  transfer PIN check share persistent counters and a database row lock.
  `/changePin` requires both `pin` and `newpin` as six-digit strings.
- `/transfer` and `/topup` use the migrated wallet tables and require wallet cutover
  003. `/topup` remains HTTP 503 until Xendit is explicitly enabled and configured.
  Credits require verified full payment capture, never a client-supplied status.

The same auth endpoints remain mounted both under `/auth` and at the root.
Reauthentication follows the
[OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### Xendit Payment Requests v3

The backend uses `POST https://api.xendit.co/v3/payment_requests`, Basic auth with
the server secret key and `api-version: 2024-11-11`. Each top up is a single-use
`PAY` request with automatic capture in `ID`/`IDR`. Internal user-to-user transfers
continue to use the local wallet service.

No new migration is required if migrations 002 and 003 have already run and the
current `schema.sql` matches your database. The integration uses `payment_requests`,
`payment_webhook_events`, `wallets`, `transaction`, `transaction_type` and
`wallet_entries`; it requires the canonical `TOPUP` transaction type from 002.
Do not rerun cutover to enable Xendit.

Start in **Xendit test mode**. Copy the settings from
[config/xendit.env.example](config/xendit.env.example) into the backend environment:

- `XENDIT_ENABLED=true` explicitly enables the integration. Leave it false until
  the other settings are ready. It also gates webhook handling and reconciliation.
- `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN` and `XENDIT_BUSINESS_ID` must all belong
  to the same account and mode. Keep them on the backend. Use the callback
  verification token from Xendit webhook settings, not the API secret.
- `XENDIT_ENABLED_CHANNELS` is an explicit comma-separated allowlist. Currently
  supported: `DANA,SHOPEEPAY,QRIS`. Enable only channels activated in your Xendit
  account/mode. Banks, cards, reusable codes, OTP and saved payment methods need
  their own channel requirements and are not enabled by this implementation.
- `XENDIT_SUCCESS_RETURN_URL` and `XENDIT_FAILURE_RETURN_URL` point to frontend
  pages. The backend appends `topup_id=<local UUID>` to each redirect URL. HTTPS is
  required, except HTTP localhost during development. Request bodies cannot
  override these URLs. QRIS does not require return URLs.
- `TOPUP_MIN_AMOUNT=10000` and `TOPUP_MAX_AMOUNT=10000000` are application limits
  in whole rupiah. Each channel also applies its own range: DANA 100–20,000,000,
  ShopeePay 1–20,000,000, QRIS 1–10,000,000. The catalogue exposes the intersection.
  Check account-specific limits before enabling a live channel.

Configure Xendit's **Payments v3** webhook URL to
`https://<backend-host>/webhooks/xendit/payments` for `payment.capture`,
`payment.authorization` and `payment.failure`. This route uses `x-callback-token`
authentication instead of a user JWT and verifies the Xendit business ID.

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /topup/methods` | Bearer token | App-configured channel catalogue and limits |
| `POST /topup` | Bearer token + `Idempotency-Key` | Create or replay a top up |
| `GET /topups/:id` | Owner's Bearer token | Read the local payment status |
| `POST /topups/:id/refresh` | Owner's Bearer token | Query Xendit and reconcile capture evidence |
| `POST /webhooks/xendit/payments` | Xendit callback token | Persist and process payment events |

User endpoints also work under `/auth`. This catalogue comes from backend
configuration; it does not call a Xendit endpoint to discover activated channels.
All payment amounts in responses are decimal strings.

```http
POST /topup
Authorization: Bearer <token>
Idempotency-Key: 6cad81df-79db-405c-b137-22da79a0057d
Content-Type: application/json

{"amount":"25000","channel_code":"DANA"}
```

Only `amount`, `channel_code`, optional `currency: "IDR"` and optional
`idempotency_key` are accepted. The key can be sent in the header or body; if both
are present, they must match. Reusing a key with different normalized business
data returns HTTP 409. Keys are scoped to the authenticated user. A fresh request
normally returns HTTP 201 and a replay HTTP 200. `CREATED`/`UNKNOWN` returns HTTP
202 with the durable payment ID; keep the same key after a timeout.

The frontend flow is:

1. Load `/topup/methods`, choose a channel and submit `/topup` with a new key for
   that intended top up. Persist the key and returned `result.id` across retries.
2. Use `result.actions` from Xendit. A `REDIRECT_CUSTOMER` action with `WEB_URL`
   opens a payment page; `DEEPLINK_URL` opens the appropriate wallet app. A
   `PRESENT_TO_CUSTOMER`/`QR_STRING` action must be rendered as a QR code. Do not
   assume every channel has a redirect URL. Do not render action values as HTML.
3. On the frontend return page, load `/topups/<topup_id>`. Poll this local endpoint
   with backoff while processing; use `/refresh` for a deliberate reconciliation,
   not every poll. URL parameters or a success return page do not authorize credit.
4. Show a successful top up only when the backend returns `status: "SUCCEEDED"`
   and `transaction_id`. Failed/expired payments have no actionable payment links.

Request creation and status-only responses never increase balance. A verified
`payment.capture` or authenticated Xendit payment lookup must match the local
reference, provider request ID, business, channel, `PAY` type, automatic capture,
country, currency and exact amount. Only a single full capture is supported.
The service locks the payment and wallet, then commits the successful transaction,
one credit ledger entry, wallet balance and payment linkage together. Duplicate
events are safe, including concurrent delivery, early webhooks and lost commit
acknowledgements. Late failure/pending responses cannot undo a successful credit.
Conflicting captures remain in the private failed inbox for operator review.

The callback is persisted before processing, and processing completes before the
HTTP response. A processing failure returns HTTP 503 so Xendit can retry; it also
leaves a durable inbox entry. No unawaited work is required after a Vercel response.
Monitor failed inbox entries and run the bounded reconciliation command from an
external scheduler/worker (for example, every minute) with the same backend
environment; deployment does not schedule it automatically:

```sh
npm run payments:reconcile
npm run payments:reconcile -- --topup-id <local-UUID>
```

The batch replays up to 20 received/failed events and refreshes up to 20 unfinished
payments sequentially. It prints counts, never payloads or credentials. A nonzero
exit code means failed work or unknown requests need review. Repeated runs are
safe; concurrent workers are serialized by database row locks for financial writes.

Xendit v3 creation does not document a universal idempotency header or guarantee
unique `reference_id` for these channels. Consequently the backend reserves a
local request once and **never retries its provider POST**, even after a timeout
or process crash. A stale `CREATED` request becomes `UNKNOWN` during reconciliation.
If no provider ID was received, a late webhook can recover it by reference. If
that webhook is also missing, find the matching request in the Xendit dashboard
using the local `reference_id`, then run:

```sh
npm run payments:reconcile -- --topup-id <local-UUID> --payment-request-id <Xendit-pr-ID>
```

This operator-only command fetches and validates the provider record before
binding it. It cannot create payments or arbitrarily mark them paid. Do not
automatically create a new top up with a new key while the first outcome is
unknown. Partial/multiple captures, refunds and chargebacks need a separate
compensating wallet workflow; never edit a settled transaction or ledger entry.

Automated tests use a mocked Xendit adapter and disposable PostgreSQL, never live
Xendit/Supabase. Before production, exercise a real test-mode redirect/QR payment,
callback delivery and frontend return, then configure live credentials and channels
separately. References: [create request](https://docs.xendit.co/apidocs/create-payment-request),
[payment webhooks](https://docs.xendit.co/apidocs/payment-webhook-notification),
[payment lookup](https://docs.xendit.co/apidocs/get-payment).

### Existing PIN migration

The root `schema.sql` already defines nullable `users.pin`, `pin_hash`,
`pin_failed_attempts` and `pin_locked_until`. For an older database, first
follow the preflight and preparation steps in [migrations/README.md](migrations/README.md)
through migration 002; do not run wallet cutover 003 just for PIN support.

With application traffic stopped, run:

```sh
npm run db:migrate:pin
```

This command uses `DATABASE_URL` from the environment or `.env`, hashes existing
six-digit PINs with bcrypt (cost 12) and erases their plaintext values. It validates
legacy PINs and existing bcrypt hashes before any account is changed, prevents
overlapping migration runs, and commits each account independently so interrupted
runs can resume. Repeating a completed run does not rehash accounts. Existing
hash/counter/lock state is preserved; a valid existing hash takes precedence over
any remaining plaintext PIN. Invalid data stops the migration for review and
account recovery; credentials and raw database errors are never printed. A
missing `DATABASE_URL` stops the command instead of selecting a default database.
A successful legacy PIN verification also upgrades that account if
migration has not yet run. Deployment does not automatically run this command.

1. Install Postman and open it
2. click environment in the sidebar
3. create new environment
4. create url variabel
5. fill initial value and current value column with this link "https://fw9-backend-rewallet.vercel.app/"
6. create token variabel
7. fill current value column with token what you get when login (skip this step if you not have create end-point)
8. click colection in the sidebar
9. create new collection
10. creat end-point in the collection
11. start with url variabel on the path bar (e.g. {{url}})
    --FOR MAKE THIS SIMPLE THIS POSTMAN DATA [postman data](/BACKEND%20APP%20EWALLET.postman_collection.json)

## Endpoints

<table>
  <tr>
    <th>url</th>
    <th>method</th>
    <th>description</th>
  </tr>
  <tr>
    <td>/auth/login</td>
    <td>POST</td>
    <td>login</td>
  </tr>
  <tr>
    <td>/auth/register</td>
    <td>POST</td>
    <td>register</td>
  </tr>
  <tr>
    <td>/auth/createPin</td>
    <td>POST</td>
    <td>create pin</td>
  </tr>
  <tr>
    <td>/profile</td>
    <td>GET</td>
    <td>get profile user already login</td>
  </tr>
  <tr>
    <td>/historyTransaction</td>
    <td>GET</td>
    <td>get history transaction</td>
  </tr>
  <tr>
    <td>/allProfile</td>
    <td>GET</td>
    <td>get all profile</td>
  </tr>
  <tr>
    <td>/transfer</td>
    <td>POST</td>
    <td>transfer</td>
  </tr>
  <tr>
    <td>/phone</td>
    <td>POST</td>
    <td>add phone number</td>
  </tr>
  <tr>
    <td>/profile/</td>
    <td>PATCH</td>
    <td>edit profile</td>
  </tr>
  <tr>
    <td>/changePassword</td>
    <td>PATCH</td>
    <td>edit password</td>
  </tr>
  <tr>
    <td>/changePin</td>
    <td>PATCH</td>
    <td>edit pin </td>
  </tr>
  <tr>
    <td>/phone</td>
    <td>PATCH</td>
    <td>edit phone number</td>
  </tr>
  <tr>
    <td>/topup</td>
    <td>post</td>
    <td>topup amount</td>
  </tr>
</table>
