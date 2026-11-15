# Extend the separately built, pinned upstream runtime; no protocol modifications.
ARG UPSTREAM_IMAGE=snsbox-agent-wechat:ce5c0687
FROM ${UPSTREAM_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends proxychains4 \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 entrypoint.sh /usr/local/bin/snsbox-wechat-entrypoint
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/snsbox-wechat-entrypoint"]
CMD []
