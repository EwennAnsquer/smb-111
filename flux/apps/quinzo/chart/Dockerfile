# Quinzo — quiz multijoueur en réseau local
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    IN_DOCKER=1 \
    NO_OPEN=1 \
    PORT=3000 \
    DATA_DIR=/data

RUN apk add --no-cache su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY themes ./themes

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i "s/\r$//" /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data

# /data contient tes thèmes (themes/) et le compte admin (admin.json)
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
