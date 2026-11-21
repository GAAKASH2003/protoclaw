# Base image: Official lightweight Node.js 22 on Debian slim (glibc for full compatibility)
FROM node:22-slim

# Install essential CLI utilities for sandboxed tools & signal supervision
# - tini: zombie reaper & signal forwarder (PID 1)
# - bash: required by the agent's bash() tool
# - git, curl: essential utilities for developer agent tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    git \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Enable Corepack and activate pnpm (matches host packageManager: pnpm@10.6.5)
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.6.5 --activate

# Copy dependency manifests first for fast Docker layer caching
COPY package.json pnpm-lock.yaml* ./

# Install dependencies using pnpm
RUN pnpm install --no-frozen-lockfile

# Copy application source code
COPY . .

# Create the standard mount directories
RUN mkdir -p /workspace/session /workspace/project

# Default working directory for tool execution
WORKDIR /workspace/project

# Use tini as PID 1 to ensure SIGTERM cleanly shuts down the Node process
ENTRYPOINT ["tini", "--", "npx", "tsx", "/app/src/runner/container-entry.ts"]
