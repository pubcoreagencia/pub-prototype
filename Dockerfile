# Stage 1: Build
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:22-bookworm-slim AS production

# Install runtime dependencies (git, wget, ca-certificates, dumb-init)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    wget \
    ca-certificates \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set global git config for the worker's commits
RUN git config --system user.name "PUB Prototype Worker" && \
    git config --system user.email "bot@pubcore.com" && \
    git config --system init.defaultBranch "main"

# Pin cloudflared version for reproducibility and verify checksums
ENV CLOUDFLARED_VERSION=2024.8.3
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
        EXPECTED_SHA256="7738cf3cce463574c3cd18b15c1a42c783d0e5b1a1d1f3988f3dd5916c0ea842"; \
        wget -q https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb; \
        echo "${EXPECTED_SHA256}  cloudflared-linux-amd64.deb" | sha256sum -c -; \
        dpkg -i cloudflared-linux-amd64.deb; \
        rm cloudflared-linux-amd64.deb; \
    elif [ "$ARCH" = "arm64" ]; then \
        EXPECTED_SHA256="964521c37b45a8016b7ca23223c46747657e6e0e78576bc3ba5247aaf5cc162c"; \
        wget -q https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64.deb; \
        echo "${EXPECTED_SHA256}  cloudflared-linux-arm64.deb" | sha256sum -c -; \
        dpkg -i cloudflared-linux-arm64.deb; \
        rm cloudflared-linux-arm64.deb; \
    else \
        echo "Unsupported architecture: $ARCH" && exit 1; \
    fi

WORKDIR /app

# Setup workspace directory with non-root permissions
# ONLY /tmp/pub-prototype is owned by node. /app remains owned by root.
RUN mkdir -p /tmp/pub-prototype && chown -R node:node /tmp/pub-prototype

COPY package.json package-lock.json ./
# Install only production dependencies (as root, so node cannot tamper with node_modules)
RUN npm ci --omit=dev

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist

# Drop privileges to non-root user
USER node

# Use dumb-init to reap zombies and forward signals correctly
ENTRYPOINT ["dumb-init", "--"]

# Default CMD (API)
CMD ["node", "dist/pp/api/entry.js"]
