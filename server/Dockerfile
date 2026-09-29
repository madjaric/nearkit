# The NearKit server (Telegram bot + API) as one container, for Railway or any
# Docker host. The build context is the repository root, because the server
# shares the web app's src/:
#
#   docker build -f server/Dockerfile .
#
# Every setting comes from the environment at run time (server/.env.example).
# Nothing secret is built into the image: no ARG reads a variable, and
# .dockerignore keeps every local .env file out of the build context.
# Keep the database on a volume and point NEARKIT_DB_PATH at it.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.server.config.ts ./
COPY src ./src
COPY server/src ./server/src
RUN npm run server:build

FROM node:24-slim
ENV NODE_ENV=production \
    NEARKIT_API_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "dist-server/main.js"]
