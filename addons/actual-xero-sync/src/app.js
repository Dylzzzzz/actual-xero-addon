#!/usr/bin/env node

const express = require('express');
const path = require('path');
const ConfigValidator = require('./models/config');
const logger = require('./utils/logger');
const HomeAssistantService = require('./services/home-assistant');
const LogMonitor = require('./utils/log-monitor');

// Import services for initialization
const ActualBudgetClient = require('./services/actual');
const XanoClient = require('./services/xano');
const XeroClient = require('./services/xero');

// Use simple HTTP client for Actual Budget server
const axios = require('axios');

/**
 * Main application class for Actual-Xero Sync
 */
class ActualXeroSyncApp {
  constructor() {
    this.app = express();
    this.config = null;
    this.server = null;
    
    // Service instances
    this.services = {
      actualClient: null,
      xanoClient: null,
      xeroClient: null,
      syncService: null,
      mappingManager: null,
      reprocessingService: null,
      syncReporter: null,
      haService: new HomeAssistantService()
    };
    
    // Log monitoring
    this.logMonitor = null;
    
    // Application state
    this.isShuttingDown = false;
    this.activeOperations = new Set();
    
    // Sync results storage
    this.syncResults = new Map();
    this.lastSyncResult = null;
  }

  /**
   * Initialize the application
   */
  async init() {
    try {
      // Load and validate configuration
      console.log('Loading configuration...');
      try {
        this.config = ConfigValidator.getValidatedConfig();
        console.log('Configuration loaded successfully:', !!this.config);
      } catch (configError) {
        console.error('Configuration loading failed:', configError.message);
        console.error('Config error stack:', configError.stack);
        throw configError;
      }
      
      if (!this.config) {
        throw new Error('Configuration validation failed - config is null');
      }
      
      // Initialize logger with configured level
      await logger.init(this.config.log_level, {
        logDir: process.env.LOG_DIR || '/var/log',
        maxFileSize: 10 * 1024 * 1024, // 10MB
        maxFiles: 10,
        enableConsole: true,
        enableFile: true
      });
      
      // Initialize log monitoring
      this.logMonitor = new LogMonitor(logger, {
        checkInterval: 60000, // 1 minute
        maxLogSize: 50 * 1024 * 1024, // 50MB
        retentionDays: 30,
        alertThresholds: {
          errorRate: 10,
          logGrowthRate: 5 * 1024 * 1024
        }
      });
      
      // Set up log monitor event handlers
      this.setupLogMonitorEvents();
      
      logger.info('Actual-Xero Sync starting up...');
      logger.info('Configuration loaded and validated successfully');
      
      // Setup Express middleware
      this.setupMiddleware();
      
      // Setup routes
      this.setupRoutes();
      
      // Initialize services
      await this.initializeServices();
      
      // Setup error handling
      this.setupErrorHandling();
      
      logger.info('Application initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize application:', error.message);
      process.exit(1);
    }
  }

