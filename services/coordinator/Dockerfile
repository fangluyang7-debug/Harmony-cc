FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci --workspace @harmony/coordinator --include-workspace-root && npm --workspace @harmony/coordinator run build
ENV NODE_ENV=production COORDINATOR_TLS_MODE=proxy COORDINATOR_HOST=0.0.0.0 COORDINATOR_CPU_HOST=1 COORDINATOR_DOMAIN=REAL COORDINATOR_DATA_DIR=/data/coordinator COORDINATOR_WEB_DIR=/app/apps/team-space-web
CMD ["sh", "-c", "npm --workspace @harmony/coordinator run db:init && node services/coordinator/dist/main.js"]
