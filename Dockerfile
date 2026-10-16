FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "src/main.mjs"]
