# The NEARKITS server image (the app: Telegram bot + API; the signer; the buy bot), built on the
# VPS by deploy/vps/deploy.sh. The build context is the repository root, because the server
# shares the web app's src/:
#
#   docker build --build-arg NEARKIT_BUILD_SHA=<commit> -f server/Dockerfile .
#
# Every setting comes from the environment at run time (deploy/vps/*.env.example). Nothing secret
# is built into the image: the one ARG is the commit being built (shown on /health as "version"),
# and .dockerignore keeps every local .env file out of the build context.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.server.config.ts ./
COPY src ./src
COPY server/src ./server/src
RUN npm run server:build

FROM node:24-slim
ARG NEARKIT_BUILD_SHA=
ENV NODE_ENV=production \
    NEARKIT_API_HOST=0.0.0.0 \
    NEARKIT_BUILD_SHA=$NEARKIT_BUILD_SHA
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
CMD ["node", "--disable-warning=ExperimentalWarning", "--enable-source-maps", "dist-server/main.js"]
