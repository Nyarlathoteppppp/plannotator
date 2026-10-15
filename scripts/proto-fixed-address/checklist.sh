#!/usr/bin/env bash
# PROTOTYPE (proto/inbox-fixed-address): after you clicked Sure in the scratch
# Inbox (try-on-this-mac.sh), check what it promised. Read-only on your real
# Inbox and ~/.plannotator; it restarts only the SCRATCH Inbox.
#
#   bash scripts/proto-fixed-address/checklist.sh
#
# Checks:
#   1. the fixed address is on (the scratch Inbox says so)
#   2. https://inbox.plannotator.localhost answers THIS scratch Inbox (serverSession)
#   3. the OS trusts portless's CA (security verify-cert), and real browser
#      engines load the address with certificate checks on (no warning)
#   4. port change: the scratch Inbox restarted on a NEW port keeps the name
#   5. notifications: a question arrives at the new origin; you confirm the ask
#   6. Tailscale: serve config unchanged, the tailnet URL still answers
#   7. the real Inbox on :59812 is untouched; no ~/.plannotator/inbox/name.json
set -uo pipefail
. "$(dirname "$0")/lib.sh"
PASSES=0
FAILS=0

[ -f "$SCRATCH/made-by-try" ] || { echo "Run try-on-this-mac.sh first." >&2; exit 2; }

https_session() {
  # --cacert: the route itself (name -> portless -> name listener -> Inbox), whatever the OS trusts.
  curl -s --max-time 5 --cacert "$PORTLESS_STATE/ca.pem" "$NAME_URL/api/inbox/health" | json_field serverSession
}

say "1. The fixed address is on"
STATE="$(pn inbox --name status 2>/dev/null)"
STATUS="$(printf '%s' "$STATE" | json_field status)"
if [ "$STATUS" = "on" ]; then ok "status on (listener port $(printf '%s' "$STATE" | json_field listener_port))"; else bad "status is '$STATUS': $(printf '%s' "$STATE" | json_field reason)"; fi

say "2. $NAME_URL answers this scratch Inbox"
SESSION="$(scratch_session)"
GOT="$(https_session)"
if [ -n "$SESSION" ] && [ "$GOT" = "$SESSION" ]; then ok "serverSession matches ($SESSION)"; else bad "health answered '${GOT:-nothing}', expected '$SESSION'"; fi
curl -s -o /dev/null -D - --max-time 5 --cacert "$PORTLESS_STATE/ca.pem" "$NAME_URL/" | grep -i '^x-portless' >/dev/null && ok "served through portless (X-Portless header)" || note "no X-Portless header seen"

say "3. Certificate trusted by the OS and by browsers (no warning)"
if security verify-cert -c "$PORTLESS_STATE/ca.pem" -p ssl -L >/dev/null 2>&1; then ok "macOS trusts '$PORTLESS_CA_NAME' for SSL"; else bad "macOS does not trust portless's CA: browsers will warn (portless trust, or the second prompt was dismissed)"; fi
if curl -s --max-time 5 "$NAME_URL/api/inbox/health" >/dev/null 2>&1; then ok "curl (system trust store) accepts the certificate"; else note "curl without --cacert refused it (macOS curl may not read the keychain; the browser check below is what counts)"; fi
if (cd "$REPO" && bun scripts/proto-fixed-address/browser-check.ts "$SESSION" "$NAME_URL"); then ok "a Chromium-family browser loaded $NAME_URL with certificate checks on"; else bad "no Chromium-family engine loaded it cleanly (see the lines above; 'not available' means install it: bunx playwright install chromium)"; fi
note "Also open $NAME_URL in Safari and Chrome yourself: no warning page, a padlock."

