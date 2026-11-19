FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.321
ARG CODEX_VERSION=0.166.0
ARG BUN_VERSION=1.3.13
# SHA-256 of bun-linux-x64.zip, from the release's SHASUMS256.txt.
ARG BUN_SHA256=79c0771fa8b92c33aae41e15a0e0d307ea99d0e2f00317c71c6c53237a78e25a

# Use a runtime supported by the pinned Claude Code release. The image uses
# Debian packages available to Fly's remote builder and does not rely on a
# local architecture-specific build cache.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    iptables \
    python3 \
    ripgrep \
    tini \
    tmux \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && GH_VERSION=2.67.0 \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
  && mkdir -p /usr/local/lib/gh \
  && tar -xzf /tmp/gh.tar.gz --strip-components=2 -C /usr/local/lib/gh "gh_${GH_VERSION}_linux_amd64/bin/gh" \
  && rm /tmp/gh.tar.gz \
  && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && useradd --create-home --shell /bin/bash agent

# Bun runs the cloud-session host. The zip is checked against BUN_SHA256 before it is unpacked.
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
  && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin \
  && rm /tmp/bun.zip \
  && chmod 0755 /usr/local/bin/bun \
  && test "$(/usr/local/bin/bun --version)" = "${BUN_VERSION}"

# runner.mjs and host.mjs are not in git. `bun run build:runner` and `bun run build:host` (from backend) write them into this folder.
COPY runner.mjs /opt/draft/runner.mjs
COPY host.mjs /opt/draft/host.mjs
COPY configure-egress.sh /usr/local/sbin/configure-egress.sh
COPY configure-open-egress.sh /usr/local/sbin/configure-open-egress.sh
COPY entrypoint.sh /usr/local/bin/draft-entrypoint
COPY draft-github-token /usr/local/bin/draft-github-token
COPY git-credential-draft /usr/local/bin/git-credential-draft
COPY gh /usr/local/bin/gh
RUN chmod 0755 \
    /opt/draft/runner.mjs \
    /opt/draft/host.mjs \
    /usr/local/bin/draft-entrypoint \
    /usr/local/sbin/configure-egress.sh \
    /usr/local/sbin/configure-open-egress.sh \
    /usr/local/bin/draft-github-token \
    /usr/local/bin/git-credential-draft \
    /usr/local/bin/gh \
  && git config --system credential.https://github.com.helper draft

WORKDIR /run
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/draft-entrypoint"]
