# BuildKit mounts use the Docker engine's bundled Dockerfile frontend.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUST_IMAGE=rust:1.96-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim
FROM ${NODE_IMAGE} AS web
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ${RUST_IMAGE} AS backend
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target --mount=type=secret,id=cargo_config,target=/usr/local/cargo/config.toml,required=false \
    cargo build --release --locked && cp target/release/snsbox /snsbox

FROM ${RUNTIME_IMAGE} AS runtime-base
RUN groupadd --gid 10001 snsbox && useradd --uid 10001 --gid snsbox --no-create-home --shell /usr/sbin/nologin snsbox \
    && mkdir -p /app/web /data /var/cache/snsbox-history && chown -R snsbox:snsbox /app /data /var/cache/snsbox-history
ENV SNSBOX_LISTEN=0.0.0.0:8080 SNSBOX_DATA_DIR=/data SNSBOX_WEB_DIR=/app/web SNSBOX_PUBLIC_ORIGIN=http://localhost:8080
WORKDIR /app
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["snsbox", "--healthcheck"]
ENTRYPOINT ["snsbox"]

# Optional offline-image path: build web/dist locally with npm ci && npm run build.
# This target never needs a Node base image; Rust is still built from source.
FROM runtime-base AS runtime-prebuilt
COPY --from=backend /snsbox /usr/local/bin/snsbox
COPY web/dist/ /app/web/

FROM runtime-base AS runtime
COPY --from=backend /snsbox /usr/local/bin/snsbox
COPY --from=web /build/web/dist/ /app/web/
