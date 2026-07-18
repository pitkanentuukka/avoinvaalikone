# Backend Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src ./src
COPY migrations ./migrations

# Run as the unprivileged node user (the app writes nothing to disk)
USER node

# Expose port
EXPOSE 3000

# exec makes node PID 1 so it receives SIGTERM for graceful shutdown
# (under `npm start` the signal stops at npm/sh and requests get dropped).
CMD ["sh", "-c", "node migrations/run.js && exec node src/index.js"]
