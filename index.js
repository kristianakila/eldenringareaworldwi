const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Инициализация Firebase
const serviceAccount = require('./serviceKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100 // лимит запросов
});
app.use('/api/', limiter);

// Вспомогательные функции
const getCurrentSeason = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  
  // Сезоны: 0-2 весна, 3-5 лето, 6-8 осень, 9-11 зима
  const seasons = ['spring', 'summer', 'autumn', 'winter'];
  const seasonIndex = Math.floor(month / 3);
  
  return {
    id: `${year}-${seasons[seasonIndex]}`,
    name: seasons[seasonIndex],
    year: year,
    startDate: new Date(year, seasonIndex * 3, 1),
    endDate: new Date(year, (seasonIndex * 3) + 3, 0)
  };
};

const calculateStreak = (checkins) => {
  if (!checkins || checkins.length === 0) return 0;
  
  const sortedCheckins = [...checkins].sort((a, b) => b - a);
  let streak = 1;
  
  for (let i = 1; i < sortedCheckins.length; i++) {
    const prevDate = new Date(sortedCheckins[i - 1]);
    const currentDate = new Date(sortedCheckins[i]);
    
    // Проверяем, идут ли дни подряд
    prevDate.setDate(prevDate.getDate() - 1);
    if (prevDate.toDateString() === currentDate.toDateString()) {
      streak++;
    } else {
      break;
    }
  }
  
  return streak;
};

// API Endpoints

// 1. Получение данных пользователя
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const userRef = db.collection('users').doc(telegramId);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      return res.json({
        telegramId,
        startDate: new Date().toISOString(),
        totalCheckins: 0,
        currentStreak: 0,
        bestStreak: 0,
        checkins: [],
        currentSeason: getCurrentSeason()
      });
    }
    
    const userData = doc.data();
    const currentStreak = calculateStreak(userData.checkins || []);
    
    res.json({
      ...userData,
      currentStreak,
      currentSeason: getCurrentSeason()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Отметка о посещении
app.post('/api/checkin/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const userRef = db.collection('users').doc(telegramId);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      // Создаем нового пользователя
      await userRef.set({
        telegramId,
        startDate: today.toISOString(),
        totalCheckins: 1,
        bestStreak: 1,
        checkins: [today.getTime()],
        lastCheckin: today.toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return res.json({
        success: true,
        currentStreak: 1,
        totalCheckins: 1,
        isFirstCheckin: true
      });
    }
    
    const userData = doc.data();
    const lastCheckin = userData.lastCheckin ? new Date(userData.lastCheckin) : null;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    let newStreak = 1;
    let checkins = userData.checkins || [];
    
    // Проверяем, была ли уже отметка сегодня
    if (lastCheckin && lastCheckin.toDateString() === today.toDateString()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Already checked in today' 
      });
    }
    
    // Проверяем пропуск дня
    if (lastCheckin && lastCheckin.toDateString() === yesterday.toDateString()) {
      // Не пропущен день - продолжаем серию
      const currentStreak = calculateStreak(checkins);
      newStreak = currentStreak + 1;
    } else {
      // Пропущен день - сбрасываем серию
      newStreak = 1;
    }
    
    // Добавляем новую отметку
    checkins.push(today.getTime());
    
    // Обновляем лучшую серию
    const bestStreak = Math.max(userData.bestStreak || 0, newStreak);
    
    await userRef.update({
      totalCheckins: admin.firestore.FieldValue.increment(1),
      bestStreak: bestStreak,
      checkins: checkins,
      lastCheckin: today.toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    res.json({
      success: true,
      currentStreak: newStreak,
      totalCheckins: userData.totalCheckins + 1,
      bestStreak: bestStreak
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Получение рейтинга
app.get('/api/leaderboard/:season?', async (req, res) => {
  try {
    const season = req.params.season || getCurrentSeason().id;
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();
    
    const leaderboard = [];
    
    snapshot.forEach(doc => {
      const userData = doc.data();
      const currentStreak = calculateStreak(userData.checkins || []);
      
      leaderboard.push({
        telegramId: userData.telegramId,
        username: userData.username || `User_${userData.telegramId.slice(-4)}`,
        currentStreak,
        bestStreak: userData.bestStreak || 0,
        totalCheckins: userData.totalCheckins || 0,
        startDate: userData.startDate
      });
    });
    
    // Сортировка по правилам тай-брейка
    leaderboard.sort((a, b) => {
      if (b.bestStreak !== a.bestStreak) return b.bestStreak - a.bestStreak;
      if (b.totalCheckins !== a.totalCheckins) return b.totalCheckins - a.totalCheckins;
      return new Date(a.startDate) - new Date(b.startDate);
    });
    
    // Добавляем ранги
    leaderboard.forEach((user, index) => {
      user.rank = index + 1;
    });
    
    res.json({
      season,
      leaderboard: leaderboard.slice(0, 100), // Топ 100
      updatedAt: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Статистика пользователя
app.get('/api/stats/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    const userRef = db.collection('users').doc(telegramId);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      return res.json({
        telegramId,
        monthlyStats: {},
        totalDays: 0,
        consistency: 0
      });
    }
    
    const userData = doc.data();
    const checkins = userData.checkins || [];
    
    // Статистика по месяцам
    const monthlyStats = {};
    checkins.forEach(timestamp => {
      const date = new Date(timestamp);
      const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
      monthlyStats[monthKey] = (monthlyStats[monthKey] || 0) + 1;
    });
    
    // Расчет консистенции
    const startDate = new Date(userData.startDate);
    const today = new Date();
    const totalDays = Math.ceil((today - startDate) / (1000 * 60 * 60 * 24));
    const consistency = totalDays > 0 ? (checkins.length / totalDays * 100).toFixed(1) : 0;
    
    res.json({
      telegramId,
      monthlyStats,
      totalDays: totalDays || 1,
      checkinsCount: checkins.length,
      consistency: parseFloat(consistency),
      currentSeason: getCurrentSeason()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
