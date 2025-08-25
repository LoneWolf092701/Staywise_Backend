const mysql = require('mysql2');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'harenie2121',
  database: process.env.DB_NAME || 'staywise_db',
  port: process.env.DB_PORT || 3306,
  connectionLimit: 20,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  charset: 'utf8mb4',
  timezone: 'Z',
  multipleStatements: false,
  dateStrings: true
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Event handlers for connection pool
pool.on('connection', function (connection) {
  console.log(`Database connected as id ${connection.threadId}`);
  
  // Test connection with a simple query
  connection.query('SELECT 1 as health_check', (err) => {
    if (err) {
      console.error('Error testing database connection:', err);
    } else {
      console.log(`Connection ${connection.threadId} health check passed`);
    }
  });
});

pool.on('error', function(err) {
  console.error('Database pool error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('Database connection lost. Attempting to reconnect...');
  } else if (err.code === 'ER_CON_COUNT_ERROR') {
    console.error('Database has too many connections');
  } else if (err.code === 'ECONNREFUSED') {
    console.error('Database connection refused');
  } else {
    console.error('Unexpected database error:', err);
  }
});

pool.on('acquire', function (connection) {
  console.log(`Connection ${connection.threadId} acquired`);
});

pool.on('release', function (connection) {
  console.log(`Connection ${connection.threadId} released`);
});

pool.on('enqueue', function () {
  console.log('Waiting for available connection slot');
});

/**
 * Test database connection
 * @returns {Promise<void>}
 */
const testConnection = () => {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => {
      if (err) {
        console.error('Database connection failed:', err);
        return reject(err);
      }
      
      console.log('Database connection test successful');
      connection.release();
      resolve();
    });
  });
};

/**
 * Execute a SQL query with parameters
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 */
const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    pool.query(sql, params, (err, results) => {
      if (err) {
        console.error('Query error:', err);
        console.error('SQL:', sql);
        console.error('Params:', params);
        return reject(err);
      }
      resolve(results);
    });
  });
};

/**
 * Get a connection from the pool
 * @returns {Promise<Connection>} Database connection
 */
const getConnection = () => {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => {
      if (err) {
        console.error('Error getting connection from pool:', err);
        return reject(err);
      }
      resolve(connection);
    });
  });
};

/**
 * Execute multiple queries in a transaction
 * @param {Array} queries - Array of query objects {sql, params}
 * @returns {Promise<Array>} Results from all queries
 */
