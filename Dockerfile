FROM misskey/misskey:2026.10.0

USER root

# Native bcrypt (arm64 prebuilt) installed in an isolated dir, then copied in,
# to avoid touching the pnpm-workspace package.json of the backend.
RUN cd /tmp \
 && npm init -y >/dev/null 2>&1 \
 && npm install --no-audit --no-fund --loglevel=error @node-rs/bcrypt \
 && cp -r /tmp/node_modules/@node-rs /misskey/packages/backend/node_modules/ \
 && rm -rf /misskey/packages/backend/node_modules/bcryptjs \
           /misskey/packages/backend/node_modules/blurhash

# Drop-in shims: bcryptjs API -> native bcrypt; blurhash encode -> fixed placeholder
COPY bcryptjs-shim /misskey/packages/backend/node_modules/bcryptjs
COPY blurhash-shim /misskey/packages/backend/node_modules/blurhash

# Edge-cache friendliness: extend ActivityPub response cache lifetimes
# (30s -> 300s, 180s -> 1800s) so a Cloudflare Cache Rule can keep crawler load off the NAS.
# Quote-agnostic and digit-boundary-anchored to avoid touching max-age=300/31536000.
RUN find /misskey/packages/backend/built -name '*.js' \
      -exec sed -i -E "s/max-age=180([^0-9])/max-age=1800\1/g; s/max-age=180\$/max-age=1800/g; s/max-age=30([^0-9])/max-age=300\1/g; s/max-age=30\$/max-age=300/g" {} +

USER misskey
