FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build -w @tce/shared

EXPOSE 3000
CMD ["npm", "run", "dev", "-w", "@tce/web"]
