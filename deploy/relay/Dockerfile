# The Crew Office connectivity service, alone: one Node program with no dependencies.
# It holds no office data, so it has no volume. Build from the repository root:
#
#   docker build -f deploy/relay/Dockerfile -t crew-relay .
#
# Dockerfile.dockerignore beside this file replaces the root one for this build, and needs a Docker
# with BuildKit, the default since version 23. test/relay-image.test.cjs builds and runs all of it.

FROM node:22-alpine
WORKDIR /relay
COPY bin/crew-relay.cjs bin/crew-relay.cjs
COPY lib/relay lib/relay
USER node
ENV PORT=8443
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/_relay/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bin/crew-relay.cjs"]
