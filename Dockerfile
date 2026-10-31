# Container build for Fly.io (and any Docker host).
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci
COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci

COPY . .
RUN npm --prefix web run build \
 && chown -R node:node /app

USER node
EXPOSE 8080
# Runs migrations, the idempotent admin seed, then the API (which also serves the web app).
CMD ["npm", "start"]
