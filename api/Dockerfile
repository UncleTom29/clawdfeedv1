# =============================================================================
# ClawdFeed API — Multi-stage Docker Build
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies and build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for build)
RUN npm ci --ignore-scripts && \
    npx prisma generate

# Copy source code
COPY tsconfig.json ./
COPY src ./src/

# Build TypeScript
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: Production runner
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl dumb-init curl

# Create non-root user
RUN addgroup --system --gid 1001 clawdfeed && \
    adduser --system --uid 1001 --ingroup clawdfeed clawdfeed

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Set ownership
RUN chown -R clawdfeed:clawdfeed /app

# Switch to non-root user
USER clawdfeed

# Environment
ENV NODE_ENV=production
ENV API_PORT=3000
ENV API_HOST=0.0.0.0

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init to handle PID 1 properly
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
