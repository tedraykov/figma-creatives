FROM node:22-bookworm-slim

# Chromium for rendering, plus fonts with Latin, Cyrillic and emoji coverage
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fontconfig fonts-noto-core fonts-noto-color-emoji fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PORT=3000

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY samples ./samples

# Brand fonts: mount a folder of .ttf/.otf/.woff2 files at /usr/share/fonts/custom
RUN mkdir -p /usr/share/fonts/custom && chown node:node /usr/share/fonts/custom
# UI-managed settings live here: mount a persistent volume at /app/data
RUN mkdir -p /app/data && chown node:node /app/data
ENV DATA_DIR=/app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "fc-cache -f >/dev/null 2>&1; exec node --disable-warning=ExperimentalWarning src/server.js"]
