FROM oven/bun:1.3.14-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
USER bun
EXPOSE 3000

CMD ["bun", "run", "start"]
