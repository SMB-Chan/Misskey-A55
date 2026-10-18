FROM misskey/misskey:2026.10.0

USER root

# Native bcrypt for the bundle rewrite. Installed aside from the pnpm
# workspace so the backend package.json is left untouched.
# Build this image on the NAS (linux/arm64). npm selects the matching
# @node-rs/bcrypt binary for the builder's CPU.
RUN cd /tmp \
 && npm init -y >/dev/null 2>&1 \
 && npm install --no-audit --no-fund --loglevel=error @node-rs/bcrypt@1.10.7 \
 && mkdir -p /misskey/packages/backend/node_modules \
 && cp -a /tmp/node_modules/@node-rs /misskey/packages/backend/node_modules/

COPY patch-built.mjs /tmp/a55-patch-built.mjs

# ActivityPub cache lifetimes, then the A55 bundle and sharp patches.
# The sed is quote-agnostic and digit-boundary-anchored so max-age=300
# and max-age=31536000 are left alone.
RUN find /misskey/packages/backend/built -name '*.js' \
      -exec sed -i -E "s/max-age=180([^0-9])/max-age=1800\1/g; s/max-age=180\$/max-age=1800/g; s/max-age=30([^0-9])/max-age=300\1/g; s/max-age=30\$/max-age=300/g" {} + \
 && node /tmp/a55-patch-built.mjs \
 && rm -f /tmp/a55-patch-built.mjs

# Peers render NodeInfo software.name plus software.version. The name stays
# "misskey". Only built/meta.json changes: config.ts reads it at startup into
# NodeInfo, /api/meta, and the User-Agent. The frontend bundle keeps 2026.10.0,
# so locale URLs and the local about page stay on that string.
# 2026.10.0-A55.4 is a semver pre-release and sorts before 2026.10.0.
RUN node -e 'const fs=require("node:fs");const p="/misskey/built/meta.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));const ok=["2026.10.0","2026.10.0-A55","2026.10.0-A55.2","2026.10.0-A55.3","2026.10.0-A55.4","2026.10.0-A55.5"];if(!ok.includes(j.version))throw new Error("unexpected meta.version: "+j.version);j.version="2026.10.0-A55.5";fs.writeFileSync(p,JSON.stringify(j));const again=JSON.parse(fs.readFileSync(p,"utf8"));if(again.version!=="2026.10.0-A55.5")throw new Error("meta.json write failed");'

# The base image preloads jemalloc. Return freed pages sooner and use fewer
# arenas so the container's resident set stays well under its 768m cap; the
# 2GB host cannot afford retained dirty pages while QTS is swapping.
ENV MALLOC_CONF=dirty_decay_ms:5000,muzzy_decay_ms:5000,narenas:2

USER misskey
