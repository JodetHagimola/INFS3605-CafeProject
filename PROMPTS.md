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


# Task: Rebuild Brewlytics as an agent-first, proactive app

## Why this rebuild
Our course feedback says: (1) hand more of the business process to the agent instead of keeping humans in the loop for everything, (2) design around a small business owner's day and add no friction, (3) show abstracted briefings, not busy dashboards, (4) have a clear design identity and story.

The key test for agentic AI: if the human still has to notice the problem, start the AI, check the output and carry out the action, the AI is a tool and the human is still doing the process. Right now Brewlytics is a tool: the owner must enter a passcode on every page, pick a date, tick a holiday box and press "Run check". Fix that. The agent should start from an event (the owner opening the app on a new day, or a schedule), plan its own steps, act with tools, and bring the owner only the decisions that need a human.

Final test for every design decision: after this is built, does the owner's day have fewer things in it, or more?

## Context
Brewlytics is a café inventory app: Next.js + TypeScript, Supabase, deployed on Vercel, developed in GitHub Codespaces. The agent is Gemini, called server-side via the Vercel AI SDK (`ai` and `@ai-sdk/google`) using GOOGLE_GENERATIVE_AI_API_KEY. Read the model ID from an env var `GEMINI_MODEL`, defaulting to `gemini-3.6-flash`, and return a clear error if the model ID is rejected. Do not hardcode the model anywhere else. `AGENT_PASSCODE` is the shared passcode. Never print, log, hardcode or commit secrets and do not edit .env.local.

Existing pages: Today, Inbox, Chat, Activity, Settings. Existing agent route and tools already exist (inventory, recipes, forecast, shortfalls, drafts, activity log, approval inbox). Reuse what works. The forecast is now done by the Gemini agent from sales history (the old Random Forest/FastAPI model is gone), so remove any stale UI text about a "saved model".

## Step 0: Inspect first, change nothing yet
1. Read the repo: layout, pages, API routes, agent code, tools, Supabase usage, package.json.
2. Diagnose why Today shows "The required delivery_receipts data could not be read" (missing table, wrong name, permissions/RLS, or code bug) and propose a fix.
3. Reply with a short plan (files to add/change/remove, SQL needed, risks) and wait for my approval.

