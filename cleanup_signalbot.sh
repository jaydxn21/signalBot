#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# signalBot repo cleanup
# Run this from inside your local clone of the repo.
# Everything removed here is either regeneratable (node_modules, __pycache__)
# or junk (macOS AppleDouble files, .backup files, duplicate bridge copies).
# ═══════════════════════════════════════════════════════════════════════
set -e

echo "== 1. Confirm we're in the repo root =="
if [ ! -f "package.json" ]; then
  echo "ERROR: run this from the signalBot repo root (where package.json lives)."
  exit 1
fi

echo "== 2. Untrack + remove regeneratable folders =="
git rm -r --cached node_modules 2>/dev/null || true
git rm -r --cached __pycache__ 2>/dev/null || true
rm -rf node_modules __pycache__

echo "== 3. Remove macOS AppleDouble junk files (safe, not real duplicates) =="
find . -name "._*" -not -path "./.git/*" -exec git rm --cached {} \; -exec rm -f {} \; 2>/dev/null || true
find . -name ".DS_Store" -not -path "./.git/*" -exec git rm --cached {} \; -exec rm -f {} \; 2>/dev/null || true

echo "== 4. Remove stray backup file =="
git rm --cached signal-bot.js.backup 2>/dev/null || true
rm -f signal-bot.js.backup

echo "== 5. Write .gitignore so this junk never gets re-tracked =="
cat > .gitignore << 'EOF'
node_modules/
__pycache__/
*.pyc
.DS_Store
._*
*.backup
EOF
git add .gitignore

echo "== 6. Report on duplicate bridge files (NOT auto-deleted — you confirm which is live) =="
echo "Found these bridge-related files:"
ls -la | grep -i bridge || true
echo ""
echo "Once you confirm (via ps aux on the other Mac) which bridge file is actually"
echo "running in production, delete the others manually, e.g.:"
echo "  git rm FIXED_bridge_complete.cjs"
echo "  git rm WORKING_bridge_with_signal_queue.cjs"

echo ""
echo "== 7. Show repo size before/after for sanity =="
du -sh .git 2>/dev/null || true

echo ""
echo "Done with untracking. Nothing has been committed or pushed yet."
echo "Review with: git status"
echo "Then commit: git commit -m 'Clean up repo: remove node_modules, __pycache__, macOS junk, backups'"
echo "Then push:   git push"
echo ""
echo "NOTE: node_modules and __pycache__ will still bloat your .git HISTORY"
echo "(old commits still reference them) even after this. If you want the"
echo "actual repo SIZE on GitHub to shrink, you'll need to rewrite history with"
echo "git filter-repo (ask me if you want that step — it's more involved and"
echo "requires a force-push, so it's worth doing deliberately, not by accident)."
