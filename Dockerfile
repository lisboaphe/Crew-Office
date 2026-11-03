# Crew Office — dedicated server image (Mode B), and optionally an always-on agent worker.
#
#   docker compose up -d                 # host only, data in the `crew-data` volume
#   docker compose --profile worker up -d   # plus an always-on worker for your own agents
#
# The host image never needs an API key. A worker container does — but only the keys of
# the player who runs it, injected through the environment (see .env.example).

FROM node:24-slim
WORKDIR /app

COPY *.html styles.css favicon.ico server.cjs package.json ./
COPY THIRD_PARTY_NOTICES.txt ./
COPY docs/*.html ./docs/
COPY docs/site ./docs/site
COPY docs/images ./docs/images
COPY docs/examples ./docs/examples
COPY plugins ./plugins
COPY assets ./assets
COPY lib ./lib
COPY src ./src
COPY vendor ./vendor
COPY admin ./admin
COPY agent-setup ./agent-setup
COPY crew ./crew

# Runtime dependencies only: the Anthropic SDK the worker's Claude adapter uses. The host
# itself has none.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

ENV HOST=0.0.0.0 \
    PORT=8080 \
    CREW_MODE=dedicated \
    ROVING_OFFICE_STATE_DIR=/data \
    CREW_WORKER_DIR=/data/worker
VOLUME ["/data"]
EXPOSE 8080

USER node
CMD ["node", "server.cjs"]
