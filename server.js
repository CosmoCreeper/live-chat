const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Server settings
let serverSettings = {
  allowHistoryForNewUsers: true,
  maxMessageLength: 1000,
  allowAttachments: true,
  allowVoiceChat: true,
  serverName: "Chat Server",
  ownerId: null
};

// Storage for messages and users
let messages = [];
let users = new Map();
let voiceRooms = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = './uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|pdf|doc|docx|txt/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Middleware
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(express.json());

// Utility functions
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>]/g, '').trim();
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function processMessage(text) {
  // Convert URLs to clickable links
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    url: `/uploads/${req.file.filename}`
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Set server owner if first user
  if (serverSettings.ownerId === null) {
    serverSettings.ownerId = socket.id;
    socket.emit('owner_status', true);
  }
  
  // Send server settings to new user
  socket.emit('server_settings', serverSettings);
  
  // Handle user joining
  socket.on('user_join', (userData) => {
    const sanitizedUsername = sanitizeInput(userData.username) || 'Anonymous';
    const user = {
      id: socket.id,
      username: sanitizedUsername,
      bubbleColor: userData.bubbleColor || '#007bff',
      isOwner: socket.id === serverSettings.ownerId,
      joinTime: new Date()
    };
    
    users.set(socket.id, user);
    socket.emit('user_data', user);
    
    // Send message history if enabled
    if (serverSettings.allowHistoryForNewUsers) {
      socket.emit('message_history', messages);
    }
    
    // Broadcast user list update
    io.emit('users_update', Array.from(users.values()));
    
    // Broadcast join message
    const joinMessage = {
      id: uuidv4(),
      type: 'system',
      content: `${sanitizedUsername} joined the chat`,
      timestamp: new Date(),
      username: 'System'
    };
    
    messages.push(joinMessage);
    io.emit('new_message', joinMessage);
  });
  
  // Handle username change
  socket.on('change_username', (newUsername) => {
    const user = users.get(socket.id);
    if (user) {
      const oldUsername = user.username;
      const sanitizedUsername = sanitizeInput(newUsername) || 'Anonymous';
      user.username = sanitizedUsername;
      users.set(socket.id, user);
      
      const changeMessage = {
        id: uuidv4(),
        type: 'system',
        content: `${oldUsername} changed their name to ${sanitizedUsername}`,
        timestamp: new Date(),
        username: 'System'
      };
      
      messages.push(changeMessage);
      io.emit('new_message', changeMessage);
      io.emit('users_update', Array.from(users.values()));
    }
  });
  
  // Handle bubble color change
  socket.on('change_bubble_color', (newColor) => {
    const user = users.get(socket.id);
    if (user) {
      user.bubbleColor = newColor;
      users.set(socket.id, user);
      io.emit('users_update', Array.from(users.values()));
    }
  });
  
  // Handle new message
  socket.on('send_message', (messageData) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const sanitizedContent = sanitizeInput(messageData.content);
    if (!sanitizedContent && !messageData.attachment) return;
    
    const message = {
      id: uuidv4(),
      type: 'user',
      content: processMessage(sanitizedContent),
      username: user.username,
      userId: socket.id,
      bubbleColor: user.bubbleColor,
      timestamp: new Date(),
      formatting: messageData.formatting || {},
      attachment: messageData.attachment || null,
      replyTo: messageData.replyTo || null,
      reactions: new Map()
    };
    
    messages.push(message);
    io.emit('new_message', message);
  });
  
  // Handle message editing
  socket.on('edit_message', (data) => {
    const { messageId, newContent } = data;
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    
    if (messageIndex !== -1 && messages[messageIndex].userId === socket.id) {
      const sanitizedContent = sanitizeInput(newContent);
      messages[messageIndex].content = processMessage(sanitizedContent);
      messages[messageIndex].edited = true;
      messages[messageIndex].editedAt = new Date();
      
      io.emit('message_edited', {
        messageId,
        newContent: messages[messageIndex].content,
        edited: true,
        editedAt: messages[messageIndex].editedAt
      });
    }
  });
  
  // Handle message deletion
  socket.on('delete_message', (messageId) => {
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    const user = users.get(socket.id);
    
    if (messageIndex !== -1 && 
        (messages[messageIndex].userId === socket.id || user?.isOwner)) {
      messages.splice(messageIndex, 1);
      io.emit('message_deleted', messageId);
    }
  });
  
  // Handle reactions
  socket.on('add_reaction', (data) => {
    const { messageId, emoji } = data;
    const messageIndex = messages.findIndex(msg => msg.id === messageId);
    const user = users.get(socket.id);
    
    if (messageIndex !== -1 && user) {
      if (!messages[messageIndex].reactions) {
        messages[messageIndex].reactions = new Map();
      }
      
      if (!messages[messageIndex].reactions.has(emoji)) {
        messages[messageIndex].reactions.set(emoji, []);
      }
      
      const reactionUsers = messages[messageIndex].reactions.get(emoji);
      if (!reactionUsers.includes(user.username)) {
        reactionUsers.push(user.username);
        io.emit('reaction_added', { messageId, emoji, users: reactionUsers });
      }
    }
  });
  
  // Handle voice chat
  socket.on('join_voice', (roomId) => {
    if (!serverSettings.allowVoiceChat) return;
    
    const user = users.get(socket.id);
    if (!user) return;
    
    if (!voiceRooms.has(roomId)) {
      voiceRooms.set(roomId, new Set());
    }
    
    voiceRooms.get(roomId).add(socket.id);
    socket.join(`voice_${roomId}`);
    
    io.to(`voice_${roomId}`).emit('voice_user_joined', {
      userId: socket.id,
      username: user.username
    });
  });
  
  socket.on('leave_voice', (roomId) => {
    const room = voiceRooms.get(roomId);
    if (room) {
      room.delete(socket.id);
      socket.leave(`voice_${roomId}`);
      
      if (room.size === 0) {
        voiceRooms.delete(roomId);
      }
      
      io.to(`voice_${roomId}`).emit('voice_user_left', socket.id);
    }
  });
  
  // Handle server settings (owner only)
  socket.on('update_server_settings', (newSettings) => {
    const user = users.get(socket.id);
    if (user && user.isOwner) {
      serverSettings = { ...serverSettings, ...newSettings };
      io.emit('server_settings', serverSettings);
    }
  });
  
  // Handle search
  socket.on('search_messages', (query) => {
    const sanitizedQuery = sanitizeInput(query).toLowerCase();
    const results = messages.filter(msg => 
      msg.content.toLowerCase().includes(sanitizedQuery) ||
      msg.username.toLowerCase().includes(sanitizedQuery)
    );
    
    socket.emit('search_results', results);
  });
  
  // Handle WebRTC signaling for voice chat
  socket.on('webrtc_offer', (data) => {
    socket.to(data.target).emit('webrtc_offer', {
      offer: data.offer,
      sender: socket.id
    });
  });
  
  socket.on('webrtc_answer', (data) => {
    socket.to(data.target).emit('webrtc_answer', {
      answer: data.answer,
      sender: socket.id
    });
  });
  
  socket.on('webrtc_ice_candidate', (data) => {
    socket.to(data.target).emit('webrtc_ice_candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      
      // Remove from voice rooms
      voiceRooms.forEach((room, roomId) => {
        if (room.has(socket.id)) {
          room.delete(socket.id);
          io.to(`voice_${roomId}`).emit('voice_user_left', socket.id);
          if (room.size === 0) {
            voiceRooms.delete(roomId);
          }
        }
      });
      
      const leaveMessage = {
        id: uuidv4(),
        type: 'system',
        content: `${user.username} left the chat`,
        timestamp: new Date(),
        username: 'System'
      };
      
      messages.push(leaveMessage);
      io.emit('new_message', leaveMessage);
      io.emit('users_update', Array.from(users.values()));
      
      // Transfer ownership if owner leaves
      if (user.isOwner && users.size > 0) {
        const newOwner = users.values().next().value;
        if (newOwner) {
          newOwner.isOwner = true;
          serverSettings.ownerId = newOwner.id;
          io.to(newOwner.id).emit('owner_status', true);
          io.emit('server_settings', serverSettings);
        }
      }
    }
    
    console.log('User disconnected:', socket.id);
  });
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access the chat at: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

module.exports = { app, server, io };