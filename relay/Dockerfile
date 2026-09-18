# Builds from the relay/ directory alone: `docker build -t opentrench-relay ./relay`.
# The repo's package-lock.json is the workspace lock at the root, so this image
# resolves the relay's few dependencies with a plain `npm install` instead of `npm ci`.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
ENV RELAY_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
