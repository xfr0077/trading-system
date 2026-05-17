FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY src/ ./src/
COPY proto/ ./proto/

RUN npm run build

EXPOSE 50051

CMD ["node", "dist/index.js"]
