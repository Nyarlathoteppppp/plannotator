#!/usr/bin/env bash
# PROTOTYPE (proto/inbox-fixed-address): put this Mac back the way it was
# before try-on-this-mac.sh. Asks for your password (sudo) for the parts that
# need it, and verifies each one.
#
#   bash scripts/proto-fixed-address/undo.sh
#
# In order:
#   1. the alias removed and the scratch Inbox stopped (as you)
#   2. portless's own `clean` as root: its launchd service, the proxy, the CA
#      from the System and login keychains, ~/.portless, its /etc/hosts block
#   3. belt and braces for anything `clean` left: the same pieces by hand
#   4. the scratch folder removed
#   5. verified: no service, no CA in either keychain, nothing on 443 with
#      X-Portless, no ~/.portless, no /etc/hosts block, real Inbox unchanged
# It refuses to run when try-on-this-mac.sh did not make the scratch folder,
# because step 2 removes portless wholesale.
set -uo pipefail
. "$(dirname "$0")/lib.sh"
PASSES=0
FAILS=0

[ -f "$SCRATCH/made-by-try" ] || { echo "No scratch folder from try-on-this-mac.sh at $SCRATCH; nothing of this recipe to undo." >&2; exit 2; }

NODE="$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))' 2>/dev/null || true)"
CLI="$DATA/portless/node_modules/portless/dist/cli.js"

say "1. The alias, then the scratch Inbox"
if curl -s --max-time 2 "http://127.0.0.1:$(scratch_port)/api/inbox/health" >/dev/null 2>&1; then
  pn inbox --name off >/dev/null 2>&1 && echo "  alias removed (inbox.plannotator)" || echo "  (could not turn it off through the Inbox; clean below removes routes anyway)"
  stop_scratch_inbox
fi
echo "  scratch Inbox stopped"

say "2. portless clean (as root; sudo asks for your password)"
if [ -n "$NODE" ] && [ -f "$CLI" ]; then
  sudo /usr/bin/env SUDO_USER="$(id -un)" SUDO_UID="$(id -u)" SUDO_GID="$(id -g)" HOME="$HOME" PORTLESS_STATE_DIR="$PORTLESS_STATE" \
    "$NODE" "$CLI" clean || echo "  portless clean reported a problem; step 3 removes the pieces by hand"
else
  echo "  portless is not in the scratch folder any more; step 3 removes the pieces by hand"
fi

say "3. Anything left, by hand"
if [ -e "$PORTLESS_PLIST" ]; then
  sudo launchctl bootout system "$PORTLESS_PLIST" 2>/dev/null || true
  sudo rm -f "$PORTLESS_PLIST"
  echo "  removed $PORTLESS_PLIST"
fi
if [ -f "$PORTLESS_STATE/ca.pem" ]; then
  sudo security remove-trusted-cert -d "$PORTLESS_STATE/ca.pem" 2>/dev/null || true
  security remove-trusted-cert "$PORTLESS_STATE/ca.pem" 2>/dev/null || true
fi
for _ in $(seq 1 20); do sudo security delete-certificate -c "$PORTLESS_CA_NAME" /Library/Keychains/System.keychain >/dev/null 2>&1 || break; done
for _ in $(seq 1 20); do security delete-certificate -c "$PORTLESS_CA_NAME" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || break; done
if grep -q '# portless-start' /etc/hosts 2>/dev/null; then
  sudo sed -i '' '/# portless-start/,/# portless-end/d' /etc/hosts
  echo "  removed the portless block from /etc/hosts"
fi
if [ -e "$PORTLESS_STATE" ]; then
  sudo rm -rf "$PORTLESS_STATE"
  echo "  removed $PORTLESS_STATE"
fi

say "4. The scratch folder"
REAL_BEFORE="$(cat "$SCRATCH/real-inbox-session.before" 2>/dev/null)"
rm -rf "$SCRATCH"
echo "  removed $SCRATCH"

say "5. Verify"
[ ! -e "$PORTLESS_PLIST" ] && ok "no launchd service file" || bad "$PORTLESS_PLIST still exists"
sudo launchctl print system/sh.portless.proxy >/dev/null 2>&1 && bad "launchd still knows sh.portless.proxy" || ok "launchd has no sh.portless.proxy"
security find-certificate -c "$PORTLESS_CA_NAME" /Library/Keychains/System.keychain >/dev/null 2>&1 && bad "the CA is still in the System keychain" || ok "no '$PORTLESS_CA_NAME' in the System keychain"
security find-certificate -c "$PORTLESS_CA_NAME" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 && bad "the CA is still in the login keychain" || ok "no '$PORTLESS_CA_NAME' in the login keychain"
curl -s -o /dev/null -D - --max-time 2 -H "Host: $NAME_HOST" "http://127.0.0.1:443/" 2>/dev/null | grep -qi '^x-portless' && bad "something still answers on 443 as portless" || ok "nothing answers on 443 as portless"
[ ! -e "$PORTLESS_STATE" ] && ok "no ~/.portless" || bad "$PORTLESS_STATE still exists"
grep -q '# portless-start' /etc/hosts 2>/dev/null && bad "/etc/hosts still has a portless block" || ok "/etc/hosts has no portless block"
NOW="$(real_inbox_session || true)"
[ "$REAL_BEFORE" = "$NOW" ] && ok "real Inbox on :$REAL_INBOX_PORT unchanged (${NOW:-not running})" || bad "real Inbox changed: before '${REAL_BEFORE:-none}', now '${NOW:-none}'"
if command -v tailscale >/dev/null; then tailscale serve status >/dev/null 2>&1 && ok "tailscale serve still answers its status" || note "tailscale not running"; fi

say "Undo: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
