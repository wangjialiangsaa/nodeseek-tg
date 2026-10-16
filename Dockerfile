FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "src/main.mjs"]
