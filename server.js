const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL;

// --- МОДЕЛИ ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatarImage: { type: String }
}, { timestamps: true });

// Новая модель для Групп и Каналов
const roomSchema = new mongoose.Schema({
    name: String,
    type: { type: String, enum: ['group', 'channel'], default: 'group' },
    avatar: String,
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiver: { type: mongoose.Schema.Types.ObjectId }, // UserID или RoomID
  text: String,
  type: { type: String, default: 'text' },
  file: String,
  isRoom: { type: Boolean, default: false }, // Флаг: в группу или лично
  time: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Room = mongoose.model('Room', roomSchema);
const Message = mongoose.model('Message', messageSchema);

// --- ПОДКЛЮЧЕНИЕ К БД ---
if (MONGO_URL) {
  mongoose.connect(MONGO_URL)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB Error:', err));
}

// --- API ---
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({}, 'name email avatarImage');
        res.json(users);
    } catch (e) { res.status(500).json({error: 'Error'}); }
});

// Получить группы пользователя
app.get('/api/rooms/:userId', async (req, res) => {
    try {
        const rooms = await Room.find({ members: req.params.userId });
        res.json(rooms);
    } catch (e) { res.status(500).json({error: 'Error'}); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: 'Пользователь существует' });
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed });
    await user.save();
    return res.status(201).json({ ...user._doc, id: user._id });
  } catch (err) { res.status(500).json({ message: 'Ошибка сервера' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password)) 
        return res.status(401).json({ message: 'Неверные данные' });
    return res.json({ ...user._doc, id: user._id });
  } catch (err) { res.status(500).json({ message: 'Ошибка сервера' }); }
});

// Обновление профиля
app.put('/api/users/:id', async (req, res) => {
    try {
        const { name, avatarImage } = req.body;
        await User.findByIdAndUpdate(req.params.id, { name, avatarImage });
        res.json({ success: true });
    } catch (e) { res.status(500).json({error: 'Error'}); }
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  
  socket.on('join', (userId) => {
    if(!userId) return;
    socket.join(String(userId));
    // Подключаем ко всем группам
    Room.find({ members: userId }).then(rooms => {
        rooms.forEach(r => socket.join(String(r._id)));
    });
  });

  // 1. ЗАПРОС НА ПЕРЕПИСКУ
  socket.on('chat_request', async ({ senderId, receiverId }) => {
      const sender = await User.findById(senderId);
      io.to(String(receiverId)).emit('incoming_request', {
          senderId,
          senderName: sender.name,
          senderUsername: sender.email
      });
  });

  socket.on('respond_request', ({ accepted, senderId, receiverName }) => {
      io.to(String(senderId)).emit('request_result', { accepted, receiverName });
  });

  // 2. СОЗДАНИЕ КОМНАТЫ
  socket.on('create_room', async (data) => {
      const newRoom = new Room({
          name: data.name,
          type: data.type,
          avatar: data.avatar,
          creator: data.creator,
          members: [data.creator, ...data.members], 
          admins: [data.creator]
      });
      await newRoom.save();
      
      // Рассылаем всем участникам
      newRoom.members.forEach(m => {
          io.to(String(m)).emit('room_created', newRoom);
      });
  });

  socket.on('join_room', (roomId) => socket.join(String(roomId)));

  // 3. СООБЩЕНИЯ
  socket.on('send_message', async (data) => {
      const msg = new Message({
          sender: data.sender,
          receiver: data.receiver,
          text: data.text,
          file: data.file,
          type: data.type,
          isRoom: data.isRoom
      });
      await msg.save();
      
      const payload = { ...msg._doc, id: msg._id, senderName: data.senderName };
      
      if (data.isRoom) {
          io.to(String(data.receiver)).emit('receive_message', payload);
      } else {
          io.to(String(data.receiver)).emit('receive_message', payload);
          // Отправителю тоже шлем, чтобы он видел (если вдруг не через локальный пуш)
          // io.to(String(data.sender)).emit('receive_message', payload);
      }
  });

  // 4. УДАЛЕНИЕ И ВЫХОД
  socket.on('delete_chat', async ({ userId, targetId, isRoom }) => {
      if(!isRoom) {
          await Message.deleteMany({
              $or: [
                  { sender: userId, receiver: targetId },
                  { sender: targetId, receiver: userId }
              ]
          });
          io.to(String(targetId)).emit('chat_cleared', { by: userId });
      }
  });

  socket.on('leave_room', async ({ userId, roomId }) => {
      await Room.findByIdAndUpdate(roomId, { $pull: { members: userId } });
      io.to(String(roomId)).emit('receive_message', {
          type: 'system',
          text: 'Пользователь покинул чат',
          receiver: roomId,
          isRoom: true
      });
      io.to(String(userId)).emit('left_room', roomId);
  });

  // Глобальное обновление профиля
  socket.on('profile_updated', (data) => {
      socket.broadcast.emit('contact_updated', data);
  });
});

server.listen(PORT, () => console.log('Server running on ' + PORT));