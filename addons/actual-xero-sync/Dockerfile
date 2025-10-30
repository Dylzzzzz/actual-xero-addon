ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and build tools
RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production && npm cache clean --force

COPY src/ ./src/
COPY web/ ./web/
COPY config.yaml ./
COPY run.sh ./

RUN mkdir -p /app/logs && \
    chmod -R 755 /app && \
    chmod +x run.sh

# Home Assistant add-ons need root access to read /data/options.json
EXPOSE 8080
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV PORT=8080

CMD ["node", "src/app.js"]
