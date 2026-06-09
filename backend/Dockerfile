FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

# Production image: skip devDependencies. The test harness pulls
# @embedded-postgres/windows-x64 (Windows-only) which cannot install on Linux,
# and is not needed at runtime — the server connects to a real Postgres.
RUN npm install --omit=dev

COPY . .

# Run the DB init script and start the server
CMD ["sh", "-c", "npm run init-db && npm start"]

EXPOSE 5000
