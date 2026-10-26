"""Install only the new inventory files; never overwrite different content."""
from pathlib import Path
import json
import shutil
import sys

root = Path.cwd()
source = Path(__file__).resolve().parent / "files"
if not (root / "package.json").is_file() or not (root / "app").is_dir():
    sys.exit("Run this from your project root, beside package.json and app/.")
package = json.loads((root / "package.json").read_text())
if "next" not in package.get("dependencies", {}):
    sys.exit("This installer is for the team's Next.js project.")
files = sorted(path for path in source.rglob("*") if path.is_file())
conflicts = []
for path in files:
    target = root / path.relative_to(source)
    if target.exists() and (not target.is_file() or target.read_bytes() != path.read_bytes()):
        conflicts.append(str(target.relative_to(root)))
if conflicts:
    sys.exit("Stopped without copying. Review existing files first:\n" + "\n".join(conflicts))
for path in files:
    target = root / path.relative_to(source)
    if target.exists():
        print("Already installed:", target.relative_to(root))
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
    print("Added:", target.relative_to(root))
print("Done. Read INVENTORY_SETUP.md, run the Supabase SQL setup, then npm run dev and open /inventory.")
