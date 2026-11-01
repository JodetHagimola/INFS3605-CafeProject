#!/usr/bin/env python3
"""Install additive sales files and one inventory navigation link."""
from pathlib import Path
import shutil
import sys

root = Path.cwd()
source = Path(__file__).resolve().parent / 'files'
required = ['package.json', 'app/inventory/page.tsx', 'lib/inventory/server.ts']
if any(not (root / name).is_file() for name in required):
    sys.exit('Run this installer from the project root containing package.json and app/inventory.')
files = sorted(p for p in source.rglob('*') if p.is_file())
for file in files:
    target = root / file.relative_to(source)
    if target.exists() and target.read_bytes() != file.read_bytes():
        sys.exit(f'Stopped: {target.relative_to(root)} differs. Compare it before installing; nothing was changed.')
page = root / 'app/inventory/page.tsx'
before = page.read_text()
link = '<a href="/inventory/sales">Record sale</a>'
after = before
if 'href="/inventory/sales"' not in before:
    anchor = '<a href="/inventory" aria-current="page">Inventory</a>'
    if before.count(anchor) != 1:
        sys.exit('Stopped: inventory navigation differs. Ask for an updated installer; nothing was changed.')
    after = before.replace(anchor, anchor + '\n          ' + link, 1)
backup = root / 'app/inventory/page.tsx.before-sales.bak'
if after != before and backup.exists():
    sys.exit('Stopped: a navigation backup already exists. Review it before installing; nothing was changed.')
panel = root / 'app/inventory/inventory-panel.tsx'
panel_before = panel.read_text()
panel_after = panel_before
old_time = '{dateFormat.format(new Date(item.updated))}'
if old_time in panel_before:
    if panel_before.count(old_time) != 1 or '"use client";' not in panel_before:
        sys.exit('Stopped: inventory time display differs. Review it before installing; nothing was changed.')
    panel_after = panel_before.replace(old_time, '<InventoryStockTime value={item.updated} />', 1)
    panel_after = panel_after.replace('"use client";', '"use client";\n\nimport InventoryStockTime from "./sales/stock-time";', 1)
panel_backup = root / 'app/inventory/inventory-panel.tsx.before-sales.bak'
if panel_after != panel_before and panel_backup.exists():
    sys.exit('Stopped: an inventory panel backup already exists. Review it before installing; nothing was changed.')
for file in files:
    target = root / file.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(file, target)
        print(f'Added {target.relative_to(root)}')
if after != before:
    backup.write_text(before)
    page.write_text(after)
    print('Added Record sale to inventory navigation. Original page backed up beside it.')
if panel_after != panel_before:
    panel_backup.write_text(panel_before)
    panel.write_text(panel_after)
    print('Fixed the original inventory date hydration mismatch. Existing custom date fixes are preserved.')
print('Installed. Run supabase/inventory-sales.sql in Supabase, then open /inventory/sales.')
