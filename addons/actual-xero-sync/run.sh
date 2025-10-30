#!/usr/bin/with-contenv bashio

# Start the Node.js application
bashio::log.info "Starting Actual Budget Xero Sync..."
cd /app
exec node src/app.js