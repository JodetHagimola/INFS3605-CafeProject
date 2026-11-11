# Integration verification — 10 November 2026

Source: supplied main-3 plus inventory-check snapshots. No live Supabase credentials or Gemini API calls were used. Original folders were not edited.

## Checks completed

| Check | Result |
| --- | --- |
| TypeScript (`tsc --noEmit`) | Passed |
| Existing and new Node tests (`node --test tests/*.test.mjs`) | 38 passed |
| Next.js 16.4.4 production build (`next build --webpack`) | Passed, including the sales and deliveries routes |
| Isolated SQL scenario groups (PGlite 0.5.11) | 10 passed |
| Production-mode browser flow against a synthetic local API/database | Login, sale, receipt and Today summary verified |
| Patch installer | Dry run, complete install, repeat install and conflict preservation passed |

The SQL scenarios cover: migration of mixed legacy and agent receipts without stock changes; migration rerun; partial and final receipts alternating between page and agent writers; replaying existing references; payload conflicts and stale requests; sales with multiple ingredient deductions; insufficient stock; rollback after a forced receipt-ledger failure; Sydney date boundaries; historical recipe snapshots; cache invalidation after stock changes; cache/activity writes not invalidating themselves; anonymous/authenticated API roles denied; an old decrement writer failing atomically; and refusing migration when historical original quantities are unknown.

The browser test used the actual built Next.js app, its signed shared-passcode login, and its server actions. Supabase HTTP responses were supplied by a local synthetic adapter backed by the isolated database. With a recipe of 160 ml milk and 18 g beans per Flat White:

- Recording 2 drinks changed milk 20,000 → 19,680 ml and beans 3,000 → 2,964 g.
- Receiving 1,000 ml on a 5,000 ml order changed milk 19,680 → 20,680 ml and left 4,000 ml outstanding.
- Today showed 2 recorded drinks, 1 sale, 320 ml milk / 36 g beans usage, and +1,000 ml received.
- Missing Gemini credentials exercised the existing fallback narration. Model-generated answers and automatic tool selection were not tested.

## Remaining deployment checks

- Run the integration SQL manually against the intended team database, after verifying its prerequisites; no live migration has been applied by this work.
- Verify PostgREST permissions/schema availability in the team's Supabase environment. The local adapter does not reproduce all PostgREST behavior.
- Verify the chat calls `get_recorded_operations` with the team's existing Gemini configuration.
- PGlite serializes work on one connection. Independent PostgreSQL session races/lock ordering and high-load throughput were not tested.
- No external order, supplier message, Git commit/push/merge, or Vercel deployment was performed.

The production build and browser flow preceded two final nonstructural edits: validating receipt timestamps while including all posted receipts, and singular/plural sale wording. Final TypeScript and unit checks were rerun on the packaged source.
