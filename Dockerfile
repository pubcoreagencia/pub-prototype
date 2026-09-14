FROM node:20-bookworm-slim

# Install system dependencies (git, wget, ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install cloudflared
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
        wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb; \
        dpkg -i cloudflared-linux-amd64.deb; \
        rm cloudflared-linux-amd64.deb; \
    elif [ "$ARCH" = "arm64" ]; then \
        wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb; \
        dpkg -i cloudflared-linux-arm64.deb; \
        rm cloudflared-linux-arm64.deb; \
    else \
        echo "Unsupported architecture: $ARCH" && exit 1; \
    fi

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/
COPY tests/ ./tests/

# Default CMD (can be overridden by Railway / Docker run to 'npm run pp:worker')
CMD ["npm", "run", "pp:api"]
