#!/bin/zsh
#
# Pushes this repository to GitHub.
#
# The repo currently has no remote and this machine has no GitHub
# credentials configured, so the first step is the only one that needs you:
# authenticate. Everything after that is scripted.
#
# Usage:
#   ./scripts/push-to-github.sh
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_REPO="${REMOTE_REPO:-syn-mcj/ticket-checkout-escrow}"

cd "$REPO_DIR"

echo "==> Checking GitHub authentication"
if ! gh auth status >/dev/null 2>&1; then
  echo ""
  echo "GitHub CLI is not logged in yet. Choose one:"
  echo ""
  echo "  (a) Log in with the GitHub CLI (interactive):"
  echo "        gh auth login"
  echo ""
  echo "  (b) Use a personal access token (PAT) instead:"
  echo "        export GH_TOKEN=ghp_xxxxxxxxxxxx"
  echo ""
  echo "  (c) Add an SSH key to GitHub and push over SSH:"
  echo "        ssh-add ~/.ssh/id_ed25519"
  echo ""
  echo "Then run this script again."
  exit 1
fi

echo "==> Creating the remote repository: $REMOTE_REPO"
if gh repo view "$REMOTE_REPO" >/dev/null 2>&1; then
  echo "    already exists, reusing it"
else
  gh repo create "$REMOTE_REPO" --private --description \
    "Resale marketplace thin slice: ticket checkout with escrow and a double-entry ledger" \
    || gh repo create "$REMOTE_REPO" --public --description \
      "Resale marketplace thin slice: ticket checkout with escrow and a double-entry ledger"
fi

echo "==> Adding the remote"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/$REMOTE_REPO.git"
else
  git remote add origin "https://github.com/$REMOTE_REPO.git"
fi

echo "==> Pushing main"
git push -u origin main

echo ""
echo "Done. The repository is at https://github.com/$REMOTE_REPO"
echo ""
echo "Reminder: the VNPay sandbox credentials are NOT in the repository."
echo "Send them to the reviewers separately, as the brief asks."
