FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Run the DB init script and start the server
CMD ["sh", "-c", "npm run init-db && npm start"]

EXPOSE 5000
