require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Environment / Config
const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL;

// Mongoose models
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatarImage: { type: String }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String },
  type: { type: String, default: 'text' }, // e.g. 'text', 'file'
  file: { type: String }, // base64 or url
  time: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Connect to MongoDB
if (!MONGO_URL) {
  console.error('MONGO_URL not set in environment');
} else {
  mongoose.connect(MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }).then(() => {
    console.log('Connected to MongoDB');
  }).catch(err => {
    console.error('MongoDB connection error:', err);
  });
}

// Auth routes
const authRouter = express.Router();

// Register
authRouter.post('/register', async (req, res) => {
  try {
    const { name, email, password, avatarImage } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: 'User already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed, avatarImage });
    await user.save();
    // Return minimal user info
    return res.status(201).json({ user: { id: user._id, name: user.name, email: user.email, avatarImage: user.avatarImage } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Login
authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email and password required' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Invalid credentials' });
    return res.json({ user: { id: user._id, name: user.name, email: user.email, avatarImage: user.avatarImage } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
});

app.use('/api/auth', authRouter);

// Simple health check
app.get('/', (req, res) => {
  res.send({ status: 'ok', service: 'oleg-backend' });
});

// Socket.io logic
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // Join a room named by userId
  socket.on('join', (userId) => {
    if (!userId) return;
    socket.join(String(userId));
    console.log(`socket ${socket.id} joined room ${userId}`);
  });

  // send_message payload expected: { sender, receiver, text, type, file }
  socket.on('send_message', async (payload) => {
    try {
      const { sender, receiver, text, type, file } = payload || {};
      if (!sender || !receiver) return;
      const msg = new Message({
        sender,
        receiver,
        text,
        type: type || 'text',
        file
      });
      await msg.save();

      // Emit to receiver room
      io.to(String(receiver)).emit('receive_message', {
        id: msg._id,
        sender,
        receiver,
        text,
        type: msg.type,
        file: msg.file,
        time: msg.time
      });

    } catch (err) {
      console.error('Error saving/sending message', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

