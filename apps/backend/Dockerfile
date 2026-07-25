# FAT backend image. Build from the REPO ROOT (needs the whole workspace):
#   docker build -f apps/backend/Dockerfile -t fat-api .
# Dev dependencies are kept in the final image on purpose: the migration/seed
# scripts run through ts-node (see package.json scripts).
FROM node:22-slim

# postgres client libs used by some tooling; curl for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@9

WORKDIR /app

# Copy the full monorepo so pnpm can resolve workspace links (@fat/shared).
COPY . .

RUN pnpm install --frozen-lockfile \
 && pnpm --filter @fat/shared build \
 && pnpm --filter @fat/backend build

EXPOSE 3001

# Apply (idempotent, additive) schema migrations, then start the API.
CMD ["sh", "-c", "pnpm backend:migration:run && node apps/backend/dist/main.js"]
