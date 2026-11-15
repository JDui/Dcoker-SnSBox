# Build with context = a clean checkout of LLBot v8.3.2, peeled commit dc2b2b9.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY package.json package-dist.json yarn.lock .yarnrc.yml tsconfig.json vite.config.ts LICENSE ./
COPY src/ ./src/
COPY doc/ ./doc/
RUN corepack enable && corepack prepare yarn@4.18.0 --activate \
    && yarn install --immutable --mode=skip-build && yarn build
RUN mkdir -p dist/data && find dist -maxdepth 1 -name 'sign-proxy.*.node' ! -name 'sign-proxy.linux-x64-glibc.node' -delete

FROM ${NODE_IMAGE}
WORKDIR /app/llbot
COPY --from=build /build/dist/ ./
COPY --from=build /build/LICENSE ./LICENSE
VOLUME ["/app/llbot/data"]
ENTRYPOINT ["node", "--enable-source-maps", "./llbot.js"]
# Login bootstrap image: FFmpeg/media processing is intentionally not installed.
