#!/bin/sh
set -eu
umask 077
runtime="${TMPDIR:-/var/cache/agent-wechat}/snsbox-private"
mkdir -p "$runtime"
chmod 700 "$runtime"
# Docker Desktop bind files may have permissive modes. Stage only our own service
# configuration/token into the private Linux volume; never copy an official profile.
cp /run/config/wechat-server.toml "$runtime/server.toml"
cp /run/secrets/wechat-api-token "$runtime/wechat-api-token"
chmod 600 "$runtime/server.toml" "$runtime/wechat-api-token"
if [ -z "${WX_CONNECT_PROXY_HOST:-}" ]; then
    exec /usr/local/bin/wx serve --server-config "$runtime/server.toml"
fi
case "${WX_CONNECT_PROXY_PORT:-}" in ''|*[!0-9]*) echo 'WX_CONNECT_PROXY_PORT must be numeric' >&2; exit 2;; esac
proxy_ip=$(getent ahostsv4 "$WX_CONNECT_PROXY_HOST" | head -1 | cut -d ' ' -f1)
if [ -z "$proxy_ip" ]; then echo 'Cannot resolve configured proxy host' >&2; exit 2; fi
printf 'strict_chain\nproxy_dns\nquiet_mode\ntcp_read_time_out 30000\ntcp_connect_time_out 10000\n[ProxyList]\nhttp %s %s\n' "$proxy_ip" "$WX_CONNECT_PROXY_PORT" >"$runtime/proxychains.conf"
# Process-local CONNECT routing. TLS/MMTLS verification stays in the upstream.
exec proxychains4 -q -f "$runtime/proxychains.conf" /usr/local/bin/wx serve --server-config "$runtime/server.toml"
