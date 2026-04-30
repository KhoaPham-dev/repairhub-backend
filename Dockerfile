FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4000

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# `--include=optional` is the default but stated explicitly so npm 10+
# definitely installs sharp's platform-specific @img/sharp-linux-* binary.
# `npm rebuild sharp` re-runs sharp's install hook against the actual
# container platform — defends against any optional-dep filtering quirk
# or stale lockfile entries that would otherwise produce
# "Could not load the 'sharp' module using the linux-x64 runtime".
RUN npm ci --omit=dev --include=optional \
 && npm rebuild sharp \
 && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

RUN groupadd --system app && useradd --system --gid app --home /app app \
 && mkdir -p /app/uploads /app/backups \
 && chown -R app:app /app
USER app

EXPOSE 4000

ENTRYPOINT ["/usr/bin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
