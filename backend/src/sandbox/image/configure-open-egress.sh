#!/bin/sh
# Privileged egress policy for an open cloud session. Any destination is allowed except private,
# link-local and metadata ranges. The resolvers in /etc/resolv.conf stay reachable even inside those ranges.
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "[egress] fatal: configuration requires root" >&2
  exit 1
}
command -v iptables >/dev/null 2>&1 || {
  echo "[egress] fatal: iptables is unavailable" >&2
  exit 1
}
command -v ip6tables >/dev/null 2>&1 || {
  echo "[egress] fatal: ip6tables is unavailable; refusing to leave IPv6 open" >&2
  exit 1
}

resolvers="$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)"
[ -n "$resolvers" ] || {
  echo "[egress] fatal: no nameserver in /etc/resolv.conf" >&2
  exit 1
}

iptables -F OUTPUT
ip6tables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# A resolver can sit inside a range blocked below (Fly uses fdaa::3), so it is accepted first.
for ns in $resolvers; do
  case "$ns" in
    ''|*[!0-9A-Fa-f:.]*)
      echo "[egress] fatal: invalid nameserver in /etc/resolv.conf" >&2
      exit 1
      ;;
    *:*) fw=ip6tables ;;
    *) fw=iptables ;;
  esac
  "$fw" -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  "$fw" -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done

# Private, link-local and metadata ranges. fc00::/7 covers Fly's 6PN (fdaa::/16) and the AWS IPv6 metadata address.
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
  iptables -A OUTPUT -d "$range" -j DROP
done
for range in fc00::/7 fe80::/10; do
  ip6tables -A OUTPUT -d "$range" -j DROP
done

iptables -P OUTPUT ACCEPT
ip6tables -P OUTPUT ACCEPT
echo "[egress] open policy installed: private and metadata ranges blocked" >&2
