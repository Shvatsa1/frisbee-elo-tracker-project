FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

# Production image: install runtime deps only. The test harness pulls
# @embedded-postgres/windows-x64 (Windows-only, a devDependency) which npm
# rejects with EBADPLATFORM on Linux even while just reading the lockfile.
# --no-package-lock resolves the 5 prod deps straight from package.json
# (none platform-specific); the server connects to a real Postgres at runtime.
RUN npm install --omit=dev --no-package-lock

COPY . .

# Run the DB init script and start the server
CMD ["sh", "-c", "npm run init-db && npm start"]

EXPOSE 5000
