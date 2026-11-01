#!/usr/bin/env python3
"""Add delivery files and an Inventory link, preserving existing sales work."""
from pathlib import Path
import shutil
import sys

root = Path.cwd()
source = Path(__file__).resolve().parent / 'files'
for name in ['package.json', 'app/inventory/page.tsx', 'lib/inventory/server.ts', 'lib/inventory/model.ts']:
    if not (root / name).is_file():
        sys.exit('Run from the project root containing package.json and the inventory feature.')
files = sorted(p for p in source.rglob('*') if p.is_file())
for file in files:
    target = root / file.relative_to(source)
    if target.exists() and target.read_bytes() != file.read_bytes():
        sys.exit(f'Stopped: {target.relative_to(root)} differs. Compare before installing; nothing changed.')
page = root / 'app/inventory/page.tsx'
before = page.read_text()
after = before
if 'href="/inventory/deliveries"' not in before:
    anchor = '<a href="/inventory" aria-current="page">Inventory</a>'
    if before.count(anchor) != 1:
        sys.exit('Stopped: Inventory navigation differs. Nothing changed. Request an updated installer.')
    after = before.replace(anchor, anchor + '\n          <a href="/inventory/deliveries">Receive deliveries</a>', 1)
backup = page.with_name('page.tsx.before-deliveries.bak')
if before != after and backup.exists():
    sys.exit('Stopped: a delivery navigation backup already exists. Review it; nothing changed.')
for file in files:
    target = root / file.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(file, target)
        print(f'Added {target.relative_to(root)}')
if before != after:
    backup.write_text(before)
    page.write_text(after)
    print('Added Receive deliveries link. Original Inventory page backed up beside it.')
print('Installed. Run supabase/inventory-deliveries.sql in Supabase, then open /inventory/deliveries.')
