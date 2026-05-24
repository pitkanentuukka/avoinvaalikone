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

# Expose port
EXPOSE 3000

# Start the application
CMD ["sh", "-c", "npm run migrate && npm start"]
