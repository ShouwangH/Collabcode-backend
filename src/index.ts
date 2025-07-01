import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';

import { logger } from '@/utils/logger';
import { errorHandler } from '@/middleware/errorHandler';
import { rateLimiter, initializeRedisRateLimiter } from '@/middleware/rateLimiter';
import { authMiddleware } from '@/middleware/auth';
import setupRoutes from '@/routes';
import { setupWebSocket } from '@/services/websocket';
import { connectDatabase } from '@/utils/database';
import { connectRedis } from '@/utils/redis';

// Load environment variables
dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3001",
      "http://127.0.0.1:3001"
    ],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["*"]
  },
  transports: ['websocket', 'polling'], // Allow both transports
  allowEIO3: true, // For compatibility
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6, // 1MB
  // Add connection state recovery
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
});

const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.API_VERSION || 'v1';

async function startServer() {
  try {
    // Connect to databases
    await connectDatabase();
    await connectRedis();

    // Initialize Redis-based rate limiter after Redis connection
    initializeRedisRateLimiter();

    //Test endpoint
    app.get('/socket-test', (req, res) => {
      res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Socket.IO Test</title>
      <script src="/socket.io/socket.io.js"></script>
    </head>
    <body>
      <h1>Socket.IO Connection Test</h1>
      <div id="status">Connecting...</div>
      <button onclick="sendTest()">Send Test Event</button>
      <div id="messages"></div>
      
      <script>
        const socket = io();
        const status = document.getElementById('status');
        const messages = document.getElementById('messages');
        
        socket.on('connect', () => {
          status.textContent = 'Connected: ' + socket.id;
          console.log('Connected to Socket.IO server');
        });
        
        socket.on('disconnect', () => {
          status.textContent = 'Disconnected';
          console.log('Disconnected from Socket.IO server');
        });
        
        socket.on('test-response', (data) => {
          messages.innerHTML += '<p>Received: ' + JSON.stringify(data) + '</p>';
        });
        
        function sendTest() {
          console.log('Sending test event');
          socket.emit('test-event', { message: 'Hello from browser!' });
        }
      </script>
    </body>
    </html>
  `);
    });


    // Security middleware
    app.use(helmet({
      contentSecurityPolicy: false, // Will configure properly for production
      crossOriginResourcePolicy: { policy: "cross-origin" }
    }));

    // CORS configuration
    app.use(cors({
      origin: process.env.CORS_ORIGIN?.split(',') || ["http://localhost:3001"],
      credentials: true,
      optionsSuccessStatus: 200
    }));

    // Compression and parsing
    app.use(compression());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Rate limiting
    app.use(rateLimiter);

    // Health check endpoint (before auth)
    app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
      });
    });

    // API routes
    app.use(`/api/${API_VERSION}`, setupRoutes());

    // WebSocket setup
    setupWebSocket(io);

    // Error handling middleware (should be last)
    app.use(errorHandler);

    // 404 handler
    app.use('*', (req, res) => {
      res.status(404).json({
        error: 'Route not found',
        path: req.originalUrl
      });
    });

    //Express handler
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || 'http://localhost:3001');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // Start server
    server.listen(PORT, () => {
      logger.info(`🚀 CollabCode backend server running on port ${PORT}`);
      logger.info(`📊 Health check available at http://localhost:${PORT}/health`);
      logger.info(`🔌 WebSocket server ready for connections`);
      logger.info(`🗄️  API endpoints available at http://localhost:${PORT}/api/${API_VERSION}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

async function gracefulShutdown(signal: string) {
  logger.info(`🔄 Received ${signal}. Starting graceful shutdown...`);

  server.close(() => {
    logger.info('✅ HTTP server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('🚨 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();