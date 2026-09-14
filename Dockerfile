# Stage 1: Build
FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production
FROM node:20-bookworm-slim AS production

# Install runtime dependencies (git, wget, ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set global git config for the worker's commits
RUN git config --system user.name "PUB Prototype Worker" && \
    git config --system user.email "bot@pubcore.com" && \
    git config --system init.defaultBranch "main"

# Pin cloudflared version for reproducibility
ENV CLOUDFLARED_VERSION=2024.8.3
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
        wget -q https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb; \
        dpkg -i cloudflared-linux-amd64.deb; \
        rm cloudflared-linux-amd64.deb; \
    elif [ "$ARCH" = "arm64" ]; then \
        wget -q https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64.deb; \
        dpkg -i cloudflared-linux-arm64.deb; \
        rm cloudflared-linux-arm64.deb; \
    else \
        echo "Unsupported architecture: $ARCH" && exit 1; \
    fi

WORKDIR /app

# Setup workspace directory with non-root permissions
RUN mkdir -p /tmp/pub-prototype && chown -R node:node /app /tmp/pub-prototype

COPY package.json package-lock.json ./
# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist

# Drop privileges to non-root user
USER node

# Default CMD (API)
CMD ["node", "dist/pp/api/entry.js"]
