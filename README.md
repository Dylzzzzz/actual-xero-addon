# Actual Budget Xero Sync Add-on

Home Assistant Add-on to sync business transactions from Actual Budget to Xero via Xano.

## Features

- Syncs reconciled transactions from Actual Budget
- Integrates with Xero accounting via Xano API
- Configurable sync schedules and filters
- Built-in Node.js server for Actual Budget API integration

## Installation

1. Add this repository to your Home Assistant Add-on Store
2. Install the "Actual-Xero Sync" add-on
3. Configure the add-on with your API credentials
4. Start the add-on

## Configuration

### Required Settings
- `nodejs_server_url`: URL of the Node.js server (default: http://localhost:3000)
- `nodejs_api_key`: API key for authentication
- `business_category_group_name`: Name of the business category group in Actual Budget
- `xano_api_url`: Your Xano API endpoint
- `xano_api_key`: Your Xano API key

### Optional Settings
- `sync_schedule`: Cron schedule for automatic syncing
- `sync_days_back`: Number of days to look back for transactions
- `dry_run_mode`: Test mode without making actual changes

## Node.js Server

The add-on includes a Node.js server component that provides API endpoints for Actual Budget integration. The server handles:

- Budget and account management
- Transaction import/export
- Category and payee synchronization

## Support

For issues and support, please visit the [GitHub repository](https://github.com/Dylzzzzz/actual-xero-addon).