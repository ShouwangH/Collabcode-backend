import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { getRedisClient } from '@/utils/redis';
import { logger } from '@/utils/logger';

// Rate limiter configuration
const rateLimiterOptions = {
  keyPrefix: 'collabcode_rate_limit',
  points: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // Number of requests
  duration: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900'), // Per 15 minutes (900 seconds)
  blockDuration: 900, // Block for 15 minutes if limit exceeded
  execEvenly: true, // Spread requests evenly across duration
};

// Create rate limiter instance - start with memory, upgrade to Redis later
let mainRateLimiter: RateLimiterRedis | RateLimiterMemory = new RateLimiterMemory(rateLimiterOptions);

// Function to initialize Redis rate limiter after Redis connects
export function initializeRedisRateLimiter(): void {
  try {
    const redisClient = getRedisClient();
    mainRateLimiter = new RateLimiterRedis({
      storeClient: redisClient,
      ...rateLimiterOptions,
    });
    logger.info('✅ Rate limiter upgraded to Redis store');
  } catch (error) {
    logger.warn('⚠️  Keeping memory-based rate limiter (Redis not available)');
  }
}

// Different limits for different endpoints
const strictRateLimiter = new RateLimiterMemory({
  keyPrefix: 'strict_rate_limit',
  points: 5, // 5 requests
  duration: 60, // Per minute
  blockDuration: 300, // Block for 5 minutes
});

const authRateLimiter = new RateLimiterMemory({
  keyPrefix: 'auth_rate_limit',
  points: 10, // 10 login attempts
  duration: 900, // Per 15 minutes
  blockDuration: 1800, // Block for 30 minutes
});

// Get client identifier (IP + User ID if authenticated)
function getClientId(req: Request): string {
  const userId = (req as any).user?.id;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  return userId ? `user:${userId}` : `ip:${ip}`;
}

// Generic rate limiter middleware
export function createRateLimiter(limiter: RateLimiterRedis | RateLimiterMemory) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientId = getClientId(req);
      const result = await limiter.consume(clientId);
      
      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': rateLimiterOptions.points.toString(),
        'X-RateLimit-Remaining': result.remainingPoints?.toString() || '0',
        'X-RateLimit-Reset': new Date(Date.now() + result.msBeforeNext).toISOString(),
      });
      
      next();
    } catch (rejRes: any) {
      // Rate limit exceeded
      const secs = Math.round(rejRes.msBeforeNext / 1000) || 1;
      
      logger.warn('Rate limit exceeded:', {
        clientId: getClientId(req),
        path: req.path,
        method: req.method,
        resetTime: secs,
      });
      
      res.set({
        'X-RateLimit-Limit': rateLimiterOptions.points.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(Date.now() + rejRes.msBeforeNext).toISOString(),
        'Retry-After': secs.toString(),
      });
      
      res.status(429).json({
        success: false,
        error: {
          message: 'Too many requests',
          retryAfter: secs,
        },
        timestamp: new Date().toISOString(),
      });
    }
  };
}

// Default rate limiter - now using a function that references the main limiter
export const rateLimiter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  return createRateLimiter(mainRateLimiter)(req, res, next);
};

// Strict rate limiter for sensitive endpoints
export const strictRateLimit = createRateLimiter(strictRateLimiter);

// Auth-specific rate limiter
export const authRateLimit = createRateLimiter(authRateLimiter);

// WebSocket rate limiter
export class WebSocketRateLimiter {
  private limiter: RateLimiterMemory;

  constructor() {
    this.limiter = new RateLimiterMemory({
      keyPrefix: 'ws_rate_limit',
      points: 60, // 60 messages
      duration: 60, // Per minute
      blockDuration: 300, // Block for 5 minutes
    });
  }

  async checkLimit(clientId: string): Promise<boolean> {
    try {
      await this.limiter.consume(clientId);
      return true;
    } catch (rejRes) {
      logger.warn('WebSocket rate limit exceeded:', { clientId });
      return false;
    }
  }

  async getRemainingPoints(clientId: string): Promise<number> {
    try {
      const result = await this.limiter.get(clientId);
      return result?.remainingPoints || 0;
    } catch (error) {
      return 0;
    }
  }
}

export const wsRateLimiter = new WebSocketRateLimiter();