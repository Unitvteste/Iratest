FROM node:22.23.4-bookworm-slim

ENV NODE_ENV=production
ENV IRACEMA_DISABLE_LOCAL_M3U=1
# O processo confiável precisa de permissão para reduzir os workers Kamirama a nobody.
USER root
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 3000
CMD ["npm", "start"]
