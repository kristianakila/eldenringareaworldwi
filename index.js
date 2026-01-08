import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import dayjs from "dayjs";
import fs from "fs";

const serviceAccount = JSON.parse(fs.readFileSync("./serviceKey.json", "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const SEASON_START = dayjs("2026-01-01"); // дата старта проекта
const SEASON_LENGTH_DAYS = 30;

/* ====== УТИЛИТЫ ====== */
function getSeasonNumber() {
  const now = dayjs();
  const diff = now.diff(SEASON_START, "day");
  return Math.floor(diff / SEASON_LENGTH_DAYS) + 1;
}

/* ====== ПОЛУЧИТЬ / СОЗДАТЬ ЮЗЕРА ====== */
app.post("/api/init", async (req, res) => {
  const { userId, username } = req.body;

  const ref = db.doc(`telegramUsers/${userId}`);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      userId,
      username,
      start_date: admin.firestore.FieldValue.serverTimestamp(),
      last_checkin: null,
      streak: 0,
      best_streak: 0,
      total_checkins: 0,
      season: getSeasonNumber(),
    });
  }

  const data = (await ref.get()).data();
  res.json(data);
});

/* ====== ОТМЕТИТЬСЯ ====== */
app.post("/api/checkin", async (req, res) => {
  const { userId } = req.body;

  const ref = db.doc(`telegramUsers/${userId}`);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).send("User not found");

  const data = snap.data();

  const today = dayjs().format("YYYY-MM-DD");

  // если уже отмечался сегодня
  if (data.last_checkin === today) {
    return res.json(data);
  }

  let newStreak = 1;

  if (data.last_checkin) {
    const diff = dayjs(today).diff(dayjs(data.last_checkin), "day");

    if (diff === 1) {
      newStreak = data.streak + 1;
    } else {
      newStreak = 1; // пропуск → сброс
    }
  }

  const newBest = Math.max(data.best_streak || 0, newStreak);

  const newData = {
    last_checkin: today,
    streak: newStreak,
    best_streak: newBest,
    total_checkins: (data.total_checkins || 0) + 1,
    season: getSeasonNumber(),
  };

  await ref.update(newData);

  const updated = (await ref.get()).data();
  res.json(updated);
});

/* ====== РЕЙТИНГ ====== */
app.get("/api/rating", async (req, res) => {
  const snap = await db.collection("telegramUsers").get();

  const users = snap.docs.map(d => d.data());

  users.sort((a, b) => {
    if (b.best_streak !== a.best_streak) return b.best_streak - a.best_streak;
    if (b.total_checkins !== a.total_checkins) return b.total_checkins - a.total_checkins;
    return new Date(a.start_date?.toDate?.() || 0) - new Date(b.start_date?.toDate?.() || 0);
  });

  res.json(users.slice(0, 50));
});

/* ====== */
app.listen(3333, () => {
  console.log("Backend running on http://localhost:3333");
});
