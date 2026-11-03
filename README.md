# INFS3605-Project-Repo
Our repo for our centralised AI inventory management system for cafes

Simone - Project Owner 

Jodet - Dev | Backend and database design

Siqi - Dev | Business analysis

Itisha - Scrum Master 

Dinkal - Dev | UX Design

## Brewlytics agent

The server-side Gemini agent is available from **Today** and **Chat**. It uses
the Vercel AI SDK and tools in `lib/agent/tools/` to read the shared inventory,
recipes, sales aggregates, supplier data, and deliveries. Gemini generates
indicative drink-demand estimates from the sales summary; TypeScript validates
the estimates and computes ingredient requirements, shortfalls, and totals.
Forecasts may use synthetic sales history and are not purchasing guarantees.

The agent can save draft orders and record explicitly owner-reported wastage or
deliveries. Tool calls and outcomes are recorded in `agent_activity`. Purchases,
supplier contact or switches, and price changes can only create pending inbox
items. Approving an inbox item records a human decision; it does not place or
send an order. The server checks `AGENT_PASSCODE` on every agent, inbox, and
activity request. Keep `AGENT_PASSCODE`, `GOOGLE_GENERATIVE_AI_API_KEY`, and
Supabase server credentials in deployment environment settings; never put
their values in source or browser storage.

### Supabase setup

The application uses the existing `ingredients`, `recipes`, and `inventory`
tables; inventory is not duplicated. The agent setup also needs:

- `sales_history`, `delivery_receipts`, `agent_activity`, and `approval_inbox`
  from `supabase/agent-read-only-tools.sql`.
- `draft_orders` from `supabase/automated-ordering-drafts.sql`.
- `supplier_prices` and `incoming_deliveries` from
  `supabase/automated-ordering-demo-data.sql`.
- `agent_inventory_actions` and guarded inventory movement/receipt functions
  from `supabase/agent-write-tools.sql`.

Run SQL manually in the Supabase SQL Editor, in this order, after confirming
the base inventory schema is already installed:

1. `supabase/automated-ordering-drafts.sql`
2. `supabase/automated-ordering-demo-data.sql`
3. `supabase/agent-read-only-tools.sql`
4. `supabase/agent-write-tools.sql`

`supabase/agent-read-only-tools.sql` seeds synthetic demo sales for existing
recipe products. The supplier and delivery rows in the demo-data script are
illustrative only. Replace demo prices and suppliers with verified café data
before using recommendations. These scripts are not applied by the app or by
the build. No standing auto-approval rules are enabled.

### Legacy forecasting code

The `ML/` directory still contains the prior Python/FastAPI and model artifacts,
including `ML/api.py`, `ML/data/`, the synthetic CSV, `ML/forecast_model.joblib`,
and `ML/agent_forecast_table.json`. `app/api/recommendations/route.ts` is also
an older recommendation route. They are intentionally retained pending review;
the Gemini agent does not call the Python service.
