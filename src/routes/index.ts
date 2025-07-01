import { Router } from 'express';
import { authMiddleware, optionalAuthMiddleware } from '@/middleware/auth';

export default function setupRoutes(): Router {
  const router = Router();

  // Health check route (no auth required)
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0'
    });
  });

  // Temporary test route to verify server is working
  router.get('/test', optionalAuthMiddleware, (req, res) => {
    res.json({
      message: 'CollabCode API is working!',
      user: req.user || null,
      timestamp: new Date().toISOString()
    });
  });

  // TODO: Add these routes when we create the corresponding files
  // router.use('/auth', authRoutes);
  // router.use('/users', authMiddleware, userRoutes);
  // router.use('/projects', authMiddleware, projectRoutes);
  // router.use('/sessions', authMiddleware, sessionRoutes);
  // router.use('/reviews', authMiddleware, reviewRoutes);

  return router;
}

// Named export as well for flexibility
export { setupRoutes };