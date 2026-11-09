FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/app/data HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --chown=node:node . .
RUN node scripts/build-branding.mjs && mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","self-host/healthcheck.mjs"]
CMD ["node","self-host/start.mjs"]
