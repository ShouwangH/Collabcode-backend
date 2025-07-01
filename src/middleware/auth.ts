import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@/utils/database';
import { logger } from '@/utils/logger';
import { CustomError } from './errorHandler';

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        username: string;
        role: string;
      };
    }
  }
}

export interface JWTPayload {
  userId: string;
  email: string;
  username: string;
  role: string;
  iat?: number;
  exp?: number;
}

// Verify JWT token
export function verifyToken(token: string): JWTPayload {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new CustomError('JWT secret not configured', 500);
  }

  try {
    return jwt.verify(token, secret) as JWTPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new CustomError('Token expired', 401);
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new CustomError('Invalid token', 401);
    } else {
      throw new CustomError('Token verification failed', 401);
    }
  }
}

// Generate JWT token
export function generateToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || '15m';
  
  if (!secret) {
    throw new CustomError('JWT secret not configured', 500);
  }

  return jwt.sign(payload, secret, { expiresIn });
}

// Generate refresh token
export function generateRefreshToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  
  if (!secret) {
    throw new CustomError('JWT secret not configured', 500);
  }

  return jwt.sign(payload, secret, { expiresIn });
}

// Extract token from request
function extractToken(req: Request): string | null {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check cookies (for web clients)
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  return null;
}

// Authentication middleware
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req);
    
    if (!token) {
      throw new CustomError('Access token required', 401);
    }

    // Verify token
    const decoded = verifyToken(token);
    
    // Get user from database to ensure they still exist and are active
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    });

    if (!user) {
      throw new CustomError('User not found', 401);
    }

    if (!user.isActive) {
      throw new CustomError('User account is disabled', 401);
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    next();
  } catch (error) {
    if (error instanceof CustomError) {
      next(error);
    } else {
      logger.error('Authentication error:', error);
      next(new CustomError('Authentication failed', 401));
    }
  }
}

// Optional authentication middleware (doesn't fail if no token)
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractToken(req);
    
    if (token) {
      const decoded = verifyToken(token);
      
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          isActive: true,
        },
      });

      if (user && user.isActive) {
        req.user = {
          id: user.id,
          email: user.email,
          username: user.username,
          role: user.role,
        };
      }
    }

    next();
  } catch (error) {
    // For optional auth, we don't fail on errors
    logger.warn('Optional authentication warning:', error);
    next();
  }
}

// Role-based authorization middleware
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new CustomError('Authentication required', 401));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new CustomError('Insufficient permissions', 403));
      return;
    }

    next();
  };
}

// Check if user owns resource or has admin role
export function requireOwnershipOrAdmin(getUserId: (req: Request) => string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new CustomError('Authentication required', 401);
      }

      const resourceUserId = getUserId(req);
      const isOwner = req.user.id === resourceUserId;
      const isAdmin = req.user.role === 'ADMIN';

      if (!isOwner && !isAdmin) {
        throw new CustomError('Access denied', 403);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

// WebSocket authentication helper
export async function authenticateSocket(token: string): Promise<JWTPayload | null> {
  try {
    const decoded = verifyToken(token);
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      return null;
    }

    return {
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };
  } catch (error) {
    logger.warn('WebSocket authentication failed:', error);
    return null;
  }
}