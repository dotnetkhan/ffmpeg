FROM node:18
RUN apt-get update && apt-get install -y ffmpeg
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
CMD ["node", "server.js"]
