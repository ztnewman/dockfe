FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

EXPOSE 3737

CMD ["node", "server.js"]
