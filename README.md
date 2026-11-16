# INFS3605-Project-Repo
Our repo for our centralised AI inventory management system for cafes

Simone - Project Owner 

Jodet - Dev | Backend and database design

Siqi - Dev | Business analysis

Itisha - Scrum Master 

Dinkal - Dev | UX Design

## Brewlytics agent

The server-side Gemini agent is available from **Today** and the persistent
chat dock. It uses the Vercel AI SDK and tools in `lib/agent/tools/` to read the shared inventory,
recipes, sales aggregates, supplier data, and deliveries. Gemini generates
indicative drink-demand estimates from the sales summary; TypeScript validates
the estimates and computes ingredient requirements, shortfalls, and totals.
Forecasts may use synthetic sales history and are not purchasing guarantees.
The chat dock also supports optional voice chat in browsers with Web Speech API
support. Select **Enable voice** to grant microphone access, then say “Brewly”
to hear the greeting and ask a question aloud. Voice listening can be turned
off at any time and is not started until enabled.

The agent can save draft orders and record explicitly owner-reported wastage or
deliveries, and can record explicitly owner-reported completed sales. Tool calls and outcomes are recorded in `agent_activity`. Purchases, supplier contact or switches, and price changes create approval
items. Legacy `standing_rules` and `rules` decision-limit records do not
authorize or approve orders. The Settings page manages the café reorder and
spend policy and can generate a simulated brief for another date. Human
approval never places or sends an order. Activity records both agent actions
and approval decisions. `GEMINI_MODEL` selects the Gemini model and defaults
to `gemini-3.5-flash-lite`; a rejected model ID is reported clearly.

The server checks `AGENT_PASSCODE` once at the workspace lock screen and
issues an httpOnly, sameSite signed session cookie that expires after 12 hours
(with the Secure attribute enabled in production). Agent, settings, brief, and
activity API requests require that cookie, and the navigation provides logout.
Login attempts are rate limited. Keep `AGENT_PASSCODE`,
`GOOGLE_GENERATIVE_AI_API_KEY`, and Supabase server credentials in deployment
environment settings; never put their values in source or browser storage.

### POS sales webhook

`POST /api/pos/sales` accepts signed JSON with `external_ref`, ISO `occurred_at`,
and `items` containing recipe `product_name` and integer `quantity` fields.
Sign the exact request body with HMAC-SHA256 and send it as
`x-pos-signature: sha256=<hex-digest>`. The endpoint requires
`POS_WEBHOOK_SECRET`, limits requests to 64 KB, and records an event and its
stock movements transactionally. Reusing an event reference with a different
payload is rejected; retrying the same payload does not deduct stock again.
This endpoint depends on the prepared Brewly automation migration below; it is
not ready for live POS traffic until that migration is validated and installed.
The hourly demo simulator is deferred because the current historical sales
table contains dates and weekdays but no hour-of-day data.

Automatic stock thresholds are recalculated by
`GET /api/automation/thresholds` with `Authorization: Bearer <CRON_SECRET>`.
Configure a weekly scheduler only after confirming the deployment plan supports
the required schedule. Recipe/supplier change hooks remain part of later workstreams.

The first Brewly automation migration,
`supabase/migrations/20261116_brewly_automation.sql`, has been applied to the
project's Supabase database. It does not establish a physical stock baseline;
review existing inventory quantities and minimums separately before relying on
automated thresholds or orders.

### Delivery automation (Workstream C)

The local `supabase/migrations/20261117_brewly_delivery_cycle.sql` migration
adds supplier-specific arrival windows, deterministic simulated arrival
tracking, overdue followups, and support for receipt-free chases in the
existing `cafe_test_mail` queue. Its deployment status has not been
independently verified here. Check it against the exact Supabase schema before
relying on Workstream C. The migration passed isolated PostgreSQL syntax and
repeatability and partial-versus-final receipt regression checks against
stubbed prerequisites; those checks do not prove compatibility with the live
schema.
The delivery cycle requires `cafe_settings.email_mode = 'test'`; its messages
are queued only to `.invalid` test addresses and are never sent through Resend.

`GET /api/automation/deliveries` is protected by
`Authorization: Bearer <CRON_SECRET>` and remains disabled unless
`DELIVERY_AUTOMATION_ENABLED=true`. No scheduler is configured. Set supplier
arrival windows in Settings before enabling the cycle; missing
windows do not create receipts. The deliveries page surfaces exceptions and
owner decisions while keeping routine incoming deliveries collapsed. Manual
receipt entry remains available per delivery.

