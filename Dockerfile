FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    GLAMA_VERSION="1.0.0" \
    PYTHONUNBUFFERED=1 \
    # Limit Node.js memory to prevent OOM during parallel TS DTS builds
    NODE_OPTIONS="--max-old-space-size=2048"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g mcp-proxy@6.4.3 pnpm@10.14.0 \
    && node --version \
    && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="/usr/local/bin" sh \
    && uv python install 3.13 --default \
    && ln -s $(uv python find) /usr/local/bin/python \
    && python --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

RUN git clone https://github.com/Markgatcha/universal-mcp-toolkit . \
    && git checkout ae63b1b8c4b5d057445d4cb3843f55ac44f33e35

# Install dependencies and build with limited concurrency to prevent OOM
# --concurrency=4 prevents all 25 packages from building simultaneously
RUN (rm -f .npmrc) \
    && (pnpm install --frozen-lockfile) \
    && (pnpm exec turbo run build --concurrency=4)

CMD ["mcp-proxy","--","node","/app/servers/hackernews/dist/index.js","--transport","stdio"]
