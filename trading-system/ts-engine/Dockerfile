# ---- builder stage ----
FROM node:20-slim AS builder

WORKDIR /app

COPY ts-engine/package.json ts-engine/package-lock.json* ./
COPY ts-engine/tsconfig.json ./
RUN npm install

COPY ts-engine/src/ ./src/
COPY proto/ ./proto/

RUN npm run build

# ---- production stage ----
FROM node:20-slim

# Install Python3 + lighter SDK for bridge
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip && \
    pip3 install lighter-sdk --break-system-packages && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ts-engine/package.json ts-engine/package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY proto/ ./proto/
COPY ts-engine/lighter_bridge.py ./lighter_bridge.py

EXPOSE 50051

CMD ["node", "dist/index.js"]
