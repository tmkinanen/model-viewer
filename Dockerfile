# Minimal production Dockerfile for Azure App Service for Containers / Azure Container Apps
# Use a slim Node LTS image
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install git and CA certificates for Azure DevOps cloning
RUN apk add --no-cache git openssh ca-certificates

# Copy only necessary files
COPY package.json package-lock.json* ./

# No dependencies to install, but keep npm ci for future deps
RUN npm ci --omit=dev || true

# Copy the rest of the application
COPY . .

# The server listens on process.env.PORT; expose common port for local runs
EXPOSE 3000

# Start the Node server
CMD ["node", "index.js"]
