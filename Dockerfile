FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data CHROMIUM_PATH=/usr/bin/chromium
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "src/main.mjs"]
