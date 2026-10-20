FROM node:22.13.1-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/prune-hub-deps.js ./scripts/prune-hub-deps.js
RUN npm ci --omit=dev && node scripts/prune-hub-deps.js && npm cache clean --force

FROM node:22.13.1-bookworm-slim AS web-assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/build-web.js ./scripts/build-web.js
COPY src/shared-ui ./src/shared-ui
COPY src/hub/web ./src/hub/web
RUN npm run build:web

FROM node:22.13.1-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src/hub ./src/hub
COPY src/shared ./src/shared
# The dashboard's UI lives in the shared package: src/hub/static.js serves it
# under /ui/ and resolves /icons/clients/* from its icon tree. Without this the
# Hub boots and the API works, but every page asset 404s.
COPY src/shared-ui ./src/shared-ui
COPY --from=web-assets /app/dist/web ./dist/web
COPY assets/icon.png ./assets/icon.png
COPY docker-entrypoint.sh /usr/local/bin/jiran-hub

RUN chmod +x /usr/local/bin/jiran-hub

EXPOSE 17321
ENTRYPOINT ["/usr/local/bin/jiran-hub"]
