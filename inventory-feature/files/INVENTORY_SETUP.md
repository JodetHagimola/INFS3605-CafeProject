# Inventory Check Setup Guide

This package adds an `/inventory` page to the existing Next.js and Supabase project. It includes stock levels, ingredient search, status filters, and forms to record usage, waste, and confirmed deliveries. It uses your existing data and does not generate sample inventory or overwrite current quantities during installation.

Stock quantities are recorded values, not automatic measurements of physical stock.

## 1. Create a feature branch

Open your Codespace and select Terminal > New Terminal. Work from the project root, where `package.json` and the `app` folder are located.

```bash
git status
git switch -c inventory-check
```

If that branch already exists, use `git switch inventory-check`. Preserve any existing uncommitted work. Start from the development base agreed with your team.

## 2. Upload and install the files

Download `inventory-feature.zip` from the chat. Upload the ZIP to the project root in the Codespaces Explorer, beside `package.json`. Run:

```bash
unzip inventory-feature.zip
python3 inventory-feature/install-in-codespace.py
```

The installer adds new files only. If a destination file already exists with different content, it stops before copying anything. Reinstalling identical files is safe.

```text
app/inventory/page.tsx                 Inventory page entry point
app/inventory/inventory-panel.tsx      Search, filters, and stock change forms
app/inventory/inventory.module.css     Page-specific styles
app/inventory/actions.ts               Server-side validation and updates
lib/inventory/model.ts                 Stock status and input validation
lib/inventory/server.ts                Server-side database queries
supabase/inventory-feature.sql         One-time database setup
tests/inventory.test.mjs               Status and input validation tests
INVENTORY_SETUP.md                     This guide
```

If you already extracted an older package, extract this updated ZIP into a separate temporary folder to avoid confusing the two versions. If the installer reports a conflict only in `INVENTORY_SETUP.md`, compare the files and manually replace the old guide with this English version. Preserve any other locally edited files.

## 3. Configure the database

Inventory queries require a nullable numeric `minimum_stock` column in `public.inventory`. If you have already added it, do not create a second column.

Saving stock changes also requires the supplied database function. Complete the following steps in the team's demo Supabase project, or ask the team member responsible for the database to do so:

1. Open `supabase/inventory-feature.sql` in Codespaces and copy its full contents.
2. Open the correct Supabase project, select SQL Editor, and create a query.
3. Paste the script and run it.
4. Confirm that it completes successfully.
5. In Table Editor > inventory, enter agreed demo thresholds for the existing ingredients. Each threshold uses the unit stored in `ingredients.unit`.

The script adds the minimum stock column if it is missing, creates an `inventory_movements` table, and defines `record_inventory_movement`. It does not change existing stock quantities, orders, or the `rules` table. It validates existing thresholds; a negative or invalid threshold causes the setup transaction to roll back so the data can be corrected first.

The movement log stores the ingredient ID, operation, amount, previous quantity, resulting quantity, reason, and timestamp. This starter project has no staff login, so the log does not identify or authenticate the person making a change.

The database function locks the inventory row, checks that the submitted timestamp is current, updates stock, and writes the log in one transaction. It rejects excessive deductions and stale submissions. Execution is granted only to the server-side `service_role`.

## 4. Configure the connection and start the app

If the existing Orders page already connects successfully, reuse the current environment variables. Otherwise, an authorized team member should configure `.env.local` in the project root:

```dotenv
SUPABASE_URL=your-project-url
SUPABASE_SECRET_KEY=your-server-side-secret-or-service-role-key
```

Keep real keys out of chat, client components, and Git. Do not prefix the secret with `NEXT_PUBLIC_`. Check that `.env.local` is ignored:

```bash
git check-ignore .env.local
```

Install the team's locked dependencies and start the app:

```bash
npm ci
npm run dev
```

If a development server is already running, stop it with Ctrl+C before restarting. Restart after changing environment variables.

In the Codespaces Ports panel, use Open in Browser for the running port, usually 3000. Keep the full forwarded domain and change the URL path to `/inventory`:

