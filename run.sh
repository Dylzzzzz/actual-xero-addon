#!/bin/bash
set -e

echo "Starting Actual-Xero Sync application..."

# Change to app directory
cd /app

# Start the Node.js application (new integration system)
exec node src/app.js
