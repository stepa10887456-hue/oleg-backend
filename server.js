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
    methods: ['GET', 'POST', 'PUT']
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const MONGO_URL = process.env.MONGO_URL;

// --- МОДЕЛИ ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatarImage: { type: String }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  // Mongoose ожидает формат 24 символа (ObjectId), а не "user_123"
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String },
  type: { type: String, default: 'text' },
  file: { type: String },
  time: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// --- ПОДКЛЮЧЕНИЕ К БД ---
if (!MONGO_URL) {
  console.error('Ошибка: MONGO_URL не указан в переменных окружения (.env)');
} else {
  mongoose.connect(MONGO_URL)
    .then(() => console.log('Успешное подключение к MongoDB'))
    .catch(err => console.error('Ошибка подключения к MongoDB:', err));
}

// --- РОУТЫ ---

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, 'name email avatarImage');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Ошибка при получении пользователей' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, avatarImage } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Заполните все обязательные поля' });
    }
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ message: 'Пользователь уже существует' });

    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed, avatarImage });
    await user.save();
    
    // ВАЖНО: Возвращаем _id, сгенерированный базой!
    return res.status(201).json({ _id: user._id, name: user.name, email: user.email, avatarImage: user.avatarImage });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Неверные данные' });
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Неверные данные' });
    
    return res.json({ 
      _id: user._id, 
      name: user.name, 
      email: user.email, 
      avatarImage: user.avatarImage 
    });
  } catch (err) {
    return res.status(500).json({ message: 'Ошибка сервера' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    const { name, avatarImage } = req.body;
    const userId = req.params.id;

    // Проверка валидности ID перед запросом к базе
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Неверный формат ID пользователя' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { name, avatarImage },
      { new: true }
    );

    if (!updatedUser) return res.status(404).json({ message: 'Пользователь не найден' });

    res.json({
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      avatarImage: updatedUser.avatarImage
    });
  } catch (err) {
    res.status(500).json({ message: 'Ошибка при обновлении профиля' });
  }
});

app.get('/', (req, res) => res.send({ status: 'ok', service: 'oleg-backend' }));

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  socket.on('join', (userId) => {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        console.log(`Попытка входа с невалидным ID: ${userId}`);
        return;
    }
    socket.join(String(userId));
    console.log(`Пользователь ${userId} подключился`);
  });

  socket.on('send_message', async (payload) => {
    try {
      const { sender, receiver, text, type, file } = payload;
      
      // КРИТИЧЕСКАЯ ПРОВЕРКА: если ID не валиден, мы не пытаемся сохранить его в базу
      if (!mongoose.Types.ObjectId.isValid(sender) || !mongoose.Types.ObjectId.isValid(receiver)) {
          console.error(`Ошибка: Невалидный ID отправителя (${sender}) или получателя (${receiver})`);
          return; 
      }

      const msg = new Message({
        sender,
        receiver,
        text,
        type: type || 'text',
        file
      });
      await msg.save();

      const messageData = {
        id: msg._id,
        sender,
        receiver,
        text,
        type: msg.type,
        file: msg.file,
        time: msg.time
      };

      io.to(String(receiver)).emit('receive_message', messageData);
      io.to(String(receiver)).emit('receive_message', messageData);
      io.to(String(sender)).emit('receive_message', messageData);
    } catch (err) {
      console.error(err);
    }
  });
});

server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));