```text
https://your-codespaces-preview-domain/inventory
```

Keep the port visibility set to Private. The starter project uses a server-side key and has no staff login. Inventory writes in this implementation are enabled only in development mode (`npm run dev`); production mode rejects them. Codespaces private-port access is not an application-level staff authorization system. Add authentication and authorization before public deployment. Screen sharing can be used for the team demo.

## 5. Verify the feature

Use data that the team has agreed can be changed during the demo. The quantities below are examples, not assertions about your database.

1. Set up a demo ingredient such as Milk with 12 L in stock and a minimum of 5 L. It should display In stock.
2. Select Update on that row. In the form below the table, choose Used, enter 8, and provide a reason such as Morning service.
3. Save. Stock should become 4 L, the status should become Low stock, and a success message should appear.
4. Reload the page. Stock should remain 4 L, and `inventory_movements` should contain a 12-to-4 entry.
5. Search for milk and check the matching results. Needs replenishment should include both low-stock and out-of-stock ingredients.
6. With 4 L remaining, an attempted deduction of 5 L must be rejected. Negative, zero, and blank movement amounts must also be rejected.
7. Received adds the amount entered. Used and Wasted subtract it. These actions do not set the remaining total to the entered value.
8. A null threshold should display Threshold not set. A missing inventory record should display No stock record, not zero or sufficient stock.
9. Open the same ingredient in two tabs. Save a change in the first tab, then submit the old form in the second. The second submission should be rejected until the user refreshes and checks the new stock.

Run a production build check:

```bash
npm run build -- --webpack
```

Run the logic tests with Node 22.18+ or Node 24:

```bash
node --test tests/inventory.test.mjs
```

A successful build does not prove that the real Supabase connection works. Complete the read/write checks in your own Codespace.

## 6. Add a navigation link

In the existing `app/page.tsx`, add a link in the appropriate navigation or topbar location:

```tsx
<a href="/inventory">Inventory</a>
```

Do not replace a teammate's updated page with an older copy. You can also use `/inventory` directly until the team adds the navigation link.

## 7. Commit the feature

After verification, inspect and commit only the relevant files:

```bash
git diff
git status --short
git add app/inventory lib/inventory supabase/inventory-feature.sql tests/inventory.test.mjs INVENTORY_SETUP.md
git commit -m "Add inventory check and stock movement feature"
git push -u origin inventory-check
```

If you added the navigation link, review and stage `app/page.tsx` separately. Do not commit the ZIP, extracted installer folder, or `.env.local`. Create a pull request for team review rather than replacing the main branch directly.

## Troubleshooting

| Message or situation | Check |
|---|---|
| Inventory could not be loaded | Environment variables, permissions, table names, and the minimum_stock column |
| Stock displays but cannot be saved | SQL setup completion and server key permissions |
| Threshold not set | Set minimum_stock for that ingredient; null is not zero |
| No stock record | Add a valid inventory row for that ingredient_id |
| Stock has changed | Refresh, inspect the current quantity, and re-enter the intended change |
| No ingredients appear | Check the ingredients table and active filters |
| Updates disabled in production | Use the private development demo; implement staff authorization before enabling production writes |

## Implementation and verification scope

Ingredients and inventory are matched by `ingredient_id`. The server reads both tables explicitly rather than depending on an unverified foreign-key relationship name. Queries use pagination to avoid silently truncating results at the default row limit. Displayed timestamps use Australia/Sydney. Other users' changes require Refresh stock or a page reload to appear.

Local checks used synthetic data to verify builds, status boundaries, search, filtering, a stock deduction triggering a low-stock alert, transactional logging, stale submission rejection, excessive deduction rejection, and database function permissions. The test database was based on the supplied column definitions. These checks do not replace acceptance testing against the team's actual Supabase configuration. No live team database was accessed or changed during preparation.

References: [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components), [Supabase Database Functions](https://supabase.com/docs/guides/database/functions), and [GitHub Codespaces Port Forwarding](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).
