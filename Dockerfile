FROM oven/bun:1

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN bun install --production

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