const executeTransaction = async (queries) => {
  let connection;
  
  try {
    connection = await getConnection();
    
    // Start transaction
    await new Promise((resolve, reject) => {
      connection.beginTransaction((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const results = [];
    
    // Execute all queries
    for (const queryDef of queries) {
      const { sql, params } = queryDef;
      const result = await new Promise((resolve, reject) => {
        connection.query(sql, params, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
      results.push(result);
    }

    // Commit transaction
    await new Promise((resolve, reject) => {
      connection.commit((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    return results;
  } catch (error) {
    // Rollback transaction on error
    if (connection) {
      await new Promise((resolve) => {
        connection.rollback(() => resolve());
      });
    }
    console.error('Transaction failed:', error);
    throw error;
  } finally {
    // Release connection
    if (connection) {
      connection.release();
    }
  }
};

/**
 * Execute a query with automatic retry on connection loss
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Array>} Query results
 */
const queryWithRetry = async (sql, params = [], maxRetries = 3) => {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await query(sql, params);
    } catch (error) {
      lastError = error;
      
      if (error.code === 'PROTOCOL_CONNECTION_LOST' && attempt < maxRetries) {
        console.log(`Connection lost, retrying query (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
      } else {
        break;
      }
    }
  }
  
  throw lastError;
};

/**
 * Health check for database connectivity
 * @returns {Promise<Object>} Health status
 */
const healthCheck = async () => {
  try {
    const startTime = Date.now();
    await query('SELECT 1 as health_check, NOW() as server_time');
    const responseTime = Date.now() - startTime;
    
    return { 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      response_time_ms: responseTime
    };
  } catch (error) {
    console.error('Database health check failed:', error);
    return { 
      status: 'unhealthy', 
      error: error.message, 
      timestamp: new Date().toISOString() 
    };
  }
};

/**
 * Get database connection statistics
 * @returns {Promise<Object>} Connection statistics
 */
const getStats = async () => {
  try {
    const connectionStats = await query('SHOW STATUS LIKE "Threads_connected"');
    const maxConnections = await query('SHOW VARIABLES LIKE "max_connections"');
    const processlist = await query('SHOW PROCESSLIST');
    
    return {
      active_connections: connectionStats[0]?.Value || 0,
      max_connections: maxConnections[0]?.Value || 0,
      pool_config: {
        connection_limit: dbConfig.connectionLimit,
        acquire_timeout: dbConfig.acquireTimeout,
        timeout: dbConfig.timeout
      },
      current_processes: processlist.length,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error getting database stats:', error);
    return {
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * Initialize database and verify table structure
 * @returns {Promise<boolean>} Success status
 */
const initializeDatabase = async () => {
  try {
    console.log('\n===== Database Initialization =====');
    console.log('Connecting to database...');
    
    await testConnection();
    console.log('✓ Database connection successful');
    
    // Verify required tables exist
    const requiredTables = [
      'users',
      'user_profiles', 
      'properties',
      'all_properties',
      'property_details',
      'user_interactions',
      'booking_requests'
    ];
    
    console.log('Verifying database tables...');
    const existingTables = await query("SHOW TABLES");
    const tableNames = existingTables.map(row => Object.values(row)[0]);
    
    for (const table of requiredTables) {
      if (tableNames.includes(table)) {
        try {
          // Test table accessibility with a simple query
          await query(`SELECT 1 FROM ${table} LIMIT 1`);
          console.log(`✓ Table '${table}' verified`);
        } catch (error) {
          console.warn(`⚠ Table '${table}' exists but not accessible:`, error.message);
        }
      } else {
        console.error(`✗ Required table '${table}' not found`);
      }
    }
    
    // Verify database charset and collation
    const charsetInfo = await query(`
      SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME 
      FROM information_schema.SCHEMATA 
      WHERE SCHEMA_NAME = ?
    `, [dbConfig.database]);
    
    if (charsetInfo.length > 0) {
      console.log(`Database charset: ${charsetInfo[0].DEFAULT_CHARACTER_SET_NAME}`);
      console.log(`Database collation: ${charsetInfo[0].DEFAULT_COLLATION_NAME}`);
    }
    
    console.log('===== Database Initialization Complete =====\n');
    return true;
  } catch (error) {
    console.error('===== Database Initialization Failed =====');
    console.error('Error:', error.message);
    console.error('Config:', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      user: dbConfig.user
    });
    console.error('=====================================\n');
    return false;
  }
};

/**
 * Check if a table exists and has expected columns
 * @param {string} tableName - Name of table to check
 * @param {Array} expectedColumns - Array of expected column names
 * @returns {Promise<Object>} Table validation result
 */
const validateTableStructure = async (tableName, expectedColumns = []) => {
  try {
    const columns = await query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [dbConfig.database, tableName]);
    
    const existingColumns = columns.map(col => col.COLUMN_NAME);
    const missingColumns = expectedColumns.filter(col => !existingColumns.includes(col));
    
    return {
      exists: columns.length > 0,
      columns: existingColumns,
      missing_columns: missingColumns,
      column_details: columns
    };
  } catch (error) {
    return {
      exists: false,
      error: error.message
    };
  }
};

/**
 * Execute database maintenance tasks
 * @returns {Promise<Object>} Maintenance results
 */
const performMaintenance = async () => {
  try {
    const results = {};
    
    // Optimize tables
    const tables = await query("SHOW TABLES");
    for (const tableRow of tables) {
      const tableName = Object.values(tableRow)[0];
      try {
        await query(`OPTIMIZE TABLE ${tableName}`);
        results[tableName] = 'optimized';
      } catch (error) {
        results[tableName] = `optimization failed: ${error.message}`;
      }
    }
    
    // Get table sizes
    const tableSizes = await query(`
      SELECT 
        table_name,
        ROUND(((data_length + index_length) / 1024 / 1024), 2) AS 'size_mb'
      FROM information_schema.tables 
      WHERE table_schema = ?
      ORDER BY (data_length + index_length) DESC
    `, [dbConfig.database]);
    
    return {
      optimization_results: results,
      table_sizes: tableSizes,
      maintenance_completed: new Date().toISOString()
    };
  } catch (error) {
    console.error('Database maintenance failed:', error);
    return {
      error: error.message,
      maintenance_completed: new Date().toISOString()
    };
  }
};

/**
 * Gracefully close database connections
 * @returns {Promise<void>}
 */
const gracefulShutdown = () => {
  return new Promise((resolve) => {
    console.log('\n===== Database Shutdown =====');
    console.log('Closing database connections...');
    
    pool.end((err) => {
      if (err) {
        console.error('Error during database shutdown:', err);
      } else {
        console.log('✓ All database connections closed');
      }
      console.log('===== Database Shutdown Complete =====\n');
      resolve();
    });
  });
};

/**
 * Create a backup query for critical operations
 * @param {string} tableName - Table to backup
 * @param {string} condition - WHERE condition (optional)
 * @returns {Promise<Array>} Backup data
 */
const createBackup = async (tableName, condition = '') => {
  try {
    const whereClause = condition ? `WHERE ${condition}` : '';
    const backupData = await query(`SELECT * FROM ${tableName} ${whereClause}`);
    return {
      table: tableName,
      condition: condition,
      record_count: backupData.length,
      data: backupData,
      backup_timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`Backup failed for table ${tableName}:`, error);
    throw error;
  }
};

// Export the database utilities
module.exports = {
  pool,
  query,
  queryWithRetry,
  getConnection,
  executeTransaction,
  testConnection,
  healthCheck,
  getStats,
  initializeDatabase,
  validateTableStructure,
  performMaintenance,
  gracefulShutdown,
  createBackup,
  
  // Configuration
  config: dbConfig
};