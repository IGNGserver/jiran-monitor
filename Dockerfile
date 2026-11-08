FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/prune-hub-deps.js ./scripts/prune-hub-deps.js
RUN npm ci --omit=dev && node scripts/prune-hub-deps.js && npm cache clean --force

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS web-assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/build-web.js scripts/build-pwa-icons.js ./scripts/
COPY src/shared-ui ./src/shared-ui
COPY src/hub/web ./src/hub/web
RUN npm run build:web

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS runtime

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

# The Hub needs no write access to its image and binds an unprivileged port, so it
# runs as the image's unprivileged user. Anything the process still needs to write
# belongs in a tmpfs (see the Compose `read_only` + `tmpfs` settings); mounted TLS
# material must be readable by uid 1000.
USER node

EXPOSE 17321
ENTRYPOINT ["/usr/local/bin/jiran-hub"]
