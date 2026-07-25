# FAT frontend image. Build from the REPO ROOT:
#   docker build -f apps/frontend/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://yourdomain.com/api -t fat-web .
# NEXT_PUBLIC_API_URL is baked into the bundle here, so it must be passed at
# build time and the image rebuilt if the public API URL changes.
FROM node:22-slim

RUN npm install -g pnpm@9
WORKDIR /app

COPY . .

ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN pnpm install --frozen-lockfile \
 && pnpm --filter @fat/shared build \
 && pnpm --filter @fat/frontend build

EXPOSE 3000

CMD ["pnpm", "--filter", "@fat/frontend", "start"]
