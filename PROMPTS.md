# Task: Turn Brewlytics into an agent-first app

## Context
Brewlytics is a café inventory management web app (Next.js + TypeScript, Supabase). The primary user is a small café owner who currently counts stock, estimates how much to order and phones suppliers by hand.

We already have an "Automated Ordering" feature: the page at app/automated-ordering/page.tsx and its API route recommend order quantities based on forecasted demand, recipes and current inventory in Supabase. Demand forecasting is now done by our Gemini agent itself rather than a separate machine learning model.

We have a Google AI Studio (Gemini) API key in GOOGLE_GENERATIVE_AI_API_KEY and a shared passcode in AGENT_PASSCODE (both in .env.local and Vercel). Never print, log, hardcode or commit these values, and do not edit .env.local.

## Goal
Streamline the site and turn our separate features into tools that a single Gemini-powered agent can call, so the owner doesn't have to step in to confirm routine things. The agent runs server-side, and a person stays in charge of anything involving money or outside parties.

## Step 0: Inspect first, do not change anything yet
1. Read the repo structure, package.json, existing pages, API routes and Supabase usage.
2. Check which AI SDK and agent code are already installed or written. If none, use the Vercel AI SDK (`ai` and `@ai-sdk/google`) with Gemini, since it reads GOOGLE_GENERATIVE_AI_API_KEY by default and supports tool calling.
3. Identify any leftover code from the old Python/ML forecasting setup (e.g. the ML folder, FastAPI server, old API routes). List it, but do not delete anything without my approval.
4. Reply with a short plan: files you will add or change, files you will remove or merge, and any risks. Wait for my approval before editing.

## Architecture
- One agent endpoint: app/api/agent/route.ts (server-side only).
  - Requires the passcode on every request (compare against process.env.AGENT_PASSCODE on the server, return 401 if wrong; never expose it to the client or bundle it).
  - Uses Gemini with tool calling and a multi-step loop (set a sensible max step count, e.g. 8).
  - Has a system prompt that defines its role, the action tiers below, and its boundaries.
- Put each tool in its own file under lib/agent/tools/, with zod-validated inputs, and register them in one place.
- Log every tool call and result to an `agent_activity` table in Supabase (timestamp, tool, input summary, outcome, reason).

## Tools (wrap existing logic; don't rewrite what already works)
Tier 1, act silently (read-only):
- get_inventory: read current stock levels
- get_recipes: read recipes and ingredients
- get_sales_summary: read historical sales data and return aggregates computed in code (e.g. average units per product by day of week and month, recent trend, public-holiday effects), so Gemini reasons over summaries instead of doing arithmetic on raw rows
- forecast_demand: the agent produces predicted sales per product for a requested date or period from the sales summary. It must show its assumptions, give a low/expected/high range, and say so if there is too little history instead of guessing. Predictions are whole numbers of drinks.
- calculate_shortfalls: required ingredients (forecast x recipe quantities) minus stock minus incoming deliveries, computed in code, never negative
- compare_supplier_prices: read supplier price, delivery time and minimum order data
- check_deliveries: compare ordered vs delivered quantities and flag discrepancies

Tier 2, act and tell the owner (low risk, reversible):
- save_draft_order: write a draft order with status "draft", line items, recommended supplier, reasoning and flags
- log_wastage: record wasted or perished stock
- record_delivery: log what actually arrived

Tier 3, ask first (add to an approval inbox, never execute directly):
- Anything that places or sends an order, contacts a supplier, switches supplier or changes prices. The agent may only create an inbox item with status "pending_approval". Only a human clicking Approve in the UI can move it forward.
- Optional standing rules: a `standing_rules` table (e.g. "auto-approve restocks of milk under $200 from usual supplier"). If an action is inside a rule, the agent may proceed; otherwise it goes to the inbox.

All arithmetic (unit conversions, requirements, shortfalls, totals) must happen in TypeScript code inside the tools, not in the model's head.

## Boundaries (put these in the system prompt AND enforce them in code)
- Never place or send an order, or mark one approved/sent.
- Never delete or overwrite inventory, recipes, supplier prices or existing orders (record_delivery and log_wastage only append or adjust through defined functions).
- Never invent numbers, suppliers or prices. If data is missing or stale, say so and flag it.
- Never recommend negative quantities.
- Stop and flag if: there isn't enough sales history to forecast, inventory data is missing, no supplier price exists for a short item, or an order is more than 2x the forecast requirement.
- State that forecasts are AI estimates based on the available sales history (currently synthetic data), so they are indicative only.
- Flag for the owner: stock that doesn't match expected usage, overdue deliveries, public holidays, perishables that may expire before use, single or no supplier for an item.

## Website streamlining
Reduce the site to these pages, reusing existing components and styling:
1. Today (home): the agent's brief, covering low stock, arriving deliveries, the recommended draft order, and items needing attention. Includes a "Run check" button that calls the agent.
2. Inbox: pending approvals and flags, with Approve / Edit / Reject.
3. Chat: a simple chat box to ask the agent things like "what do I need for the long weekend?"
4. Activity: log of what the agent did and why.
5. Settings: passcode entry for the agent, standing rules.
Merge or remove old standalone pages only after the agent equivalent works. Keep navigation minimal. Show structured results in tables and summary cards, not raw text (have the agent return structured JSON for drafts, validated with zod).

## Supabase
List any tables you need that don't exist yet (e.g. sales_history, supplier_prices, incoming_deliveries, draft_orders, agent_activity, standing_rules) and give me the SQL to create them, plus seed data for a demo. Don't run migrations without telling me. Use the same inventory table as the existing Inventory Tracking feature so stock stays consistent.

## Working rules
- Work in small phases, and after each phase tell me what changed and how to test it:
  1. Plan (Step 0)
  2. Agent route + passcode check + read-only tools (including forecast_demand)
  3. Draft order tool + activity log
  4. Approval inbox + Tier 3 handling
  5. Page streamlining and UI
  6. Standing rules (only if time allows)
- Keep TypeScript strict, handle errors, and don't add dependencies without telling me.
- Add a short README section explaining the agent, its tools and its boundaries.