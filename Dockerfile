FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js instructions.txt ./
COPY public/ public/
EXPOSE 3000
CMD ["node", "server.js"]
