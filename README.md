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
deliveries. Tool calls and outcomes are recorded in `agent_activity`. Purchases, supplier contact or switches, and price changes create approval
items. An enabled standing rule can record approval only for a saved draft
whose ingredients, supplier, and total match the rule; otherwise a human
decision is required. Approval never places or sends an order. Activity records
both agent actions and approval decisions. The Settings page manages standing
rules and can generate a simulated brief for another date. `GEMINI_MODEL`
selects the Gemini model and defaults to `gemini-3.6-flash`; a rejected model
ID is reported clearly.

The server checks `AGENT_PASSCODE` once at the workspace lock screen and
issues an httpOnly, sameSite signed session cookie that expires after 12 hours
(with the Secure attribute enabled in production). Agent, settings, brief, and
activity API requests require that cookie, and the navigation provides logout.
Login attempts are rate limited. Keep `AGENT_PASSCODE`,
`GOOGLE_GENERATIVE_AI_API_KEY`, and Supabase server credentials in deployment
environment settings; never put their values in source or browser storage.

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