say "4. A port change keeps the name"
OLD_PORT="$(scratch_port)"
stop_scratch_inbox
# Hold the old port so the next start must move, the real-world case the name is for.
bun -e "Bun.serve({ hostname: '127.0.0.1', port: $OLD_PORT, fetch: () => new Response('held by checklist') }); setTimeout(() => process.exit(0), 120000)" &
SQUAT_PID=$!
sleep 1
(cd "$SCRATCH" && pn inbox --background >/dev/null)
NEW_PORT="$(scratch_port)"
NEW_SESSION="$(scratch_session)"
kill "$SQUAT_PID" 2>/dev/null || true  # the port holder this script started above, nothing else
if [ -n "$NEW_PORT" ] && [ "$NEW_PORT" != "$OLD_PORT" ]; then ok "scratch Inbox moved: :$OLD_PORT -> :$NEW_PORT"; else bad "the scratch Inbox did not move (old $OLD_PORT, new ${NEW_PORT:-none})"; fi
GOT=""
for _ in $(seq 1 30); do GOT="$(https_session)"; [ "$GOT" = "$NEW_SESSION" ] && break; sleep 0.5; done
if [ -n "$NEW_SESSION" ] && [ "$GOT" = "$NEW_SESSION" ]; then ok "$NAME_URL answers the restarted Inbox (no password asked)"; else bad "after the move the name answered '${GOT:-nothing}', expected '$NEW_SESSION'"; fi

say "5. Notifications on the new origin"
open "$NAME_URL/"
sleep 2
mkdir -p "$SCRATCH/project"
if (cd "$REPO" && bun scripts/proto-fixed-address/seed-question.ts "$NEW_PORT" "$SCRATCH/project"); then ok "a question was sent to the scratch Inbox"; else bad "could not send a question"; fi
cat <<EOF
  In the tab at $NAME_URL: a line above the list asks to allow notifications
  ("The Inbox moved to a new address. Allow notifications again." or "Allow").
  Click it; the browser's own permission prompt must name inbox.plannotator.localhost.
EOF
read -r -p "  Did the browser ask for notification permission for $NAME_HOST? [y/n] " ANSWER
case "$ANSWER" in y|Y|yes) ok "notification permission prompt on the new origin (your answer)";; *) bad "no notification prompt on the new origin (your answer)";; esac

say "6. Tailscale still works"
if command -v tailscale >/dev/null; then
  tailscale serve status --json > "$SCRATCH/tailscale-serve.after.json" 2>/dev/null || true
  if cmp -s "$SCRATCH/tailscale-serve.before.json" "$SCRATCH/tailscale-serve.after.json"; then ok "tailscale serve config unchanged"; else bad "tailscale serve config changed (diff $SCRATCH/tailscale-serve.{before,after}.json)"; fi
  TS_URLS="$(tailscale serve status 2>/dev/null | grep -Eo 'https://[^ ]+' | sort -u)"
  if [ -z "$TS_URLS" ]; then note "no tailscale serve mappings to probe"; fi
  for u in $TS_URLS; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u" || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then ok "$u answers (HTTP $code)"; else bad "$u does not answer"; fi
  done
  tailscale status >/dev/null 2>&1 && ok "tailscale status works" || note "tailscale is not running"
else
  note "no tailscale CLI on PATH"
fi
note "Port 443 listeners you can see (Tailscale's network extension may not show): $(lsof -nP -iTCP:443 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1" "$9}' | tr '\n' ';')"

say "7. Your real Inbox is untouched"
BEFORE="$(cat "$SCRATCH/real-inbox-session.before" 2>/dev/null)"
NOW="$(real_inbox_session || true)"
if [ "$BEFORE" = "$NOW" ]; then ok "real Inbox on :$REAL_INBOX_PORT has the same serverSession (${NOW:-not running before or now})"; else bad "real Inbox changed: before '${BEFORE:-none}', now '${NOW:-none}'"; fi
if [ -e "$HOME/.plannotator/inbox/name.json" ]; then bad "the real data dir has a name.json"; else ok "nothing was written to the real data dir's inbox/name.json"; fi
REAL_PORTLESS_ROUTES="$(cat "$PORTLESS_STATE/routes.json" 2>/dev/null | tr -d '\n ')"
note "portless routes now: ${REAL_PORTLESS_ROUTES:-none}"

say "Result: $PASSES passed, $FAILS failed"
echo "  Undo everything:  bash scripts/proto-fixed-address/undo.sh"
[ "$FAILS" -eq 0 ]
