# Frontend Dockerfile - Multi-stage build
FROM node:24-alpine as build

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build-time env vars
ARG VITE_NODE_ENV=production
ENV VITE_NODE_ENV=${VITE_NODE_ENV}
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}

# Build the application
RUN npm run build

# Production stage with nginx. The unprivileged image runs as uid 101 and
# listens on 8080 (non-root processes can't bind 80) — Caddy and the compose
# port mappings point at 8080 accordingly.
FROM nginxinc/nginx-unprivileged:alpine

# Copy built assets from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Fails the build, and so the deploy before `up`, on a config this nginx
# rejects, rather than crash-looping the frontend: the deploy pulls the
# newest nginx each time (#216). No DNS needed: the backend is resolved at
# request time (proxy_pass with a variable).
RUN nginx -t

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
