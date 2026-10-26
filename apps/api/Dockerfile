FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build -w @tce/shared

EXPOSE 3001
CMD ["sh", "-c", "npm run db:init -w @tce/api && npm run dev -w @tce/api"]
