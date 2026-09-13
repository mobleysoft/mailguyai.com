#!/bin/bash
# safe-deploy.sh - pre/post-deploy safety wrapper for mailguyai-com-worker.
#
# Built 2026-09-13, generalizing workers/venture-fleet/safe-deploy.sh's
# proven pattern (see /Users/johnmobley/mascom/safe-deploy-lib.sh) to this
# repo. mailguyai.com is its own dedicated git repo (not part of the shared
# nginx/ multi-venture tree), but the same underlying hazard applies -
# AGENTS.md incident #4b: multiple concurrent Claude Code
# sessions/agents can read/write/deploy from this SAME on-disk checkout, and
# real secrets (MAILGUY_API_KEY, CF_API_KEY/CF_API_EMAIL) plus a real D1
# mailbox store, R2 raw-mail bucket, and native send_email binding are all
# real production dependencies here that a bad deploy could silently drop.
#
# Usage: ./safe-deploy.sh [extra wrangler deploy args]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source /Users/johnmobley/mascom/safe-deploy-lib.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
CONFIG="wrangler.toml"

sd_banner "mailguyai-com-worker"

# 1. Branch check.
sd_require_branch "$REPO_ROOT" main

# 2. Clean-tree check - this is a dedicated single-venture repo, so check
#    the whole tree rather than scoping to a subpath.
sd_require_clean_tree "$REPO_ROOT"

# 3. Positive binding assertions - the real bindings this worker depends on
#    (KV delivery log, D1 mailbox/message metadata added 2026-09-08, R2 raw
#    MIME storage added 2026-09-08, and the native send_email binding,
#    which uses `name = "..."` rather than `binding = "..."` - the
#    library's grep-based check handles either syntax the same way).
sd_require_config_lines "$CONFIG" \
  'binding = "MAILGUY_KV"||KV namespace, legacy delivery-log lookup (GET /api/v1/mail/:id)' \
  'binding = "MAILGUY_DB"||D1 mailbox + message metadata store, added 2026-09-08' \
  'binding = "MAILGUY_R2"||R2 bucket for raw MIME bodies of received mail, added 2026-09-08' \
  'name = "SEND_EMAIL"||Cloudflare native send_email binding - zero external API dependency for outbound mail'

echo "Pre-deploy checks passed: on main, clean tree, required bindings present."

# 4. Deploy for real.
sd_deploy "$CONFIG" "$@"

# 5. Post-deploy live verification against the real, unauthenticated health
#    probe (GET /api/v1/health) - checks for the distinguishing engine tag
#    rather than just "status":"ok" alone, so a different worker/edge
#    fallback answering the same domain wouldn't false-pass this check.
echo ""
echo "== post-deploy verification =="
sd_verify_response_body \
  "https://mailguyai.com/api/v1/health" \
  '"engine":"cloudflare-native"'

sd_banner_done "mailguyai-com-worker"