### Owner communication (Workstream E)

The local `supabase/migrations/20261119_brewly_owner_communication.sql`
migration adds rush-aware owner notifications, digest deduplication,
automation-cycle status, and one-time approval-link storage. Its deployment
status has not been independently verified here. Confirm it against the live
Workstream D schema before relying on these features.

`GET /api/owner/status` supplies the authenticated chat-dock status.
`GET /api/automation/owner-digest` requires `Authorization: Bearer
<CRON_SECRET>` and remains disabled unless `OWNER_DIGEST_ENABLED=true`.
Configure `APP_URL` as the deployed HTTPS origin and
`OWNER_APPROVAL_TOKEN_SECRET` as a random secret of at least 32 characters
before enabling digests. Approval and edit links are HMAC-signed, expire after
24 hours, and are consumed only by form submission; opening a link does not
change an approval. Digests use the existing test-mail queue, so delivery
remains controlled by the test-mail settings. No scheduler is configured for
the digest or mail queue.

### Consolidation and production controls (Workstream F)

The primary navigation is Today, Stock, Deliveries, Activity, and Settings;
the old Automation route redirects to Settings > Autonomy. Ordering uses
`cafe_reorder_rules` and `cafe_spend_policy` as its policy source. Legacy
`standing_rules` are display-only and cannot approve requests; no legacy tables
or rows are dropped. Older generic `rules` decision limits are also not used
for ordering authorization.

Production inventory and order writes require `INVENTORY_WRITES_ENABLED=true`.
In non-production environments writes remain enabled for development. POS
sales still require the webhook HMAC, scheduled automation still requires
`CRON_SECRET`, and interactive mutations require the signed workspace
session. Do not enable production writes until the applicable database setup
and deployment configuration have been verified.

Run `npm test` for focused Vitest coverage of stock thresholds, reorder-policy
eligibility, delivery tolerance, quiet-window deferral, and POS payload
idempotency. The sales simulator remains unavailable because historical data
does not contain hour-of-day values; the app does not invent an hourly pattern.

### Supabase setup

The existing database already contains `ingredients`, `recipes`, `inventory`,
`inventory_movements`, `incoming_deliveries`, `delivery_receipts`,
`draft_orders`, and `supplier_prices`. Its receipt ledger uses `amount` and
`created_at`; sales are in `"Historical Sales Data"` with ISO text dates and
`quantity_sold`. Do not rerun `inventory-feature.sql`,
`automated-ordering-drafts.sql`, or `automated-ordering-demo-data.sql` on that
database, and do not run `agent-read-only-tools.sql` (it creates a conflicting
receipt schema and seeds synthetic sales).

For that existing schema, run these scripts manually in the Supabase SQL
Editor, in order:

1. `supabase/agent-existing-schema-setup.sql` — creates the missing activity
   and approval tables, adapts the legacy receipt read columns, and exposes
   existing historical sales through a `sales_history` compatibility view.
   It does not seed sales, inventory, suppliers, or deliveries.
2. `supabase/agent-write-tools.sql` — adds guarded agent inventory functions.
3. `supabase/agent-first-app.sql` — adds daily briefs, holidays, chat, standing
   rules, memory, and the approval-decision function.
4. `supabase/agent-legacy-receipt-write.sql` — replaces the generic receipt
   writer with one that fills the existing receipt ledger's required columns.

The sample sales rows supplied during setup were dated 2025-12-30 and
2025-12-31. Check the full history's latest date before relying on forecasts;
the application can report sufficient history by span even if that history is
old. No SQL script in this sequence is applied automatically, and no
auto-approval rules are seeded.

### Legacy forecasting code

The `ML/` directory still contains the prior Python/FastAPI and model artifacts,
including `ML/api.py`, `ML/data/`, the synthetic CSV, `ML/forecast_model.joblib`,
and `ML/agent_forecast_table.json`. `app/api/recommendations/route.ts` is also
an older recommendation route. They are intentionally retained pending review;
the Gemini agent does not call the Python service.

### Inventory operations integration

The sales and delivery pages now share the signed workspace session and agent
stock data. See [INTEGRATION_SETUP.md](INTEGRATION_SETUP.md) before installing
`supabase/inventory-agent-integration.sql` on an existing database. The migration
unifies original ordered quantity and receipt-derived outstanding balances;
it does not reset inventory. Today includes recorded daily operations, and the
chat tool `get_recorded_operations` reads the same data. Validation and limits
are recorded in [INTEGRATION_TEST_RESULTS.md](INTEGRATION_TEST_RESULTS.md).
