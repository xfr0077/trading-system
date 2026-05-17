# ---- builder stage ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ ./src/
COPY proto/ ./proto/

RUN npm run build

# ---- production stage ----
FROM node:20-alpine

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

USER appuser

EXPOSE 50051

CMD ["node", "dist/index.js"]
