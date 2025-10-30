const fs = require('fs');
const path = require('path');

// Use axios for HTTP requests (more reliable than fetch in Node.js)
const axios = require('axios');

/**
 * ActualBudgetClient - API client for Actual Budget integration via Node.js server
 * 
 * Uses HTTP requests to the Node.js server on port 3000 instead of direct API calls
 */
class ActualBudgetClient {
  constructor(options = {}) {
    // Use the Node.js server URL instead of direct Actual Budget URL
    this.serverUrl = options.serverUrl || 'http://localhost:3000';
    this.apiKey = options.apiKey || process.env.API_KEY;
    this.logger = options.logger || console;
    this.budgetId = null;
    this.isInitialized = false;
    this.initializationInProgress = false;
    this.initializationError = null;
  }

  /**
   * Make HTTP request to Node.js server
   * @private
   */
  async makeRequest(endpoint, options = {}) {
    const url = `${this.serverUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      ...options.headers
    };

    const axiosOptions = {
      method: options.method || 'GET',
      url,
      headers,
      timeout: 30000, // 30 second timeout
    };

    if (options.body) {
      axiosOptions.data = options.body;
    }

    this.logger.debug(`Making request to ${url}`, { method: axiosOptions.method });

    try {
      const response = await axios(axiosOptions);
      return response.data;
    } catch (error) {
      if (error.response) {
        // Server responded with error status
        throw new Error(`HTTP ${error.response.status}: ${error.response.data?.error || error.response.statusText}`);
      } else if (error.request) {
        // Request was made but no response received
        throw new Error(`No response from server: ${error.message}`);
      } else {
        // Something else happened
        throw new Error(`Request failed: ${error.message}`);
      }
    }
  }

  /**
   * Initialize connection to Node.js server
   * @returns {Promise<boolean>} - Initialization success
   */
  async init() {
    if (this.isInitialized) {
      return true;
    }

    if (this.initializationInProgress) {
      throw new Error('Initialization in progress. Please try again in a few minutes.');
    }

    if (this.initializationError) {
      throw new Error(`Previous initialization failed: ${this.initializationError.message}`);
    }

    this.initializationInProgress = true;
    this.initializationError = null;

    try {
      this.logger.info('Connecting to Node.js Actual Budget server', {
        serverUrl: this.serverUrl
      });

      // Test connection to Node.js server
      const statusResponse = await this.makeRequest('/status');
      this.logger.info('Node.js server status:', statusResponse);

      if (!statusResponse.initialized) {
        throw new Error('Node.js server is not initialized. Please wait for it to start up.');
      }

      this.logger.info('Successfully connected to Node.js server');
      this.isInitialized = true;
      
      // Automatically load the first available budget
      try {
        this.logger.info('Fetching available budgets...');
        const budgetsResponse = await this.makeRequest('/budgets');
        const budgets = budgetsResponse.budgets || [];
        this.logger.info(`Found ${budgets.length} budgets available`);
        
        if (budgets.length > 0) {
          // Log budget details for debugging
          budgets.forEach((budget, index) => {
            this.logger.info(`Budget ${index + 1}: ${budget.name || 'Unnamed'} (ID: ${budget.id})`);
          });
          
          const firstBudget = budgets[0];
          this.logger.info(`Auto-loading first budget: ${firstBudget.name || 'Unnamed'} (${firstBudget.id})`);
          
          await this.makeRequest('/load-budget', {
            method: 'POST',
            body: { budgetId: firstBudget.id }
          });
          
          this.budgetId = firstBudget.id;
          this.logger.info(`Successfully auto-loaded budget: ${firstBudget.name || 'Unnamed'}`);
        } else {
          this.logger.warn('No budgets found to auto-load');
          this.logger.info('This could mean:');
          this.logger.info('1. Authentication failed - check your password');
          this.logger.info('2. Wrong server URL - check your Actual Budget URL');
          this.logger.info('3. Server still starting up - try manual sync in a few minutes');
          this.logger.info('4. No budgets exist on this server');
        }
      } catch (budgetError) {
        this.logger.error('Failed to fetch/load budget:', budgetError.message);
        this.logger.error('Budget error details:', budgetError);
        // Don't fail initialization if budget loading fails
      }
      
      this.initializationInProgress = false;
      return true;
    } catch (error) {
      this.logger.error('Failed to connect to Node.js server:', error.message);
      this.initializationError = error;
      this.initializationInProgress = false;
      throw error;
    }
  }

  /**
   * Ensure API is initialized before making calls
   * @private
   */
  async ensureInitialized() {
    if (!this.isInitialized) {
      await this.init();
    }
  }

  /**
   * Get list of available budgets via Node.js server
   * @returns {Promise<Array>} - Array of budget objects
   */
  async getBudgets() {
    await this.ensureInitialized();
    
    try {
      const maxRetries = 3;
      let attempt = 0;
      
      while (attempt < maxRetries) {
        try {
          this.logger.info(`Fetching available budgets (attempt ${attempt + 1}/${maxRetries})...`);
          const response = await this.makeRequest('/budgets');
          const budgets = response.budgets || [];
          
          this.logger.info(`Found ${budgets.length} budgets available`);
          if (budgets.length > 0) {
            this.logger.debug('First budget structure:', Object.keys(budgets[0]));
            return budgets;
          }
          
          this.logger.warn(`No budgets found (attempt ${attempt + 1}/${maxRetries})`);
          
          if (attempt < maxRetries - 1) {
            this.logger.info('Waiting 2 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          attempt++;
        } catch (error) {
          attempt++;
          if (attempt >= maxRetries) {
            throw error;
          }
          this.logger.warn(`Request failed (attempt ${attempt}/${maxRetries}):`, error.message);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      this.logger.warn('No budgets found after all attempts. This could mean:');
      this.logger.info('1. Authentication failed - check your password');
      this.logger.info('2. Wrong server URL - check your Actual Budget URL');
      this.logger.info('3. Server still starting up - try manual sync in a few minutes');
      this.logger.info('4. No budgets exist on this server');
      
      return [];
    } catch (error) {
      this.logger.error('Failed to get budgets:', error.message);
      throw error;
    }
  }

  /**
   * Load a specific budget via Node.js server
   * @param {string} budgetId - Budget ID to load
   * @returns {Promise<boolean>} - Success status
   */
  async loadBudget(budgetId) {
    await this.ensureInitialized();
    
    try {
      this.logger.info(`Loading budget: ${budgetId}`);
      
      await this.makeRequest('/load-budget', {
        method: 'POST',
        body: { budgetId }
      });
      
      this.budgetId = budgetId;
      this.logger.info(`Successfully loaded budget: ${budgetId}`);
      return true;
    } catch (error) {
      this.logger.error('Failed to load budget:', error.message);
      throw error;
    }
  }

  /**
   * Get categories for the loaded budget via Node.js server
   * @param {string} groupId - Optional category group ID to filter by
   * @returns {Promise<Array>} - Array of category objects
   */
  async getCategories(groupId = null) {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      const response = await this.makeRequest('/categories');
      const categories = response.categories || [];
      
      this.logger.info(`Retrieved ${categories.length} total categories`);
      
      // Filter by group ID if specified
      let filteredCategories = categories;
      if (groupId) {
        filteredCategories = categories.filter(category => 
          category.cat_group === groupId || category.group_id === groupId
        );
        
        this.logger.info(`Filtered to ${filteredCategories.length} categories for group ${groupId}`);
        
        if (filteredCategories.length === 0) {
          this.logger.warn(`No categories found for group ${groupId}. Available group IDs:`, 
            [...new Set(categories.map(cat => cat.cat_group || cat.group_id).filter(Boolean))]
          );
        }
      }

      if (filteredCategories.length > 0) {
        this.logger.debug('First category structure:', Object.keys(filteredCategories[0]));
      }
      
      return filteredCategories;
    } catch (error) {
      this.logger.error('Failed to get categories:', error.message);
      throw error;
    }
  }

  /**
   * Get category groups for the loaded budget via Node.js server
   * @returns {Promise<Array>} - Array of category group objects
   */
  async getCategoryGroups() {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      const response = await this.makeRequest('/category-groups');
      const groups = response.groups || [];
      
      this.logger.info(`Retrieved ${groups.length} category groups`);
      return groups;
    } catch (error) {
      this.logger.error('Failed to get category groups:', error.message);
      throw error;
    }
  }

  /**
   * Find category group by name using @actual-app/api
   * @param {string} groupName - Name of the category group to find
   * @returns {Promise<Object|null>} - Category group object or null if not found
   */
  async findCategoryGroupByName(groupName) {
    const groups = await this.getCategoryGroups();
    const group = groups.find(g => g.name === groupName);
    
    if (group) {
      this.logger.info(`Found category group "${groupName}" with ID: ${group.id}`);
    } else {
      this.logger.warn(`Category group "${groupName}" not found. Available groups: ${groups.map(g => g.name).join(', ')}`);
    }
    
    return group || null;
  }

  /**
   * Get payees for the loaded budget via Node.js server
   * @returns {Promise<Array>} - Array of payee objects
   */
  async getPayees() {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      const response = await this.makeRequest('/payees');
      const payees = response.payees || [];
      
      this.logger.info(`Retrieved ${payees.length} payees`);
      return payees;
    } catch (error) {
      this.logger.error('Failed to get payees:', error.message);
      throw error;
    }
  }

  /**
   * Get reconciled transactions by category group via Node.js server
   * @param {string} categoryGroupId - Category group ID to filter by
   * @param {Date} since - Optional date to get transactions since
   * @returns {Promise<Array>} - Array of reconciled transaction objects
   */
  async getReconciledTransactions(categoryGroupId, since = null) {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      this.logger.info(`Fetching reconciled transactions for category group ${categoryGroupId} since ${since ? since.toISOString() : 'beginning'}`);

      // Build query parameters
      const params = new URLSearchParams();
      if (categoryGroupId) {
        params.append('categoryGroupId', categoryGroupId);
      }
      if (since) {
        params.append('since', since.toISOString());
      }

      const response = await this.makeRequest(`/transactions?${params.toString()}`);
      const allTransactions = response.transactions || [];
      
      this.logger.info(`Retrieved ${allTransactions.length} total transactions from server`);

      // Filter for reconciled transactions (the server already filters by category group and date)
      let filteredTransactions = allTransactions.filter(transaction => {
        // Check if transaction is reconciled (not just cleared)
        return transaction.reconciled === true;
      });

      this.logger.info(`Found ${filteredTransactions.length} reconciled transactions matching criteria`);
      
      // Debug: Show some transaction details for troubleshooting
      if (allTransactions.length > 0) {
        const recentTransactions = allTransactions.slice(0, 5);
        this.logger.info('Sample recent transactions:', recentTransactions.map(t => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          category: t.category,
          cleared: t.cleared,
          reconciled: t.reconciled,
          payee: t.payee
        })));
      }
      
      if (filteredTransactions.length > 0) {
        this.logger.debug('Sample transaction structure:', Object.keys(filteredTransactions[0]));
      }
      
      return filteredTransactions;
    } catch (error) {
      this.logger.error('Failed to get reconciled transactions:', error.message);
      throw error;
    }
  }

  /**
   * Update transaction notes with sync status tags via Node.js server
   * @param {string} transactionId - Transaction ID to update
   * @param {string} newTags - Tags to add to the transaction notes
   * @returns {Promise<boolean>} - Success status
   */
  async updateTransactionNotes(transactionId, newTags) {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      // First get the current transaction to preserve existing notes
      const currentTransaction = await this.getTransaction(transactionId);
      if (!currentTransaction) {
        throw new Error(`Transaction ${transactionId} not found`);
      }

      // Append new tags to existing notes
      const existingNotes = currentTransaction.notes || '';
      const updatedNotes = this.appendTags(existingNotes, newTags);

      // Update the transaction via Node.js server
      await this.makeRequest(`/transactions/${transactionId}`, {
        method: 'PUT',
        body: { notes: updatedNotes }
      });

      this.logger.info(`Successfully updated notes for transaction ${transactionId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to update transaction notes for ${transactionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get a single transaction by ID via Node.js server
   * @param {string} transactionId - Transaction ID
   * @returns {Promise<Object|null>} - Transaction object or null if not found
   */
  async getTransaction(transactionId) {
    await this.ensureInitialized();
    
    if (!this.budgetId) {
      throw new Error('No budget loaded. Call loadBudget() first.');
    }

    try {
      // Get all transactions and find the one we want
      const response = await this.makeRequest('/transactions');
      const allTransactions = response.transactions || [];
      const transaction = allTransactions.find(t => t.id === transactionId);
      
      return transaction || null;
    } catch (error) {
      this.logger.error(`Failed to get transaction ${transactionId}:`, error.message);
      throw error;
    }
  }

  /**
   * Append tags to existing notes without removing content
   * @param {string} existingNotes - Current transaction notes
   * @param {string} newTags - Tags to append
   * @returns {string} - Updated notes with tags
   */
  appendTags(existingNotes, newTags) {
    if (!newTags || newTags.trim() === '') {
      return existingNotes;
    }

    // Clean up the new tags
    const cleanTags = newTags.trim();
    
    // If no existing notes, just return the tags
    if (!existingNotes || existingNotes.trim() === '') {
      return cleanTags;
    }

    // Check if tags already exist to avoid duplicates
    const existingTagsLower = existingNotes.toLowerCase();
    const newTagsArray = cleanTags.split(' ').filter(tag => tag.startsWith('#'));
    
    const tagsToAdd = newTagsArray.filter(tag => 
      !existingTagsLower.includes(tag.toLowerCase())
    );

    if (tagsToAdd.length === 0) {
      return existingNotes; // No new tags to add
    }

    // Append new tags with a space separator
    return `${existingNotes.trim()} ${tagsToAdd.join(' ')}`.trim();
  }

  /**
   * Add Xano sync tag to transaction
   * @param {string} transactionId - Transaction ID
   * @returns {Promise<boolean>} - Success status
   */
  async addXanoTag(transactionId) {
    return this.updateTransactionNotes(transactionId, '#xano');
  }

  /**
   * Add Xero sync tag to transaction
   * @param {string} transactionId - Transaction ID
   * @returns {Promise<boolean>} - Success status
   */
  async addXeroTag(transactionId) {
    return this.updateTransactionNotes(transactionId, '#xero');
  }

  /**
   * Add paid tag with date to transaction
   * @param {string} transactionId - Transaction ID
   * @param {Date} paidDate - Date when transaction was marked as paid
   * @returns {Promise<boolean>} - Success status
   */
  async addPaidTag(transactionId, paidDate = new Date()) {
    const dateString = paidDate instanceof Date 
      ? paidDate.toISOString().split('T')[0] 
      : paidDate;
    
    const tags = `#paid #${dateString}`;
    return this.updateTransactionNotes(transactionId, tags);
  }

  /**
   * Auto-load the first available budget via Node.js server
   * @returns {Promise<boolean>} - Success status
   */
  async autoLoadBudget() {
    try {
      this.logger.info('Auto-loading first available budget');
      
      const budgets = await this.getBudgets();
      
      if (budgets.length === 0) {
        throw new Error('No budgets available to load');
      }

      // Debug: Log budget structure
      this.logger.debug('Available budgets:', budgets.map(b => ({
        keys: Object.keys(b),
        id: b.id || b.fileId || b.name,
        name: b.name || b.fileName || 'Unknown'
      })));

      // Load the first budget - try different possible ID fields
      const firstBudget = budgets[0];
      const budgetId = firstBudget.id || firstBudget.fileId || firstBudget.name;
      
      if (!budgetId) {
        throw new Error(`Cannot determine budget ID from budget object: ${JSON.stringify(firstBudget)}`);
      }

      await this.loadBudget(budgetId);
      
      this.logger.info(`Auto-loaded budget: ${firstBudget.name || firstBudget.fileName || budgetId}`);
      return true;
    } catch (error) {
      this.logger.error('Failed to auto-load budget:', error.message);
      throw error;
    }
  }

  /**
   * Test connection to Node.js server
   * @returns {Promise<boolean>} - Connection success
   */
  async testConnection() {
    try {
      await this.init();
      const budgets = await this.getBudgets();
      this.logger.info(`Connection test successful. Found ${budgets.length} budgets.`);
      return true;
    } catch (error) {
      this.logger.error('Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Get client status and statistics
   * @returns {Object} - Status information
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      budgetId: this.budgetId,
      baseUrl: this.baseUrl,
      dataDir: this.dataDir
    };
  }
}

module.exports = ActualBudgetClient;