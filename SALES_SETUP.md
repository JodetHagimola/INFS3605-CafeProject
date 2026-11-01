# Recipe-based sales recording

This add-on extends the existing Inventory Check with **Record sale**. Staff enter a drink and number sold; the database reads its recipe, deducts every ingredient together, and records the sale and stock movements. It uses the existing recipes, ingredients, inventory, and inventory_movements tables. It does not import historical sales or reset stock.

## Install in Codespaces

1. Upload `inventory-sales-feature.zip` into the project root (the folder containing `package.json`). In the terminal, run:

   ```bash
   unzip inventory-sales-feature.zip
   python3 inventory-sales-feature/install-in-codespace.py
   ```

   The installer adds new files, inserts a Record sale navigation link, and fixes the original inventory date-format hydration issue if that old expression is still present. Modified existing files get `.before-sales.bak` backups. Existing custom date fixes are preserved. If a new feature file already exists with different content, installation stops before modifying anything.

2. Open `supabase/inventory-sales.sql`, copy its complete contents into the **same Supabase project's SQL Editor**, and run it. The earlier inventory feature SQL must already be installed. This migration creates two sales tables and one database function; it enables RLS and does not change current stock values.

3. Keep the existing server-only `SUPABASE_URL` and `SUPABASE_SECRET_KEY` configuration. Do not commit `.env.local` or paste keys into client code. No new packages are required. Start the existing project:

   ```bash
   npm run dev
   ```

   Use the private forwarded development URL, open Inventory, and click **Record sale**. Keep existing working Codespaces origin settings. If Server Actions show an origin error, inspect the terminal rather than changing database permissions.

## Demonstrate the feature

Only record sales that you intend to deduct. For a controlled demo, agree the test stock with the team first.

With Milk at 20,000 ml and Coffee Beans at 3,000 g, recording **Latte / 2** using the supplied recipe should show:

| Ingredient | Before | Used | After |
| --- | ---: | ---: | ---: |
| Milk | 20,000 ml | 440 ml | 19,560 ml |
| Coffee Beans | 3,000 g | 36 g | 2,964 g |

Click **View updated inventory**. The existing threshold logic uses the new quantities. Five lattes in total consume 1,100 ml milk and 90 g beans; milk becomes 18,900 ml and is Low stock when the minimum is 19,000 ml.

The product list and usage preview come from database recipes, not hard-coded demo drinks. Recipe quantities must use the same units as the corresponding ingredient stock. For example, milk is stored and deducted in ml. Keep one recipe row per product and ingredient.

## Retry and corrections

- A confirmed sale has a unique reference and a receipt. **Record another sale** deliberately creates a new reference and deducts stock again.
- If the response is uncertain, use **Retry same sale**. The pending reference survives a reload in the same browser tab. Retrying that reference returns the original saved result without another deduction.
- Do not clear the tab's session storage or start the same sale in another tab to bypass an uncertain result. Check Recent sales first.
- Do not record the same sale again as manual ingredient usage. Deliveries and waste remain separate manual stock operations.
- There is no sale reversal button in this version. If a mistake is confirmed, agree and record a traceable stock correction through the existing stock workflow; do not delete audit records. A historical receipt shows stock at the time of that sale, not today's stock.
- Sales history shows UTC explicitly; the inventory page continues to use Sydney time.

## Boundaries

This is the first sales-to-recipe integration milestone. Sales entry remains manual: it is not connected to a live POS or sensors. Recipe-based deduction estimates stock; physical counts are still needed for waste, spills, or measurement differences.

The add-on retains the project's development-only write restriction. Vercel production remains read-only until staff authentication and server-side authorization are added to both inventory and sales mutations. This package does not enable public stock writes. The AI agent can read updated inventory on a later run; recording a sale does not automatically run the agent or place supplier orders.

## Changes to commit

Review and commit the new `app/inventory/sales/`, `lib/inventory-sales/`, `supabase/inventory-sales.sql`, `tests/inventory-sales.test.mjs`, and this guide, plus the small changes to `app/inventory/page.tsx` and (if patched) `app/inventory/inventory-panel.tsx`.

Exclude the ZIP, extracted installer folder, `.before-sales.bak` backups, and secret files. No dependency or package-lock changes are needed for this add-on.

## Validation completed before packaging

- Full supplied project compiled with the new sales route.
- Input validation and deterministic formatting tests passed.
- Local PostgreSQL-compatible PGlite checks passed for recipe deductions, saved recipe snapshots, duplicate-reference replay, invalid inputs, insufficient stock, missing inventory, rollback after a forced partial failure, role restrictions, and stale manual-update rejection.
- Browser checks using a separate synthetic database passed for saving sales, retrying after reload, insufficient stock, and low-stock status after deductions.
- These checks did not connect to or modify the team's live Supabase database. PGlite serializes connections; true multi-session concurrency and the team's deployed environment still require integration testing.

Run the dependency-free input/format tests from the project root with Node 22.18+:

```bash
node --test tests/inventory-sales.test.mjs
```
