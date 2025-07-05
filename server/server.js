const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

// Create Express app
const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// CORS configuration
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "https://your-vercel-app.vercel.app" // Replace with your actual Vercel URL
  ],
  methods: ["GET", "POST"],
  credentials: true
};

// Security middleware
app.use(helmet({
  crossOriginEmbedderPolicy: false,
}));

// CORS middleware
app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Socket.io setup with CORS
const io = socketIo(server, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Store connected users and rooms
let rooms = new Map(); // roomId -> { users: Set, messages: Array }
let connectedUsers = 0;

// Room and user management
class RoomManager {
    static joinRoom(socket, userName, roomId) {
        // Validate inputs
        if (!userName || !roomId) {
            return { success: false, error: 'Name and Room ID are required' };
        }
        
        if (userName.length > 30) {
            return { success: false, error: 'Name is too long (max 30 characters)' };
        }
        
        if (roomId.length > 20) {
            return { success: false, error: 'Room ID is too long (max 20 characters)' };
        }
        
        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                users: new Map(), // socketId -> userName
                createdAt: new Date()
            });
        }
        
        const room = rooms.get(roomId);
        
        // Add user to room
        room.users.set(socket.id, userName);
        socket.userName = userName;
        socket.roomId = roomId;
        
        // Join socket.io room
        socket.join(roomId);
        
        return { success: true, room };
    }
    
    static leaveRoom(socket) {
        if (!socket.roomId) return;
        
        const room = rooms.get(socket.roomId);
        if (room) {
            room.users.delete(socket.id);
            
            // Remove room if empty
            if (room.users.size === 0) {
                rooms.delete(socket.roomId);
            }
        }
        
        socket.leave(socket.roomId);
    }
    
    static getRoomUsers(roomId) {
        const room = rooms.get(roomId);
        return room ? Array.from(room.users.values()) : [];
    }
    
    static getRoomCount() {
        return rooms.size;
    }
    
    static getUserCount() {
        let total = 0;
        for (const room of rooms.values()) {
            total += room.users.size;
        }
        return total;
    }
}

// Message validation
const validateMessage = (message) => {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message must be a string' };
  }
  
  if (message.trim().length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }
  
  if (message.length > 500) {
    return { valid: false, error: 'Message too long (max 500 characters)' };
  }
  
  return { valid: true };
};

// Sanitize message content
const sanitizeMessage = (message) => {
  // Remove potentially harmful HTML tags and scripts
  return message
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
};

