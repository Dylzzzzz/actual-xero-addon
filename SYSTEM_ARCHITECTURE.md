# System Architecture Documentation

## Overview
This is a Home Assistant Add-on that syncs business transactions from Actual Budget to Xero accounting software via Xano API. The system consists of two main components working together in Home Assistant OS.

## System Components

### 1. Home Assistant Add-on (Main Component)
**Location**: Root directory of this repository  
**Purpose**: Orchestrates the sync process between Actual Budget and Xero  
**Technology**: Node.js Express application running in Docker container  

**Key Features**:
- Runs as a Home Assistant Add-on (port 8080)
- Web interface for configuration and monitoring
- Scheduled sync operations via cron
- Integration with Home Assistant entities and services
- Connects to Actual Budget via HTTP requests to Node.js server

**Main Files**:
- `config.yaml` - Home Assistant addon configuration
- `Dockerfile` - Container build instructions
- `src/app.js` - Main application entry point
- `src/services/actual.js` - Actual Budget client (HTTP-based)
- `src/services/xano.js` - Xano API client
- `src/services/xero.js` - Xero API client
- `web/` - Web interface files

### 2. Node.js API Server (Supporting Component)
**Location**: `nodejs-server/` directory  
**Purpose**: Provides REST API endpoints for Actual Budget operations  
**Technology**: Express.js server with @actual-app/api integration  
**Port**: 3000  

**Why This Exists**:
- Actual Budget doesn't provide REST API endpoints by default
- The @actual-app/api package requires direct integration
- This server wraps the @actual-app/api with HTTP endpoints
- Allows the Home Assistant addon to communicate with Actual Budget via HTTP

**API Endpoints Provided**:
- `GET /budgets` - List available budgets
- `POST /load-budget` - Load a specific budget
- `GET /accounts` - List accounts
- `GET /categories` - List categories
- `GET /category-groups` - List category groups
- `GET /payees` - List payees
- `GET /transactions` - Get transactions (with filtering)
- `PUT /transactions/:id` - Update transaction
- `POST /import` - Import transactions
- `POST /create_account` - Create new account
- `POST /add-categories` - Add categories

## System Flow

### 1. Initialization
1. **Node.js Server Starts**: 
   - Loads environment variables from .env file
   - Connects to Actual Budget server (e.g., http://10.0.0.230:5006)
   - Downloads and loads the specified budget
   - Exposes REST API on port 3000

2. **Home Assistant Add-on Starts**:
   - Reads configuration from Home Assistant
   - Connects to Node.js server via HTTP (http://localhost:3000)
   - Initializes web interface on port 8080

### 2. Sync Process
1. **Trigger**: Manual sync via web interface or scheduled cron job
2. **Fetch Data**: Add-on requests transactions from Node.js server
3. **Filter**: Gets reconciled transactions from specified business category group
4. **Transform**: Converts Actual Budget format to Xano format
5. **Send**: Posts transactions to Xano API
6. **Update**: Marks transactions as synced in Actual Budget
7. **Report**: Updates Home Assistant entities with sync status

### 3. Data Flow
```
Actual Budget Server (10.0.0.230:5006)
    ↓ (Direct API connection)
Node.js Server (localhost:3000)
    ↓ (HTTP REST API)
Home Assistant Add-on (localhost:8080)
    ↓ (HTTP API calls)
Xano API
    ↓ (Webhook/API)
Xero Accounting
```

## Configuration

### Node.js Server Environment Variables (.env file)
```
ACTUAL_SERVER_URL=http://10.0.0.230:5006
PASSWORD=your_actual_budget_password
BUDGET_ID=your_budget_id
IMPORT_GROUP_ID=your_import_group_id
API_KEY=your_api_key_for_authentication
```

### Home Assistant Add-on Configuration
```yaml
nodejs_server_url: "http://localhost:3000"
nodejs_api_key: "your_api_key"
business_category_group_name: "Business Expenses"
xano_api_url: "https://your-xano-instance.com/api"
xano_api_key: "your_xano_api_key"
sync_schedule: "0 2 * * 1"  # Weekly on Monday at 2 AM
```

## Deployment in Home Assistant OS

### 1. Node.js Server Deployment
- Runs as a separate service/container in Home Assistant OS
- Must be started before the add-on
- Requires .env file with Actual Budget connection details
- Accessible at localhost:3000 from within Home Assistant network

### 2. Add-on Deployment
- Installed via Home Assistant Add-on Store
- Repository URL: https://github.com/Dylzzzzz/actual-xero-addon
- Configured via Home Assistant UI
- Runs in Docker container with network access to Node.js server

## Key Integration Points

### 1. Actual Budget Integration
- **Method**: HTTP requests to Node.js server
- **Authentication**: API key in headers
- **Data**: Transactions, categories, accounts, budgets
- **Operations**: Read transactions, update transaction notes

### 2. Xano Integration  
- **Method**: Direct HTTP API calls
- **Authentication**: API key in headers
- **Data**: Formatted transaction data
- **Operations**: POST transactions, GET mappings

### 3. Xero Integration (via Xano)
- **Method**: Xano handles Xero OAuth and API calls
- **Data Flow**: Add-on → Xano → Xero
- **Operations**: Create bills, contacts, accounts

## Error Handling & Resilience

### Node.js Server
- Automatic retry on Actual Budget connection failures
- Memory management with garbage collection
- Graceful error responses with proper HTTP status codes
- Background initialization with retry logic

### Home Assistant Add-on
- Retry logic for HTTP requests to Node.js server
- Fallback configuration options
- Comprehensive logging for troubleshooting
- Home Assistant entity updates for monitoring

## Security Considerations

### Authentication
- API key authentication between add-on and Node.js server
- Separate API keys for Xano integration
- Environment variables for sensitive data

### Network Security
- Node.js server only accessible within Home Assistant network
- No external exposure of Actual Budget credentials
- HTTPS for external API calls (Xano/Xero)

## Troubleshooting Common Issues

### "No budget loaded" Error
- Check Node.js server is running and accessible
- Verify ACTUAL_SERVER_URL and credentials in .env
- Ensure budget ID is correct and budget exists

### Connection Failures
- Verify network connectivity between components
- Check API keys and authentication
- Review logs in both Node.js server and add-on

### Sync Failures
- Check Xano API connectivity and credentials
- Verify transaction data format compatibility
- Review category group configuration

## Development Notes

### Why HTTP Architecture?
- Actual Budget API (@actual-app/api) doesn't provide REST endpoints
- Home Assistant add-ons work better with HTTP-based integrations
- Separation of concerns: Node.js handles Actual Budget complexity, add-on handles business logic
- Easier testing and debugging with standard HTTP requests

### Future Enhancements
- Real-time sync via webhooks
- Multiple budget support
- Enhanced error reporting
- Performance optimizations
- Additional accounting software integrations

This architecture provides a robust, maintainable solution for syncing financial data between Actual Budget and Xero while working within Home Assistant's ecosystem constraints.