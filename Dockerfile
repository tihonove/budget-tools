# One Dockerfile, two images:
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg APP=mcp-zenmoney -t ghcr.io/tihonove/mcp-zenmoney:<sha> .
#   docker buildx build --platform linux/amd64,linux/arm64 --build-arg APP=mcp-zerro    -t ghcr.io/tihonove/mcp-zerro:<sha> .
# Sources run as is on Node (type stripping): there is no build step, the image runs what the tests ran.
ARG NODE=24.11-slim

FROM node:${NODE} AS deps
ARG APP
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w "@tihonove/${APP}" \
 && rm -rf packages

FROM node:${NODE}
ARG APP
# Links the GHCR package to the repository (visibility, README, Actions access).
LABEL org.opencontainers.image.source="https://github.com/tihonove/budget-tools"
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data APP=${APP}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["sh", "-c", "exec node packages/${APP}/bin/http.ts"]
