FROM node:20-slim

WORKDIR /app

# Install dependencies first for caching
COPY package*.json ./
RUN npm install

# Copy application source
COPY . .

# Expose ports
# 35173: Vite Dev Server (Unique)
# 33001: Express POP3 Proxy (Unique)
EXPOSE 35173 33001

# Default command (overridden by compose)
CMD ["npm", "run", "dev"]
