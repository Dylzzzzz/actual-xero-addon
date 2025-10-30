ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm python3 make g++

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --production

# Copy source code
COPY . .

# Make run script executable
RUN chmod +x run.sh

# Expose port
EXPOSE 8080

# Start the addon
CMD ["./run.sh"]