# Build stage: all dependencies, compile the code (npm run build).
# .npmrc comes with the manifests: install scripts of dependencies never run, here or in the runtime stage.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# Runtime stage: production dependencies and compiled code only, as the unprivileged node user.
FROM node:24-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY prisma ./prisma
COPY prisma.config.ts ./
# The migration engine comes from an install script, which never runs: fetch it now, at build time, not on start
RUN ./node_modules/.bin/prisma version
COPY --from=build /app/dist ./dist
# Read out of the image by the deploy, which runs them only once the owner approved their hash (deploy/deploy-entry.sh)
COPY docker-compose.yml ./
COPY deploy ./deploy
USER node
# Migrations run before the app starts, so the app runs as one replica (docs/deployment.md)
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
