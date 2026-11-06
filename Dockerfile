# Startet Daybreak. Die Daten liegen im Ordner /data, den du als Volume einbinden solltest.
FROM node:22-trixie-slim

# pg_dump für Sicherungen, falls PostgreSQL eingestellt wird. Das Programm ist Version 17 und
# sichert Server bis Version 17. Für einen neueren Server braucht es ein neueres Programm.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DAYBREAK_DB_PATH=/data/loop.db
ENV DAYBREAK_DATA_DIR=/data/data
ENV DAYBREAK_BACKUP_ROOT=/data/backups
ENV DAYBREAK_ENV_FILE=/data/daybreak.env

EXPOSE 3000
CMD ["node", "server.js"]
