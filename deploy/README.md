# Docker Linux AMD64

`docker compose up -d --build` builds the Rust server and Vite UI. The default port is loopback-only at `http://localhost:8080`; configure `SNSBOX_PUBLIC_ORIGIN` to the exact browser origin when using another hostname, port or HTTPS reverse proxy. Set `SNSBOX_BIND_ADDRESS` only when intentionally exposing the service on a LAN. HTTPS terminates at your existing reverse proxy; Cookie Secure follows the configured HTTPS origin.

If a Node base-image pull is unavailable, build the frontend locally (`npm ci` and `npm run build` inside `web/`) and use `docker build --platform linux/amd64 --target runtime-prebuilt -t snsbox:0.1.0 .`. This optional target still builds Rust from the locked source but packages the existing `web/dist`. The default final target performs the complete Node + Rust multistage build. `NODE_IMAGE`, `RUST_IMAGE`, and `RUNTIME_IMAGE` build arguments can select reachable mirrors of the same versions. An optional BuildKit secret `cargo_config` can supply your Cargo registry configuration without embedding it in the runtime image.

The first start generates a private administrator credential at `/data/initial-admin-password` (mode 0600). Read it locally with `docker compose exec snsbox cat /data/initial-admin-password`; do not paste it into Git, screenshots or support logs. Alternatively mount a secret and set `SNSBOX_ADMIN_PASSWORD_FILE`. An environment password is supported for local development but a mounted secret is preferred. Passwords must contain at least 16 bytes. Login is rate limited, sessions expire in 12 hours, and restarts revoke browser sessions.

The default named volume is **new SnSBox data**, not an official-client profile. Containers run as UID/GID 10001. If replacing the named volume with a host bind, create and grant that user access before starting. The root filesystem is read-only. No Docker socket, host PID namespace, privileged mode or desktop is required by the aggregation server.

## Configure actual upstreams

For reproducible pinned source build commands, prerequisites and a loopback-safe sidecar topology, use [UPSTREAM_SETUP.md](UPSTREAM_SETUP.md).

1. Install and pin the separately maintained upstream version listed in [the backend record](../docs/BACKEND_IMPLEMENTATION.md). This image does not bundle the upstreams or reimplement their private protocols.
2. Create `private/accounts.json` from `accounts.example.json`. A `baseUrl` is an origin only (no `/v1` or `/api` suffix); WeChat also needs the upstream's account ID. The tokens are read from separate secret files and never sent to the browser. Configure only accounts that have an actual upstream; omit unconfigured entries or omit `baseUrl`.
3. Configure Lagrange Milky HTTP API and SSE explicitly and assign its access token. The inspected source's `Milky.Api.Http.Enabled` and `Milky.Event.SSE.Enabled` must be true. Restrict upstream ports to the internal Docker network or local trusted interface. For browser login/logout, use the optional LLBot management adapter and isolated setup in UPSTREAM_SETUP.md. Plain Milky alone has no login management API.
4. Use `compose.upstreams.example.yaml` as an explicit overlay after editing paths: `docker compose -f compose.yaml -f compose.upstreams.yaml up -d`. Existing host containers are not started/stopped or modified by SnSBox.
5. If no legacy inspection is needed, remove `SNSBOX_LEGACY_CONFIG` and its mount from the overlay. If inspection is enabled, mount the complete existing `wechat-selkies` **config root read-only**. The service only checks `.xwechat`, `xwechat_files`, `.config/QQ`, `.system-identity`; it does not import, decrypt, copy or write these files. Source and SnSBox data paths must be distinct and non-nested.

Agent WeChat may need a stopped complete official profile and can write to the selected profile itself. That is a separately operated upstream, not an automatic migration action of this Compose. Use an explicitly prepared isolated profile only after following the upstream's stopped-source procedure. Never allow two processes to write the same official profile. QQ Milky/Lagrange authentication data is independent of official QQ's tokens.

## Read existing history from an independent source

The dedicated read-only history workspace uses pinned `wechat-profile 2.5.0` for supported Linux WeChat profiles. Configure an independently prepared consistent source and matching protected keys using [HISTORY_SETUP.md](HISTORY_SETUP.md). It has separate indexes, pagination and text search; it does not send messages or take over the live WS profile. Plaintext compatible exports are an explicit option. Official QQNT history decryption is unsupported. The existing `SNSBOX_LEGACY_CONFIG` inspection remains metadata-only and is never implicitly upgraded into an import.

The history overlay supplies a separate disk-backed scratch volume. Do not place temporary files inside a source or assume the default small `/tmp` tmpfs can hold large profile copies. Synthetic encrypted/plaintext WAL checks passed; the current user's real encrypted history has not been read because no consistent copy or key was supplied.

## Scope and operation

- `/health` indicates HTTP service availability; online account status is separate. Unconfigured accounts remain visible without fake conversations.
- Data includes SQLite/WAL, uploaded or retrieved media and generated local administrator credentials. At-rest encryption is not implemented. Back up by **stopping only the SnSBox service**, backing up its entire named volume, then restarting; do not back up a live SQLite main file alone. Upstream official-profile backup is a separate process. Restore into an empty independent volume with correct UID, keeping the matching application version. No automated backup/restore acceptance is claimed.
- Cache defaults to 2 GiB total; each uploaded or fetched file is limited to 32 MiB. `SNSBOX_MEDIA_QUOTA_BYTES` changes the quota. Full quota rejects new caching/uploads; it does not delete source records or old media automatically.
- WeChat displays cached upstream image/video/sticker/file media through its authenticated API. Media not downloaded upstream remains explicitly unavailable. QQ media is fetched only from recognized Tencent CDN hosts with public resolved addresses and no redirects. Signed resource URLs stay server-side. Browser-compatible codecs still determine playback.
- Text and single image/video sends are implemented for both adapters; WeChat also supports single file sends. Sticker sending and executable mini-apps are not exposed. QQ remote login/logout requires the optional LLBot direct management service. Mini-app/link reception is descriptive; a web link can be sent as ordinary text. QQ Mail opens its normal independent web login.
- Only newly observed messages, recently fetched upstream history and replayed WeChat events are stored. This is not a complete history migration. QQ SSE does not guarantee disconnected-event recovery; initial private-chat history cannot be fetched without a known sequence in the inspected upstream.

`docker compose down` preserves the named data volume. Do not add `-v` unless deliberately deleting all SnSBox data. The current migration is additive; before future schema changes, take a stopped-volume backup.

For the one focused synthetic integration check, run `node deploy/smoke.mjs snsbox:0.1.0` on a Docker host. It creates its own temporary accounts, fake HTTP upstream, isolated container and anonymous data volume, checks auth/media/idempotency/restart, then removes only those test resources. It does not connect to real WeChat/QQ or mount official profiles. No broad application test suite is required for deployment documentation edits.
