import { Server, Socket } from 'socket.io';
import { authenticateSocket } from '@/middleware/auth';
import { wsRateLimiter } from '@/middleware/rateLimiter';
import { logger } from '@/utils/logger';
import { RedisService } from '@/utils/redis';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
  role?: string;
}

interface SessionParticipant {
  userId: string;
  username: string;
  socketId: string;
  joinedAt: Date;
  cursor?: {
    line: number;
    column: number;
  };
  selection?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

interface TextOperation {
  type: 'insert' | 'delete' | 'retain';
  position: number;
  content?: string;
  length?: number;
  userId: string;
  timestamp: number;
  sessionId: string;
}

interface CollaborationSession {
  sessionId: string;
  projectId: string;
  participants: Map<string, SessionParticipant>;
  currentContent: string;
  version: number;
  lastActivity: Date;
}

// In-memory session store (in production, this would be in Redis)
const activeSessions = new Map<string, CollaborationSession>();

export function setupWebSocket(io: Server): void {
  // Middleware for WebSocket authentication
  /*
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      
      if (!token) {
        return next(new Error('Authentication token required'));
      }

      const user = await authenticateSocket(token);
      if (!user) {
        return next(new Error('Invalid authentication token'));
      }

      socket.userId = user.userId;
      socket.username = user.username;
      socket.role = user.role;

      logger.info('WebSocket authenticated:', {
        userId: user.userId,
        username: user.username,
        socketId: socket.id
      });

      next();
    } catch (error) {
      logger.error('WebSocket authentication error:', error);
      next(new Error('Authentication failed'));
    }
  });
  */

  io.on('connection', (socket: AuthenticatedSocket) => {

    console.log('🔌 New socket connected:', socket.id);

      // Simple test event handler
  socket.on('test-event', (data) => {
    console.log('🧪 TEST EVENT RECEIVED:', data);
    socket.emit('test-response', { 
      message: 'Backend received your test!', 
      timestamp: new Date().toISOString(),
      socketId: socket.id 
    });
  });
  
  // Listen to ALL events for debugging
  socket.onAny((eventName, ...args) => {
    console.log(`🔊 EVENT RECEIVED: "${eventName}"`, args);
  });

    // For testing without auth, set dummy user info
    socket.userId = socket.id; // Use socket ID as user ID
    socket.username = `User-${socket.id.slice(0, 8)}`;
    socket.role = 'developer';

    logger.info('WebSocket client connected:', {
      socketId: socket.id,
      userId: socket.userId,
      username: socket.username
    });

    // DEBUG: Listen to ALL events
    socket.onAny((eventName, ...args) => {
      console.log(`🔊 Received event "${eventName}" from ${socket.id}:`, args);
    });

    // Handle joining a collaboration session
    socket.on('join-session', async (data: { sessionId: string }) => {
      try {
        const { sessionId } = data;

        logger.info('Client joining session:', {
          socketId: socket.id,
          sessionId,
          userId: socket.userId
        });

        // Simple session management (in production, validate session exists)
        let session = activeSessions.get(sessionId);
        if (!session) {
          session = {
            sessionId,
            projectId: 'temp-project',
            participants: new Map(),
            currentContent: '// Welcome to CollabCode collaborative session!\n',
            version: 1,
            lastActivity: new Date()
          };
          activeSessions.set(sessionId, session);
          logger.info('Created new session:', sessionId);
        }

        // Add participant to session
        const participant: SessionParticipant = {
          userId: socket.userId!,
          username: socket.username!,
          socketId: socket.id,
          joinedAt: new Date()
        };

        session.participants.set(socket.userId!, participant);
        socket.join(sessionId);
        console.log('🏠 Socket joined room. Current rooms:', Array.from(socket.rooms));
        console.log('🏠 All sockets in session room:');
        const socketsInRoom = await io.in(sessionId).fetchSockets();
        socketsInRoom.forEach(s => {
          console.log(`   - ${s.id} (User: ${s.userId}, Username: ${s.username})`);
        });
        socket.data.sessionId = sessionId;

        // Notify client they've joined successfully
        socket.emit('session-joined', {
          sessionId,
          currentContent: session.currentContent,
          version: session.version,
          participants: Array.from(session.participants.values()).map(p => ({
            userId: p.userId,
            username: p.username,
            joinedAt: p.joinedAt,
            cursor: p.cursor
          }))
        });

        // Notify other participants
        socket.to(sessionId).emit('participant-joined', {
          userId: participant.userId,
          username: participant.username,
          joinedAt: participant.joinedAt
        });

        logger.info('User successfully joined session:', {
          sessionId,
          userId: socket.userId,
          participantCount: session.participants.size
        });

      } catch (error) {
        logger.error('Error joining session:', error);
        socket.emit('error', { message: 'Failed to join session' });
      }
    });

    console.log('🎯 Setting up event listeners for socket:', socket.id);

    // Add a generic event listener to catch ANY events
    socket.onAny((eventName, ...args) => {
      console.log(`🔊 Received event "${eventName}" from ${socket.id}:`, args);
    });


    // Handle text operations
    socket.on('text-operation', async (operation: Omit<TextOperation, 'userId' | 'timestamp'>) => {
      console.log('📥 TEXT-OPERATION handler triggered!', operation);

      try {
        console.log('📥 Received text operation from client:', {
          operation,
          fromSocket: socket.id,
          fromUser: socket.userId
        });

        const sessionId = socket.data.sessionId;
        if (!sessionId) {
          console.error('❌ No sessionId found for socket:', socket.id);
          socket.emit('error', { message: 'Not in a session' });
          return;
        }

        console.log('🔍 Looking for session:', sessionId);
        const session = activeSessions.get(sessionId);
        if (!session) {
          console.error('❌ Session not found:', sessionId);
          socket.emit('error', { message: 'Session not found' });
          return;
        }

        console.log('✅ Session found, participants:', session.participants.size);

        // Create complete operation
        const completeOperation: TextOperation = {
          ...operation,
          userId: socket.userId!,
          timestamp: Date.now(),
          sessionId
        };

        // Apply operation to session content (simplified)
        session.currentContent = applyOperation(session.currentContent, completeOperation);
        session.version++;
        session.lastActivity = new Date();

        console.log('📤 Broadcasting operation to session:', sessionId);
        console.log('📊 Socket rooms:', Array.from(socket.rooms));

        // Broadcast operation to all participants except sender
        const broadcastResult = socket.to(sessionId).emit('operation-applied', completeOperation);
        console.log('📡 Broadcast sent, result:', broadcastResult);

        // Send acknowledgment to sender
        socket.emit('operation-acknowledged', {
          operationId: completeOperation.timestamp,
          newVersion: session.version
        });

      } catch (error) {
        console.error('❌ Error handling text operation:', error);
        socket.emit('error', { message: 'Failed to apply operation' });
      }
    });

    // Handle cursor updates
    socket.on('cursor-update', async (data: { line: number; column: number; selection?: any }) => {
      try {
        const sessionId = socket.data.sessionId;
        if (!sessionId) return;

        const session = activeSessions.get(sessionId);
        if (!session) return;

        // Update participant cursor
        const participant = session.participants.get(socket.userId!);
        if (participant) {
          participant.cursor = { line: data.line, column: data.column };
          participant.selection = data.selection;
        }

        // Broadcast cursor update to other participants
        socket.to(sessionId).emit('cursor-moved', {
          userId: socket.userId,
          username: socket.username,
          cursor: data,
          timestamp: Date.now()
        });

      } catch (error) {
        logger.error('Error handling cursor update:', error);
      }
    });

    // Handle leaving session
    socket.on('leave-session', () => {
      handleLeaveSession(socket);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      logger.info('WebSocket client disconnected:', {
        socketId: socket.id,
        userId: socket.userId,
        reason
      });
      handleLeaveSession(socket);
    });
  });

  logger.info('✅ WebSocket server configured and ready for connections');
}

// Helper function to handle leaving a session
function handleLeaveSession(socket: AuthenticatedSocket): void {
  const sessionId = socket.data.sessionId;
  if (!sessionId || !socket.userId) return;

  const session = activeSessions.get(sessionId);
  if (!session) return;

  // Remove participant from session
  session.participants.delete(socket.userId);
  socket.leave(sessionId);

  // Notify other participants
  socket.to(sessionId).emit('participant-left', {
    userId: socket.userId,
    username: socket.username
  });

  // Clean up empty sessions
  if (session.participants.size === 0) {
    activeSessions.delete(sessionId);
    logger.info('Session cleaned up:', { sessionId });
  }

  socket.data.sessionId = undefined;
}

// Simplified operation application (in production, use proper OT)
function applyOperation(content: string, operation: TextOperation): string {
  switch (operation.type) {
    case 'insert':
      return content.slice(0, operation.position) +
        (operation.content || '') +
        content.slice(operation.position);

    case 'delete':
      return content.slice(0, operation.position) +
        content.slice(operation.position + (operation.length || 0));

    case 'retain':
      return content; // No change for retain operations

    default:
      return content;
  }
}

// Get session status
export function getSessionStatus(sessionId: string): any {
  const session = activeSessions.get(sessionId);
  if (!session) return null;

  return {
    sessionId: session.sessionId,
    participantCount: session.participants.size,
    participants: Array.from(session.participants.values()).map(p => ({
      userId: p.userId,
      username: p.username,
      joinedAt: p.joinedAt
    })),
    version: session.version,
    lastActivity: session.lastActivity
  };
}

// Get all active sessions
export function getActiveSessions(): any[] {
  return Array.from(activeSessions.values()).map(session => ({
    sessionId: session.sessionId,
    participantCount: session.participants.size,
    lastActivity: session.lastActivity
  }));
}