// Socket.io connection handling
io.on('connection', (socket) => {
    connectedUsers++;
    console.log(`User connected: ${socket.id} (Total connections: ${connectedUsers})`);

    // Handle room joining
    socket.on('join-room', (data) => {
        try {
            const { userName, roomId } = data;
            
            // Join room
            const result = RoomManager.joinRoom(socket, userName, roomId);
            
            if (!result.success) {
                socket.emit('room-join-failed', { message: result.error });
                return;
            }
            
            console.log(`${userName} joined room ${roomId}`);
            
            // Send success response
            socket.emit('room-joined', {
                roomId: roomId,
                userName: userName,
                users: RoomManager.getRoomUsers(roomId)
            });
            
            // Send welcome message to the user
            socket.emit('message', {
                message: `Welcome to Room ${roomId}, ${userName}! 👋`,
                timestamp: new Date().toISOString(),
                isSystem: true
            });
            
            // Notify other users in the room
            socket.to(roomId).emit('user-joined', {
                userName: userName,
                timestamp: new Date().toISOString()
            });
            
            // Send room status to everyone in the room
            const userCount = RoomManager.getRoomUsers(roomId).length;
            io.to(roomId).emit('message', {
                message: `${userName} joined the room! (${userCount} user${userCount !== 1 ? 's' : ''} online)`,
                timestamp: new Date().toISOString(),
                isSystem: true
            });
            
        } catch (error) {
            console.error('Error joining room:', error);
            socket.emit('room-join-failed', { message: 'Failed to join room' });
        }
    });

    // Handle incoming messages
    socket.on('message', (data) => {
        try {
            // Check if user is in a room
            if (!socket.roomId || !socket.userName) {
                socket.emit('error', { message: 'You must join a room first' });
                return;
            }
            
            // Validate message
            const validation = validateMessage(data.message);
            if (!validation.valid) {
                socket.emit('error', { message: validation.error });
                return;
            }

            // Sanitize message
            const sanitizedMessage = sanitizeMessage(data.message);
            
            // Create message object
            const messageData = {
                message: sanitizedMessage,
                timestamp: new Date().toISOString(),
                userName: socket.userName,
                roomId: socket.roomId,
                isSystem: false
            };

            // Broadcast message to all users in the same room
            io.to(socket.roomId).emit('message', messageData);
            
            console.log(`Message from ${socket.userName} in room ${socket.roomId}: ${sanitizedMessage}`);
        } catch (error) {
            console.error('Error handling message:', error);
            socket.emit('error', { message: 'Failed to process message' });
        }
    });

    // Handle room leaving
    socket.on('leave-room', () => {
        handleUserLeaving(socket);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
        handleUserLeaving(socket);
        connectedUsers = Math.max(0, connectedUsers - 1);
        console.log(`User disconnected: ${socket.id} (Reason: ${reason}, Total connections: ${connectedUsers})`);
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
});

// Handle user leaving (disconnect or manual leave)
function handleUserLeaving(socket) {
    if (socket.roomId && socket.userName) {
        const roomId = socket.roomId;
        const userName = socket.userName;
        
        // Remove from room
        RoomManager.leaveRoom(socket);
        
        // Notify other users in the room
        socket.to(roomId).emit('user-left', {
            userName: userName,
            timestamp: new Date().toISOString()
        });
        
        // Send room status to remaining users
        const userCount = RoomManager.getRoomUsers(roomId).length;
        if (userCount > 0) {
            io.to(roomId).emit('message', {
                message: `${userName} left the room (${userCount} user${userCount !== 1 ? 's' : ''} remaining)`,
                timestamp: new Date().toISOString(),
                isSystem: true
            });
        }
        
        console.log(`${userName} left room ${roomId}`);
    }
}

// Basic routes
app.get('/', (req, res) => {
  res.json({
    message: 'Anonymous Chat Server with Rooms',
    status: 'running',
    timestamp: new Date().toISOString(),
    totalConnections: connectedUsers,
    totalRooms: RoomManager.getRoomCount(),
    totalUsers: RoomManager.getUserCount(),
    environment: NODE_ENV
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalConnections: connectedUsers,
    totalRooms: RoomManager.getRoomCount(),
    totalUsers: RoomManager.getUserCount()
  });
});

// API info endpoint
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Anonymous Chat API with Rooms',
    version: '1.0.0',
    totalConnections: connectedUsers,
    totalRooms: RoomManager.getRoomCount(),
    totalUsers: RoomManager.getUserCount(),
    timestamp: new Date().toISOString()
  });
});

// Room stats endpoint
app.get('/api/rooms', (req, res) => {
  const roomStats = [];
  for (const [roomId, room] of rooms) {
    roomStats.push({
      roomId,
      userCount: room.users.size,
      createdAt: room.createdAt
    });
  }
  
  res.json({
    totalRooms: rooms.size,
    rooms: roomStats,
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found on this server.',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({
    error: 'Internal Server Error',
    message: NODE_ENV === 'development' ? error.message : 'Something went wrong!',
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\nReceived ${signal}. Graceful shutdown...`);
  
  server.close(() => {
    console.log('HTTP server closed.');
    
    // Close all socket connections
    io.close(() => {
      console.log('Socket.io server closed.');
      process.exit(0);
    });
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Start server
server.listen(PORT, () => {
  console.log(`
🚀 Anonymous Chat Server is running!
📍 Port: ${PORT}
🌍 Environment: ${NODE_ENV}
🕐 Started at: ${new Date().toISOString()}
📡 Socket.io ready for connections
  `);
});

module.exports = { app, server, io };
