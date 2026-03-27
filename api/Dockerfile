FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY instructions.txt ./
EXPOSE 3000
CMD ["node", "server.js"]
