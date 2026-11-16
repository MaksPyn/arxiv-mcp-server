# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    ARXIV_STORAGE_DIR=/data/papers \
    LOG_LEVEL=info
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY package.json ./
COPY prompts/ ./prompts/
RUN mkdir -p /data/papers && chown -R node:node /data
USER node
VOLUME ["/data"]
# MCP over stdio: run with `docker run -i --rm -v arxiv-data:/data arxiv-mcp-server`
ENTRYPOINT ["node", "build/index.js"]
