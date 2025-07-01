import { createClient, RedisClientType } from 'redis';
import { logger } from './logger';

let redisClient: RedisClientType;

export async function connectRedis(): Promise<void> {
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redisClient = createClient({
      url: redisUrl,
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            logger.error('❌ Redis connection failed after 20 retries');
            return false;
          }
          return Math.min(retries * 50, 1000);
        }
      }
    });

    // Redis event handlers
    redisClient.on('error', (error) => {
      logger.error('❌ Redis Client Error:', error);
    });

    redisClient.on('connect', () => {
      logger.info('🔄 Redis connecting...');
    });

    redisClient.on('ready', () => {
      logger.info('✅ Redis connected and ready');
    });

    redisClient.on('reconnecting', () => {
      logger.warn('🔄 Redis reconnecting...');
    });

    redisClient.on('end', () => {
      logger.info('🔌 Redis connection closed');
    });

    await redisClient.connect();
    
    // Test the connection
    await redisClient.ping();
    logger.info('✅ Redis connection verified');
    
  } catch (error) {
    logger.error('❌ Failed to connect to Redis:', error);
    throw error;
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    if (redisClient && redisClient.isOpen) {
      await redisClient.quit();
      logger.info('✅ Redis disconnected');
    }
  } catch (error) {
    logger.error('❌ Error disconnecting from Redis:', error);
    throw error;
  }
}

export function getRedisClient(): RedisClientType {
  if (!redisClient || !redisClient.isOpen) {
    throw new Error('Redis client is not connected');
  }
  return redisClient;
}

// Health check function
export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (!redisClient || !redisClient.isOpen) {
      return false;
    }
    const response = await redisClient.ping();
    return response === 'PONG';
  } catch (error) {
    logger.error('Redis health check failed:', error);
    return false;
  }
}

// Utility functions for common Redis operations
export class RedisService {
  static async set(key: string, value: string | object, expireInSeconds?: number): Promise<void> {
    const client = getRedisClient();
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    
    if (expireInSeconds) {
      await client.setEx(key, expireInSeconds, stringValue);
    } else {
      await client.set(key, stringValue);
    }
  }

  static async get(key: string): Promise<string | null> {
    const client = getRedisClient();
    return await client.get(key);
  }

  static async getObject<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Failed to parse Redis value for key ${key}:`, error);
      return null;
    }
  }

  static async delete(key: string): Promise<void> {
    const client = getRedisClient();
    await client.del(key);
  }

  static async exists(key: string): Promise<boolean> {
    const client = getRedisClient();
    const result = await client.exists(key);
    return result === 1;
  }

  static async expire(key: string, seconds: number): Promise<void> {
    const client = getRedisClient();
    await client.expire(key, seconds);
  }

  // Session management helpers
  static async setSession(sessionId: string, data: object, expireInSeconds = 3600): Promise<void> {
    await this.set(`session:${sessionId}`, data, expireInSeconds);
  }

  static async getSession<T>(sessionId: string): Promise<T | null> {
    return await this.getObject<T>(`session:${sessionId}`);
  }

  static async deleteSession(sessionId: string): Promise<void> {
    await this.delete(`session:${sessionId}`);
  }
}