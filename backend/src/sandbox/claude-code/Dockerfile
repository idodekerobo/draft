FROM oven/bun:1.3.11-slim AS runner-build

WORKDIR /build
COPY runner.ts ./runner.ts
RUN bun build --target=node --outfile=runner.mjs runner.ts

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.220

# Use a runtime supported by the pinned Claude Code release. The image uses
# Debian packages available to Fly's remote builder and does not rely on a
# local architecture-specific build cache.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    gosu \
    iptables \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && useradd --create-home --shell /bin/bash agent

COPY --from=runner-build /build/runner.mjs /opt/draft/runner.mjs
COPY configure-egress.sh /usr/local/sbin/configure-egress.sh
COPY entrypoint.sh /usr/local/bin/draft-entrypoint
RUN chmod 0755 \
    /opt/draft/runner.mjs \
    /usr/local/bin/draft-entrypoint \
    /usr/local/sbin/configure-egress.sh

WORKDIR /run
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/draft-entrypoint"]
