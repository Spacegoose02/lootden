# LootDen server image (API + web UI).
# Build: docker build -t lootden .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
# Your logos (see brand/README.md); the web build falls back to the built-in ones.
COPY brand brand
RUN npx tsc -b packages/shared packages/server && npm run build -w @lootden/web

FROM node:22-alpine
LABEL org.opencontainers.image.title="LootDen" \
      org.opencontainers.image.description="Self-hosted game library: browse, download and play the games you own" \
      org.opencontainers.image.source="https://github.com/Spacegoose02/lootden"
# The server defaults to /games, /data and port 8080; LOOTDEN_GAMES_DIR, LOOTDEN_DATA_DIR and
# LOOTDEN_PORT (or the older GM_ names) change them.
ENV NODE_ENV=production \
    PUID=99 \
    PGID=100
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --omit=dev --ignore-scripts --workspace @lootden/server --workspace @lootden/shared \
    && npm cache clean --force \
    && rm -rf packages/client packages/web/package.json packages/desktop
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist/src packages/server/dist/src
COPY --from=build /app/packages/web/dist packages/web/dist
COPY docker-entrypoint.sh /usr/local/bin/
# 7-Zip unpacks and re-zips finished downloads during import. Alpine's 7zip package is built
# without RAR, so releases shipped as .rar were never unpacked; the official static build from
# 7-zip.org has it, and the build fails if it ever doesn't. The entrypoint is made executable
# with Unix line endings here, because a Windows checkout can lose both.
ARG SEVENZIP_VERSION=2602
ARG TARGETARCH
RUN case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; arm|armv7l) arch=arm ;; 386|i686) arch=x86 ;; \
      *) echo "No 7-Zip build for ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
    && wget -qO /tmp/7z.tar.xz "https://www.7-zip.org/a/7z${SEVENZIP_VERSION}-linux-${arch}.tar.xz" \
    && apk add --no-cache --virtual .fetch-7z xz \
    && xz -dc /tmp/7z.tar.xz | tar -x -C /tmp 7zzs \
    && apk del .fetch-7z \
    && install -m 755 /tmp/7zzs /usr/local/bin/7zz && ln -s 7zz /usr/local/bin/7z \
    && rm -f /tmp/7z.tar.xz /tmp/7zzs \
    && 7zz i | sed -n '/^Codecs:/,$p' | grep -qw Rar5 \
    && mkdir -p /games /data \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh
# innoextract unpacks Inno Setup installers (most GOG games) during import, so PCs get the game
# ready to play. Without it (an architecture Alpine doesn't build it for) installers run on a PC.
RUN apk add --no-cache innoextract || echo "innoextract isn't available here; installers will run on PCs"
# TabStationToo (PCSX2 compiled to WebAssembly, GPL-3.0) for PS2 games in the browser: the build
# of the commit pinned in emulators/tabstationtoo.env, which the "PS2 browser emulator" workflow
# publishes as a release asset (scripts/build-tabstationtoo.sh). It's a separate program LootDen
# serves as it is; SOURCE.txt and COPYING.GPLv3 beside it name its source and licence. Without
# it, the image still builds and PS2 games just don't offer browser play.
ARG TABSTATIONTOO_URL=
COPY emulators/tabstationtoo.env /app/emulators/tabstationtoo.env
RUN . /app/emulators/tabstationtoo.env \
    && tag="tabstationtoo-$(echo "$TABSTATIONTOO_COMMIT" | cut -c1-12)" \
    && url="${TABSTATIONTOO_URL:-https://github.com/Spacegoose02/lootden/releases/download/$tag/$tag.tar.gz}" \
    && mkdir -p /app/emulators/tabstationtoo \
    && if wget -qO /tmp/tabstationtoo.tar.gz "$url"; then \
         tar -xzf /tmp/tabstationtoo.tar.gz -C /app/emulators/tabstationtoo && test -f /app/emulators/tabstationtoo/index.html; \
       else echo "No TabStationToo build at $url; PS2 games won't play in the browser" >&2; fi \
    && rm -f /tmp/tabstationtoo.tar.gz
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${LOOTDEN_PORT:-${GM_PORT:-8080}}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/src/index.js"]