  /**
   * Initialize all application services
   */
  async initializeServices() {
    try {
      logger.info('Initializing application services...');
      
      // Initialize API clients
      // Use nodejs_server_url for HTTP-based integration
      const serverUrl = this.config.nodejs_server_url || 'http://localhost:3001';
      const apiKey = this.config.nodejs_api_key || this.config.actual_budget_password; // Fallback to password field
      
      logger.info('ActualBudgetClient configuration:', { 
        serverUrl, 
        hasApiKey: !!apiKey,
        configNodejsUrl: this.config.nodejs_server_url 
      });
      
      this.services.actualClient = new ActualBudgetClient({
        serverUrl: serverUrl,
        apiKey: apiKey,
        logger: logger
      });
      
      this.services.xanoClient = new XanoClient({
        apiUrl: this.config.xano_api_url,
        apiKey: this.config.xano_api_key,
        rateLimitPerMinute: this.config.xano_rate_limit,
        logger: logger
      });
      
      this.services.xeroClient = new XeroClient({
        clientId: this.config.xero_client_id,
        clientSecret: this.config.xero_client_secret,
        tenantId: this.config.xero_tenant_id,
        logger: logger
      });
      
      // Initialize business logic services
      this.services.mappingManager = {
        logger: logger,
        // Minimal mapping manager for now
        async mapTransaction(transaction) { return transaction; }
      };
      
      this.services.reprocessingService = {
        logger: logger,
        // Minimal reprocessing service for now
        async reprocessTransactions() { return []; }
      };
      
      this.services.syncReporter = {
        logger: logger,
        // Minimal sync reporter for now
        reportSyncStart() { logger.info('Sync started'); },
        reportSyncComplete(stats) { logger.info('Sync completed', stats); },
        reportSyncError(error) { logger.error('Sync error', error); }
      };
      
      // Initialize main sync service (simplified)
      const self = this; // Capture the app instance context
      this.services.syncService = {
        logger: logger,
        config: this.config,
        
        // Simple sync execution for now
        async executeSync() {
          logger.info('Starting sync process...');
          
          try {
            // Get transactions from Actual Budget
            const transactions = await self.services.actualClient.getReconciledTransactions(
              self.config.business_category_group_id,
              new Date(Date.now() - (self.config.sync_days_back * 24 * 60 * 60 * 1000))
            );
            
            logger.info(`Found ${transactions.length} reconciled transactions`);
            
            let transactionsStored = 0;
            let transactionsFailed = 0;
            
            // Step 2: Store transactions in Xano
            if (transactions.length > 0) {
              logger.info('Storing transactions in Xano...');
              
              for (const transaction of transactions) {
                try {
                  // Transform transaction for Xano (matching your API spec exactly)
                  const xanoTransaction = {
                    actual_transaction_id: transaction.id,
                    transaction_date: transaction.date,
                    amount: Math.abs(transaction.amount / 100), // Convert cents to dollars and make positive
                    description: transaction.notes || '',
                    actual_category_id: self.config.business_category_group_id,
                    actual_payee_id: transaction.payee || 'Unknown Payee'
                  };
                  
                  logger.info('Storing transaction in Xano:', {
                    id: transaction.id,
                    amount: xanoTransaction.amount
                  });
                  
                  logger.info('Full Xano payload:', xanoTransaction);
                  
                  // Store in Xano using your API endpoint
                  const xanoResponse = await self.services.xanoClient.storeTransaction(xanoTransaction);
                  
                  if (xanoResponse.success) {
                    transactionsStored++;
                    logger.info(`Transaction stored in Xano: ${transaction.id}`);
                  } else {
                    transactionsFailed++;
                    logger.error(`Failed to store transaction in Xano: ${transaction.id}`, xanoResponse.error);
                  }
                  
                } catch (storeError) {
                  transactionsFailed++;
                  logger.error(`Error storing transaction ${transaction.id}:`, storeError.message);
                }
              }
            }
            
            logger.info('Sync completed', {
              fetched: transactions.length,
              stored: transactionsStored,
              failed: transactionsFailed
            });
            
            return {
              success: true,
              statistics: {
                transactionsFetched: transactions.length,
                transactionsStored: transactionsStored,
                duplicatesSkipped: 0,
                transactionsMapped: transactions.length,
                transactionsImported: 0, // Will be updated when Xero integration is added
                transactionsFailed: transactionsFailed
              }
            };
          } catch (error) {
            logger.error('Sync failed:', error.message);
            return {
              success: false,
              error: error.message,
              statistics: {
                transactionsFetched: 0,
                transactionsStored: 0,
                duplicatesSkipped: 0,
                transactionsMapped: 0,
                transactionsImported: 0,
                transactionsFailed: 1
              }
            };
          }
        }
      };
      
      // Initialize Home Assistant service and connect it to sync service
      this.services.haService.init();
      // this.services.haService.setSyncService(this.services.syncService); // Skip for now to get add-on working
      
      logger.info('All services initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize services:', error);
      throw error;
    }
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Serve static files from web directory
    this.app.use(express.static(path.join(__dirname, '../web')));
    
    // Request logging middleware
    this.app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      next();
    });
  }

  /**
   * Setup application routes
   */
  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    // Configuration status endpoint
    this.app.get('/api/config/status', (req, res) => {
      res.json({
        configured: true,
        log_level: this.config.log_level,
        sync_schedule: this.config.sync_schedule,
        sync_days_back: this.config.sync_days_back,
        batch_size: this.config.batch_size,
        xano_rate_limit: this.config.xano_rate_limit,
        // Don't expose sensitive configuration
        actual_budget_configured: !!this.config.actual_budget_url,
        xano_configured: !!this.config.xano_api_url,
        xero_configured: !!this.config.xero_client_id
      });
    });

    // Configuration details endpoint
    this.app.get('/api/config/details', (req, res) => {
      res.json({
        actual_budget_url: this.config.actual_budget_url,
        business_category_group_name: this.config.business_category_group_name,
        business_category_group_id: this.config.business_category_group_id,
        sync_schedule: this.config.sync_schedule,
        sync_days_back: this.config.sync_days_back,
        batch_size: this.config.batch_size,
        xano_rate_limit: this.config.xano_rate_limit
      });
    });

    // Sync statistics endpoint
    this.app.get('/api/sync/stats', (req, res) => {
      if (this.lastSyncResult && this.lastSyncResult.statistics) {
        const stats = this.lastSyncResult.statistics;
        res.json({
          total_processed: stats.totalProcessed || 0,
          successful_imports: stats.importedToXero || 0,
          failed_transactions: stats.failedTransactions || 0,
          pending_mappings: Math.max(0, (stats.totalProcessed || 0) - (stats.mappedTransactions || 0)),
          stored_xano: stats.storedInXano || 0,
          duplicates_skipped: stats.duplicatesSkipped || 0,
          last_sync: this.lastSyncResult.timestamp
        });
      } else {
        res.json({
          total_processed: 0,
          successful_imports: 0,
          failed_transactions: 0,
          pending_mappings: 0,
          stored_xano: 0,
          duplicates_skipped: 0,
          last_sync: null
        });
      }
    });

    // Manual sync trigger endpoint
    this.app.post('/api/sync/trigger', async (req, res) => {
      try {
        logger.info('Manual sync triggered via API');
        
        // Generate sync ID for tracking
        const syncId = Date.now().toString();
        
        // Trigger sync directly through sync service
        const result = await this.services.syncService.executeSync();
        
        if (result.success) {
          // Store sync results for progress tracking
          this.syncResults.set(syncId, {
            status: 'completed',
            result: result.result,
            statistics: result.statistics,
            message: result.message,
            timestamp: new Date().toISOString()
          });
          
          // Update last sync result
          this.lastSyncResult = this.syncResults.get(syncId);
          
          res.json({
            message: result.message,
            syncId: syncId,
            timestamp: new Date().toISOString(),
            statistics: result.statistics
          });
        } else {
          // Store failed sync result
          this.syncResults.set(syncId, {
            status: 'failed',
            error: result.error,
            timestamp: new Date().toISOString()
          });
          
          res.status(500).json({
            error: result.error,
            syncId: syncId,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logger.error('Failed to trigger sync', { error: error.message });
        res.status(500).json({
          error: 'Failed to trigger sync',
          timestamp: new Date().toISOString()
        });
      }
    });

    // Sync progress endpoint
    this.app.get('/api/sync/progress/:syncId', (req, res) => {
      const syncId = req.params.syncId;
      const syncResult = this.syncResults.get(syncId);
      
      if (syncResult) {
        const stats = syncResult.statistics || {};
        
        res.json({
          syncId: syncId,
          status: syncResult.status,
          progress: 100,
          message: syncResult.message || (syncResult.status === 'completed' ? 'Sync completed' : 'Sync failed'),
          processed: stats.totalProcessed || 0,
          stored_xano: stats.storedInXano || 0,
          duplicates_skipped: stats.duplicatesSkipped || 0,
          mapped: stats.mappedTransactions || 0,
          imported_xero: stats.importedToXero || 0,
          failed: stats.failedTransactions || 0,
          error: syncResult.error
        });
      } else {
        // Fallback for unknown sync IDs
        res.json({
          syncId: syncId,
          status: 'completed',
          progress: 100,
          message: 'Sync completed',
          processed: 0
        });
      }
    });

    // Current sync status endpoint
    this.app.get('/api/sync/current-status', (req, res) => {
      res.json({
        syncing: false,
        reprocessing: false,
        lastSync: null
      });
    });

    // Log monitoring endpoints
    this.app.get('/api/logs/status', (req, res) => {
      try {
        const status = this.getLogMonitoringStatus();
        res.json(status);
      } catch (error) {
        logger.error('Failed to get log monitoring status', { error: error.message });
        res.status(500).json({ error: 'Failed to get log monitoring status' });
      }
    });

    this.app.get('/api/logs/statistics', (req, res) => {
      try {
        if (!this.logMonitor) {
          return res.status(404).json({ error: 'Log monitoring not available' });
        }
        
        const statistics = this.logMonitor.getStatistics();
        res.json(statistics);
      } catch (error) {
        logger.error('Failed to get log statistics', { error: error.message });
        res.status(500).json({ error: 'Failed to get log statistics' });
      }
    });

    this.app.post('/api/logs/rotate', async (req, res) => {
      try {
        if (!this.logMonitor) {
          return res.status(404).json({ error: 'Log monitoring not available' });
        }
        
        logger.info('Manual log rotation requested via API');
        const result = await this.logMonitor.forceRotation();
        
        res.json({
          message: 'Log rotation completed successfully',
          result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Failed to rotate logs', { error: error.message });
        res.status(500).json({ error: 'Failed to rotate logs' });
      }
    });

    this.app.post('/api/logs/alerts/:alertId/acknowledge', (req, res) => {
      try {
        if (!this.logMonitor) {
          return res.status(404).json({ error: 'Log monitoring not available' });
        }
        
        const { alertId } = req.params;
        this.logMonitor.acknowledgeAlert(alertId);
        
        res.json({
          message: 'Alert acknowledged successfully',
          alertId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Failed to acknowledge alert', { error: error.message });
        res.status(500).json({ error: 'Failed to acknowledge alert' });
      }
    });

    // Categories and Payees endpoints for mapping setup
    this.app.get('/api/actual/categories', async (req, res) => {
      try {
        logger.info('Fetching categories from Actual Budget');
        const categories = await this.services.actualClient.getCategories(this.config.business_category_group_id);
        
        res.json({
          success: true,
          categories: categories.map(cat => ({
            id: cat.id,
            name: cat.name,
            group_id: cat.cat_group || cat.group_id,
            is_income: cat.is_income || false
          })),
          count: categories.length
        });
      } catch (error) {
        logger.error('Failed to fetch categories:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch categories from Actual Budget'
        });
      }
    });

    this.app.get('/api/actual/payees', async (req, res) => {
      try {
        logger.info('Fetching payees from Actual Budget');
        const payees = await this.services.actualClient.getPayees();
        
        res.json({
          success: true,
          payees: payees.map(payee => ({
            id: payee.id,
            name: payee.name,
            transfer_acct: payee.transfer_acct || null
          })),
          count: payees.length
        });
      } catch (error) {
        logger.error('Failed to fetch payees:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch payees from Actual Budget'
        });
      }
    });

    // Sync categories to Xano for mapping
    this.app.post('/api/sync/categories', async (req, res) => {
      try {
        logger.info('Syncing categories to Xano for mapping setup');
        
        // Fetch categories from Actual Budget
        const categories = await this.services.actualClient.getCategories(this.config.business_category_group_id);
        
        let synced = 0;
        let failed = 0;
        const errors = [];
        
        for (const category of categories) {
          try {
            const categoryData = {
              actual_category_id: category.id,
              actual_category_name: category.name,
              actual_group_id: category.cat_group || category.group_id,
              is_income: category.is_income || false,
              xero_account_id: null, // To be mapped later
              xero_account_code: null,
              xero_account_name: null,
              is_mapped: false,
              created_at: new Date().toISOString()
            };
            
            // Store in Xano categories table
            await this.services.xanoClient.storeCategory(categoryData);
            synced++;
            
          } catch (error) {
            failed++;
            errors.push({
              category_id: category.id,
              category_name: category.name,
              error: error.message
            });
            logger.error(`Failed to sync category ${category.name}:`, error.message);
          }
        }
        
        logger.info(`Category sync completed: ${synced} synced, ${failed} failed`);
        
        res.json({
          success: true,
          message: `Synced ${synced} categories to Xano`,
          statistics: {
            total: categories.length,
            synced,
            failed,
            errors
          }
        });
        
      } catch (error) {
        logger.error('Failed to sync categories:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to sync categories to Xano'
        });
      }
    });

    // Sync payees to Xano for mapping
    this.app.post('/api/sync/payees', async (req, res) => {
      try {
        logger.info('Syncing payees to Xano for mapping setup');
        
        // Fetch payees from Actual Budget
        const payees = await this.services.actualClient.getPayees();
        
        let synced = 0;
        let failed = 0;
        const errors = [];
        
        for (const payee of payees) {
          try {
            const payeeData = {
              actual_payee_id: payee.id,
              actual_payee_name: payee.name,
              is_transfer_account: !!payee.transfer_acct,
              xero_contact_id: null, // To be mapped later
              xero_contact_name: null,
              is_mapped: false,
              created_at: new Date().toISOString()
            };
            
            // Store in Xano payees table
            await this.services.xanoClient.storePayee(payeeData);
            synced++;
            
          } catch (error) {
            failed++;
            errors.push({
              payee_id: payee.id,
              payee_name: payee.name,
              error: error.message
            });
            logger.error(`Failed to sync payee ${payee.name}:`, error.message);
          }
        }
        
        logger.info(`Payee sync completed: ${synced} synced, ${failed} failed`);
        
        res.json({
          success: true,
          message: `Synced ${synced} payees to Xano`,
          statistics: {
            total: payees.length,
            synced,
            failed,
            errors
          }
        });
        
      } catch (error) {
        logger.error('Failed to sync payees:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to sync payees to Xano'
        });
      }
    });

    // Get mapping status
    this.app.get('/api/mappings/status', async (req, res) => {
      try {
        // Get mapping statistics from Xano
        const categoryStats = await this.services.xanoClient.getCategoryMappingStats();
        const payeeStats = await this.services.xanoClient.getPayeeMappingStats();
        
        res.json({
          success: true,
          categories: {
            total: categoryStats.total || 0,
            mapped: categoryStats.mapped || 0,
            unmapped: (categoryStats.total || 0) - (categoryStats.mapped || 0)
          },
          payees: {
            total: payeeStats.total || 0,
            mapped: payeeStats.mapped || 0,
            unmapped: (payeeStats.total || 0) - (payeeStats.mapped || 0)
          }
        });
      } catch (error) {
        logger.error('Failed to get mapping status:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to get mapping status'
        });
      }
    });

    // Home Assistant integration endpoints
    this.app.get('/api/homeassistant/status', (req, res) => {
      try {
        const status = this.services.haService.getStatus();
        res.json(status);
      } catch (error) {
        logger.error('Failed to get Home Assistant status', { error: error.message });
        res.status(500).json({ error: 'Failed to get Home Assistant status' });
      }
    });

    this.app.get('/api/homeassistant/entities', (req, res) => {
      try {
        const entities = this.services.haService.getEntities();
        res.json({ entities });
      } catch (error) {
        logger.error('Failed to get Home Assistant entities', { error: error.message });
        res.status(500).json({ error: 'Failed to get Home Assistant entities' });
      }
    });

    this.app.get('/api/homeassistant/services', (req, res) => {
      try {
        const services = this.services.haService.getServiceCalls();
        res.json({ services });
      } catch (error) {
        logger.error('Failed to get Home Assistant services', { error: error.message });
        res.status(500).json({ error: 'Failed to get Home Assistant services' });
      }
    });

    this.app.post('/api/homeassistant/sync/trigger', async (req, res) => {
      try {
        const { source = 'api' } = req.body;
        const result = await this.services.haService.handleSyncTrigger(source);
        
        if (result.success) {
          res.json(result);
        } else {
          res.status(500).json(result);
        }
      } catch (error) {
        logger.error('Failed to trigger sync via Home Assistant', { error: error.message });
        res.status(500).json({ error: 'Failed to trigger sync' });
      }
    });

    // Default route - serve web interface
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../web/index.html'));
    });
  }

  /**
   * Setup error handling middleware
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.path} not found`
      });
    });

    // Global error handler
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
      });

      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred'
      });
    });
  }

  /**
   * Start the application server
   */
  async start() {
    const port = process.env.PORT || 8080;
    
    this.server = this.app.listen(port, async () => {
      logger.info(`Actual-Xero Sync server started on port ${port}`);
      logger.info('Web interface available at http://localhost:' + port);
      
      // Start log monitoring after server is running
      await this.startLogMonitoring();
    });

    // Graceful shutdown handling
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
  }

  /**
   * Graceful shutdown
   */
  async shutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    
    this.isShuttingDown = true;
    
    // Stop log monitoring
    this.stopLogMonitoring();
    
    // Wait for active operations to complete
    if (this.activeOperations.size > 0) {
      logger.info(`Waiting for ${this.activeOperations.size} active operations to complete...`);
      
      const timeout = setTimeout(() => {
        logger.warn('Shutdown timeout reached, forcing exit');
        process.exit(1);
      }, 30000); // 30 second timeout
      
      while (this.activeOperations.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      clearTimeout(timeout);
    }
    
    if (this.server) {
      this.server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }

  /**
   * Setup log monitor event handlers
   */
  setupLogMonitorEvents() {
    if (!this.logMonitor) return;

    this.logMonitor.on('alert-created', (alert) => {
      logger.warn(`Log Monitor Alert: ${alert.type}`, {
        alertId: alert.id,
        alertDetails: alert.details
      });
    });

    this.logMonitor.on('health-check-failed', (error) => {
      logger.error('Log monitoring health check failed', error);
    });

    this.logMonitor.on('rotation-completed', (result) => {
      logger.info('Log rotation completed', result);
    });

    this.logMonitor.on('monitoring-started', () => {
      logger.info('Log monitoring started');
    });

    this.logMonitor.on('monitoring-stopped', () => {
      logger.info('Log monitoring stopped');
    });
  }

  /**
   * Start log monitoring
   */
  async startLogMonitoring() {
    if (this.logMonitor && !this.logMonitor.monitoring) {
      try {
        await this.logMonitor.startMonitoring();
        logger.info('Log monitoring service started');
      } catch (error) {
        logger.error('Failed to start log monitoring', { error: error.message });
      }
    }
  }

  /**
   * Stop log monitoring
   */
  stopLogMonitoring() {
    if (this.logMonitor && this.logMonitor.monitoring) {
      this.logMonitor.stopMonitoring();
      logger.info('Log monitoring service stopped');
    }
  }

  /**
   * Get log monitoring status
   */
  getLogMonitoringStatus() {
    if (!this.logMonitor) {
      return { available: false };
    }

    return {
      available: true,
      ...this.logMonitor.getStatus()
    };
  }
}

module.exports = ActualXeroSyncApp;

// Start the application if this file is run directly
if (require.main === module) {
  const app = new ActualXeroSyncApp();
  
  app.init()
    .then(() => app.start())
    .catch((error) => {
      console.error('Failed to start application:', error);
      process.exit(1);
    });
}