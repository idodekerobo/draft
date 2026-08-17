#!/bin/sh
# Privileged network-policy setup for the Claude Code sandbox.
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "[egress] fatal: configuration requires root" >&2
  exit 1
}

: "${DRAFT_EGRESS_HOSTS:?DRAFT_EGRESS_HOSTS is required}"
: "${DRAFT_CALLBACK_HOST:?DRAFT_CALLBACK_HOST is required}"

command -v iptables >/dev/null 2>&1 || {
  echo "[egress] fatal: iptables is unavailable" >&2
  exit 1
}
command -v ip6tables >/dev/null 2>&1 || {
  echo "[egress] fatal: ip6tables is unavailable; refusing to leave IPv6 open" >&2
  exit 1
}

hosts=""
for host in $(printf '%s' "$DRAFT_EGRESS_HOSTS" | tr ',' ' '); do
  case "$host" in
    ''|*[!A-Za-z0-9._-]*)
      echo "[egress] fatal: invalid host in DRAFT_EGRESS_HOSTS" >&2
      exit 1
      ;;
  esac
  hosts="$hosts $host"
done

case " $hosts " in
  *" api.anthropic.com "*) ;;
  *) echo "[egress] fatal: api.anthropic.com must be allowlisted" >&2; exit 1 ;;
esac
case " $hosts " in
  *" $DRAFT_CALLBACK_HOST "*) ;;
  *) echo "[egress] fatal: callback host must be allowlisted" >&2; exit 1 ;;
esac

v4_file="$(mktemp)"
v6_file="$(mktemp)"
resolved_hosts_file="$(mktemp)"
trap 'rm -f "$v4_file" "$v6_file" "$resolved_hosts_file"' EXIT HUP INT TERM

for host in $hosts; do
  resolved=0
  if printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    printf '%s\n' "$host" >>"$v4_file"
    resolved=1
  else
    for ip in $(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
      printf '%s\n' "$ip" >>"$v4_file"
      printf '%s %s\n' "$ip" "$host" >>"$resolved_hosts_file"
      resolved=1
    done
    # Fly resolved api.anthropic.com only over IPv6 in the proven spike, so
    # IPv6 resolution and policy installation are mandatory, not fallback.
    for ip in $(getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
      printf '%s\n' "$ip" >>"$v6_file"
      printf '%s %s\n' "$ip" "$host" >>"$resolved_hosts_file"
      resolved=1
    done
  fi
  [ "$resolved" -eq 1 ] || {
    echo "[egress] fatal: an allowlisted host did not resolve" >&2
    exit 1
  }
done

sort -u -o "$v4_file" "$v4_file"
sort -u -o "$v6_file" "$v6_file"
sort -u -o "$resolved_hosts_file" "$resolved_hosts_file"

# The agent holds the customer's Claude token, so unrestricted DNS would be an
# exfiltration channel even with HTTPS restricted. Resolve trusted hosts while
# still online, pin them for this short-lived Machine, then block network DNS.
# A fresh Machine gets a fresh resolution on every invocation.
cat "$resolved_hosts_file" >>/etc/hosts

# Install complete chains before switching their policies to DROP. Hostnames
# resolve through /etc/hosts; network DNS remains blocked for the agent.
# Do not add iptables LOG rules: Fly's Firecracker kernel was proven not to
# support the LOG target, and packet logging caused the spike to crash-loop.
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
while IFS= read -r ip; do
  [ -n "$ip" ] && iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done <"$v4_file"
iptables -P OUTPUT DROP

ip6tables -F OUTPUT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
while IFS= read -r ip; do
  [ -n "$ip" ] && ip6tables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done <"$v6_file"
ip6tables -P OUTPUT DROP

echo "[egress] IPv4 and IPv6 default-deny policies installed" >&2
