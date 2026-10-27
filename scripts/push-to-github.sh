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
REMOTE_REPO="${REMOTE_REPO:-vogiahuy2506-lang/ticket}"

cd "$REPO_DIR"

echo "==> Checking GitHub authentication"

# The repository may already exist and the machine may already have
# credentials (a PAT in the keychain, for example), so the check is: can we
# actually talk to the remote? Only if that fails do we need `gh`.
have_gh=false
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  have_gh=true
fi
if ! git ls-remote "https://github.com/$REMOTE_REPO.git" >/dev/null 2>&1 && [ "$have_gh" = false ]; then
  echo ""
  echo "Cannot reach $REMOTE_REPO and the GitHub CLI is not logged in."
  echo "Choose one:"
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

echo "==> Checking the remote repository: $REMOTE_REPO"
if git ls-remote "https://github.com/$REMOTE_REPO.git" >/dev/null 2>&1; then
  echo "    already exists, reusing it"
elif [ "$have_gh" = true ]; then
  gh repo create "$REMOTE_REPO" --private --description \
    "Resale marketplace thin slice: ticket checkout with escrow and a double-entry ledger" \
    || gh repo create "$REMOTE_REPO" --public --description \
      "Resale marketplace thin slice: ticket checkout with escrow and a double-entry ledger"
else
  echo "    does not exist and gh is not available - create it by hand:"
  echo "        https://github.com/new?name=$REMOTE_REPO"
  exit 1
fi

echo "==> Adding the remote"
REMOTE_URL="https://github.com/$REMOTE_REPO.git"
current_url="$(git remote get-url origin 2>/dev/null || true)"
if [ "$current_url" != "$REMOTE_URL" ]; then
  if [ -n "$current_url" ]; then
    git remote set-url origin "$REMOTE_URL"
  else
    git remote add origin "$REMOTE_URL"
  fi
fi

echo "==> Pushing main"
git push -u origin main

echo ""
echo "Done. The repository is at https://github.com/$REMOTE_REPO"
echo ""
echo "Reminder: the VNPay sandbox credentials are NOT in the repository."
echo "Send them to the reviewers separately, as the brief asks."
