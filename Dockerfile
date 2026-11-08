# Build stage: all dependencies, compile the code (pnpm run build).
# pnpm comes from npm at the version of packageManager in package.json (change both together), as Node 25 and later
# ship no corepack; --allow-scripts names the one install script that runs, pnpm's own, which links its native
# binary. pnpm-workspace.yaml comes with the manifests: no install script of a dependency runs, here or in the deps
# stage. The store stays in the build cache, outside the image.
FROM node:26-alpine AS build
RUN npm install --global --allow-scripts=pnpm pnpm@12.14.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm pnpm install --frozen-lockfile --store-dir /var/cache/pnpm
COPY . .
RUN pnpm run build

# Production dependencies only: pnpm and npm's cache stay out of the runtime image.
FROM node:26-alpine AS deps
RUN npm install --global --allow-scripts=pnpm pnpm@12.14.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm pnpm install --frozen-lockfile --prod --store-dir /var/cache/pnpm
COPY prisma ./prisma
COPY prisma.config.ts ./
# The migration engine comes from an install script, which never runs: fetch it now, at build time, not on start
RUN ./node_modules/.bin/prisma version

# Runtime stage: production dependencies and compiled code only, as the unprivileged node user.
FROM node:26-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=build /app/dist ./dist
# Read out of the image by the deploy, which runs them only once the owner approved their hash (deploy/deploy-entry.sh)
COPY docker-compose.yml ./
COPY deploy ./deploy
USER node
# Migrations run before the app starts, so the app runs as one replica (docs/deployment.md)
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