## 1. Authentication: enter the passcode once
- Add POST /api/auth/login that checks the passcode against process.env.AGENT_PASSCODE on the server and sets an httpOnly, secure, sameSite cookie (signed token, expires after about 12 hours). Add logout.
- Protect all /api/agent/*, brief, chat, inbox and activity routes with that cookie (middleware or a shared helper). Return 401 otherwise.
- One simple lock screen when unauthenticated. Remove passcode fields from every other page. Never store the passcode in the browser. Add basic rate limiting on login attempts.

## 2. The persistent agent chatbox (omnipresent)
- Build a global `<AgentDock />` mounted in app/layout.tsx (inside the authenticated shell) so it persists across every page navigation without remounting or losing state.
- UI: a floating launcher button bottom-right that expands into a chat panel (full-height drawer on mobile). It can be collapsed without losing the conversation. Show a small badge when the agent has something for the owner, but no pop-ups, sounds or auto-opening panels. Never interrupt.
- Streaming responses (use the AI SDK's useChat or equivalent). Show which tool the agent is using in a subtle "working..." status line.
- Persist the conversation in Supabase (`agent_threads`, `agent_messages`) so it survives refreshes and device changes. Load the last conversation on open and offer "New conversation".
- The chat is context-aware: send the current route and any visible item ID with each message so "approve this" or "why?" works on whatever the owner is looking at.
- The agent can respond with rich inline cards, not just text: approval cards (Approve / Edit / Reject buttons), a draft order summary, and a small stock table. Define a zod schema for these message parts and render them in the dock.
- Conversational data entry replaces forms: the owner can type or speak (browser speech-to-text if easy) things like "20L of milk arrived", "we binned 2L of milk", "oat milk supplier is changing to X". The agent calls the right tool (record_delivery, log_wastage, etc.) and confirms in one line.
- Remove the separate Chat page. The dock replaces it.

## 3. Proactive daily brief (the heart of the app)
Trigger: when the owner opens the app on a new day (first authenticated load after the café's local midnight, Australia/Sydney time), or when generated by a schedule. If a brief for today exists in `daily_briefs`, show it instantly; otherwise generate it, showing a calm loading state, and cache it.

Optional: add a Vercel Cron route (e.g. /api/cron/brief, protected by CRON_SECRET) that pre-generates the brief before opening time, so it is ready when the owner arrives. Note that cron schedules are in UTC.

The brief is produced by a multi-step Gemini agent run (max about 10 steps) that decides for itself what to look at. Expected steps: gather inventory, incoming and overdue deliveries, recipes, sales history and supplier data; work out the date, day of week and whether it is a public holiday (use a `public_holidays` table for NSW, seeded by you, not a checkbox the owner has to tick); forecast demand for the next few days; compute shortfalls; compare suppliers; check for anomalies (stock not matching expected usage, delivery shorter than ordered, perishables at risk); then decide what to do about each finding using the action tiers below.

Do all arithmetic (unit conversions, requirements, shortfalls, totals, cost comparisons) in TypeScript inside tools, never in the model's head. Give the model aggregates like `get_sales_summary`, not thousands of raw rows.

Brief output (validate with zod, store in `daily_briefs`):
- greeting + a one-line status, e.g. "Good morning. 3 things today. Everything else is on track."
- `items`: at most 3, ranked by urgency, each with: id, title (plain-English, one sentence), why (one short sentence), the action the agent already took, and ONE primary action button plus at most one secondary (Approve / Edit / Confirm / Dismiss). Example: "Oat milk runs out by Thursday. Order the usual? [Approve] [Edit]".
- `all_clear`: one sentence on everything that is fine.
- `details`: the full data (low-stock list, forecast table, supplier comparison, assumptions, data warnings), hidden behind a "See details" expander. Never on the front screen.
- If there is nothing needing the owner, say so and show no items. An empty brief is a good outcome.
- Optional end-of-day wrap-up generated after closing time (configurable in Settings): a short summary of what happened and what the agent has queued for tomorrow.

## 4. Autonomy tiers
- Act silently: read-only analysis (inventory, forecasts, deliveries, supplier prices).
- Act and tell: reversible low-risk actions. Saving draft orders, recording deliveries and wastage the owner reported, updating the brief. Mention them in one line ("I drafted tomorrow's milk order.").
- Ask first (one tap): anything involving money or outside parties (placing or sending an order, contacting a supplier, switching supplier, price changes). The agent only creates an approval item. Only a human tap on Approve moves it forward. The app still never sends orders itself.
- Standing rules (Settings): the owner can set rules like "auto-approve restocks of milk and beans under $200 from my usual supplier". Within a rule, the agent may record the approval itself and tell the owner. Outside it, it asks. Add a `standing_rules` table and a simple UI. Also have the agent learn the "usual order" from past approved orders and propose it as the default, so approvals are one tap.
- The agent learns from edits: if the owner edits a draft, record the pattern in `agent_memory` and use it next time (and suggest it as a standing rule when it repeats).

## 5. Boundaries (put in the system prompt AND enforce in code)
- Never place or send an order, contact a supplier, or mark an order approved or sent without a human action or a matching standing rule.
- Never delete or overwrite inventory, recipes, supplier prices or existing orders. Changes happen only through defined tools that record who/what made them.
- Never invent numbers, suppliers or prices. If data is missing or stale, say so briefly.
- Never recommend negative quantities. Stop and flag if the order is more than 2x the forecast requirement or the forecast cannot be produced.
- Forecasts are AI estimates from the available sales history (currently synthetic), so always give a low/expected/high range and never present them as certain.
- Keep technical errors off the front screen. If a data source fails (like delivery_receipts), the brief says it plainly in human terms ("I couldn't check deliveries today"), logs the technical detail in Activity, and carries on with what it has.
- Don't surface data-quality caveats as brief items unless they change what the owner should do.

## 6. Streamline the site (owner's day, no extra destinations)
- Navigation: Today (the brief, default landing page), Activity (what the agent did and why, "detail on demand"), Settings (opening/closing times, standing rules, logout). Remove the standalone Inbox page: approvals live as action cards on Today and in the dock, with a small "history" list under Activity. Keep old routes redirecting so nothing breaks.
- Remove the manual forecast date field, public holiday checkbox, prompt textbox and Run check button from Today. Keep a small "Refresh brief" link and, in Settings, a "Simulate a new day" button that regenerates the brief for a chosen date (so we can demo the proactive behaviour at the showcase).
- Reduce visual density: no grids of tiles or stat boxes on the front screen. Max 3 action cards, generous spacing, a calm tone.
- Keep the existing warm coffee-brown visual identity (serif headings, cream background) and polish it: consistent spacing, accessible contrast, good mobile layout. The experience should feel like a trusted assistant's morning note, not a dashboard.

## 7. Supabase
List the tables needed (e.g. daily_briefs, agent_threads, agent_messages, agent_memory, standing_rules, public_holidays, delivery_receipts if missing, plus existing ones) and give me the SQL to create them with sensible indexes, plus seed data that makes the demo brief interesting (a low-stock item, a short delivery, a public holiday this week, an overdue delivery). Don't run migrations without telling me. Use the same inventory table as the Inventory Tracking feature. Server routes use the service-role key only on the server.

## 8. Acceptance tests (check these before telling me you're done)
- Opening the app on a new day shows a brief automatically with no clicks and no passcode re-entry after the first login.
- The brief shows 3 or fewer items, each with exactly one primary action.
- The chat dock is visible on every page, keeps its conversation when navigating, and survives a refresh.
- Typing "20L of milk arrived" in the dock updates inventory through the tool and confirms in one line.
- Approving an item from the brief or the dock records the decision and logs it in Activity. Nothing is ever sent externally.
- A failing data source never shows a raw error on Today.
- No secret appears in client code, logs or the repo.

## Working rules
Work in phases and tell me what changed and how to test it after each:
1. Plan + diagnose delivery_receipts (Step 0)
2. Auth cookie + remove per-page passcodes
3. Brief generation (agent loop, zod schema, daily_briefs cache) + new Today page
4. Persistent AgentDock with streaming, persisted threads and inline action cards
5. Approvals flow + standing rules + learning from edits
6. Streamlined navigation, visual polish, cron pre-generation, wrap-up if time allows

Keep TypeScript strict, handle errors, and don't add dependencies without telling me. Add a README section explaining the agent, its tools, tiers and boundaries.


# Task: Refine Brewlytics UI so it feels rounded, soft and inviting, with smooth motion

This is a visual and interaction polish pass only. Do not change agent logic, API routes, database code, auth behaviour or the data shown. Keep the existing colour palette (cream background, coffee-brown accents, dark brown text). Don't introduce new brand colours; only add tints, shades and shadows derived from the existing ones.

## Step 0: Inspect first, change nothing yet
1. Read the current styling approach (global CSS, Tailwind config, CSS modules, components) and find where the colours, fonts, borders and radii are defined.
2. Extract the existing palette and fonts into a single set of design tokens (CSS variables) if they aren't already, and show me the list.
3. Reply with a short plan (files you'll touch, any dependency you'd like to add and why). Prefer CSS-only animation. Don't add a dependency without asking. Wait for my approval.

## 1. Softer, rounder visual language
Problems to fix: the dark 2px brown rules along the top of cards and sections feel harsh, form inputs and textareas have sharp corners, and thin dividers look rigid.
- Replace the heavy top-border rules with soft cards: generous radius (16-24px for cards, 12px for inputs, pill shape for buttons and badges), a faint tinted border at low contrast (e.g. brown at 8-12% opacity) and a gentle layered shadow (large blur, low opacity, warm brown tint rather than grey/black).
- Inputs, textareas, date pickers and selects: rounded, slightly tinted fill, soft border, comfortable padding. On focus show a soft brown glow ring (not a harsh outline) that is still clearly visible for accessibility (WCAG AA contrast).
- Dividers and underlines: remove or replace with spacing, subtle tinted separators, or soft background shifts. No full-width hard lines between sections.
- Navigation: soft bottom edge (a subtle shadow or very faint border), a rounded pill highlight behind the active tab, and a smooth hover state. Slightly translucent, blurred sticky header is fine.
- Badges, counters and status chips: pill-shaped with soft tinted backgrounds.
- Warning/notice blocks (e.g. the peach boxes): rounded, softly tinted, no hard left bars unless it's an accent with rounded ends.
- Typography: keep the serif headings and existing fonts. Improve spacing, line height and hierarchy so pages feel calmer and less cramped. Add more whitespace.
- Buttons: pill-shaped, soft shadow, gentle hover lift (translateY -1px and a slightly stronger shadow) and press state (scale 0.98). Secondary buttons use a soft tinted fill instead of a harsh outline.
- Consistent spacing scale and radius scale across every page and the chat dock. Make sure it looks good on mobile (touch targets at least 44px) and on wide screens.
- The persistent chat dock: rounded panel (large radius), soft shadow, rounded message bubbles (user vs agent clearly distinguished with palette tints), rounded input with a send button, and a smooth, friendly launcher button.

## 2. Page transitions
- Add smooth transitions between routes. In the Next.js App Router, use app/template.tsx with a short enter animation (fade plus slight upward slide, about 250-350ms, ease-out) so each page eases in. Wrap it in a client component if needed.
- Stagger the entrance of cards and list items on a page (each about 40-60ms after the previous, short and subtle).
- Optionally use the View Transitions API progressively where supported, with a clean fallback. Don't build a fragile hack for exit animations.
- Show a slim, soft top-of-page progress bar during route navigation (build it yourself; no heavy library).
- The persistent chat dock must not re-animate or flicker on navigation.

## 3. Loading indicators and feedback for every async task
Add a consistent, friendly loading pattern with reusable components (e.g. `<Spinner />`, `<Skeleton />`, `<LoadingButton />`, `<InlineStatus />`):
- Passcode validation (login/lock screen): the button shows an inline spinner, switches to "Checking..." and is disabled while the request runs. On success, a quick success tick then a smooth transition into the app. On failure, a gentle shake of the field plus a soft inline error message (no harsh red blocks; use a warm, readable tone). Keep the focus in the input.
- Generating the daily brief: show skeleton cards in the shape of the real action cards, with a calm status line that updates as the agent works (e.g. "Checking stock...", "Looking at deliveries...", "Forecasting demand..."). If the app already streams tool status, use it; otherwise use friendly staged text. Fade the real content in over the skeletons.
- Chat dock: a typing indicator (three softly pulsing dots) while the agent is thinking, subtle tool-status text while it works, and smooth streaming of text with new messages sliding up and fading in. Auto-scroll smoothly.
- Approve / Reject / Save / Edit buttons: inline spinner on press, then a brief success state (tick, soft green-tinted, no new brand colour needed; derive from the palette) before the card gracefully collapses or updates. Disable duplicate clicks.
- Lists and tables (Activity, history): skeleton rows while loading and a friendly empty state with a small illustration or icon and one calm sentence ("Nothing here yet.").
- Settings actions: same loading button behaviour.
- Never leave a blank screen or a frozen button with no feedback. Anything over about 300ms should show feedback.

## 4. Micro-interactions
- Cards lift slightly and gain a deeper shadow on hover (desktop only).
- Chat dock opens and closes with a smooth scale and fade from the launcher button (about 200-250ms), with the launcher having a gentle idle state and a soft badge pulse when the agent has something new (one gentle pulse, not endless).
- Dismissed or completed action cards collapse smoothly (height and opacity), and the cards below slide up.
- Numbers or statuses that change should fade rather than snap.
- Use consistent timing tokens: fast 150ms, base 250ms, slow 400ms, with a soft ease-out/ease-in-out curve.

## 5. Accessibility and performance (required)
- Respect `prefers-reduced-motion`: when set, disable transforms and long animations and keep only simple instant or opacity changes.
- Animate only transform and opacity where possible, keep animations GPU-friendly and avoid layout thrash. No animation should block interaction or delay content by more than about 300ms.
- Keep text contrast at WCAG AA or better, visible keyboard focus states, and aria attributes for loading states (`aria-busy`, `aria-live="polite"` on status text, spinner labels).
- Don't hurt Lighthouse performance noticeably. No large images or heavy libraries.

## 6. Acceptance checks (verify before saying you're done)
- No hard 2px dark rules remain across cards or sections, and no sharp-cornered inputs remain on any page.
- Every page eases in on navigation, the top progress bar appears during route changes, and the chat dock stays stable.
- Passcode validation shows a spinner, a success transition and a gentle shake on failure.
- The brief shows skeletons and friendly status text while generating, then fades into the real content.
- All buttons that trigger async work show a loading state and prevent double-clicks.
- Reduced-motion mode works. The site looks good and is usable at 375px wide and at desktop width.
- Colours are unchanged in character (same cream, browns and text colours as before).

## Working rules
Work in phases and tell me what changed and how to check it after each:
1. Plan and design tokens (Step 0)
2. Global styles: cards, inputs, buttons, nav, dividers, badges
3. Chat dock restyle
4. Page transitions and the route progress bar
5. Loading components and their integration (login, brief, chat, approvals, lists)
6. Micro-interactions, reduced-motion handling, mobile and accessibility pass

Keep TypeScript strict, keep changes visual only, and show me before/after summaries per page.