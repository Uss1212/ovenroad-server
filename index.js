require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');

const userRouter = require('./routes/user');
const courseRouter = require('./routes/course');
const placeRouter = require('./routes/place');
const noticeRouter = require('./routes/notice');
const uploadRouter = require('./routes/upload');
const { router: aiCourseRouter } = require('./routes/aiCourse');

const pool = require('./db');

const app = express();

async function runMigrations() {
  const migrations = [
    { col: 'COVER_IMAGES', type: 'JSON' },
    { col: 'TAGS', type: 'JSON' },
  ];
  const questionMigrations = [
    { table: 'QUESTION', col: 'IS_PRIVATE', type: 'TINYINT(1) NOT NULL DEFAULT 0' },
    { table: 'PLACES', col: 'GOOGLE_PLACE_ID', type: 'VARCHAR(255) DEFAULT NULL' },
    { table: 'COURSES', col: 'IS_AI', type: 'TINYINT(1) NOT NULL DEFAULT 0' },
    { table: 'COURSES', col: 'VIEW_COUNT', type: 'INT NOT NULL DEFAULT 0' },
  ];
  for (const m of questionMigrations) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND COLUMN_NAME=?`,
      [m.table, m.col]
    );
    if (rows[0].cnt === 0) {
      await pool.query(`ALTER TABLE ${m.table} ADD COLUMN ${m.col} ${m.type}`);
      console.log(`마이그레이션: ${m.table}.${m.col} 컬럼 추가 완료`);
    }
  }
  for (const m of migrations) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='COURSES' AND COLUMN_NAME=?`,
      [m.col]
    );
    if (rows[0].cnt === 0) {
      await pool.query(`ALTER TABLE COURSES ADD COLUMN ${m.col} ${m.type}`);
      console.log(`마이그레이션: COURSES.${m.col} 컬럼 추가 완료`);
    }
  }
}
runMigrations().catch(err => console.error('마이그레이션 에러:', err.message));




app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.endsWith('.vercel.app') || origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    callback(new Error('CORS 차단'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/user', userRouter);
app.use('/api/courses', courseRouter);
app.use('/api/places', placeRouter);
app.use('/api/notice', noticeRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/ai-course', aiCourseRouter);

app.get('/', (req, res) => {
  res.json({ message: '오븐로드 백엔드 서버가 실행 중입니다!' });
});

app.use((err, req, res, next) => {
  console.error('서버 에러:', err.message);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

process.on('uncaughtException', (err) => {
  console.error('처리되지 않은 에러:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('처리되지 않은 Promise 에러:', err.message);
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`오븐로드 백엔드 서버 실행 중: http://localhost:${PORT}`);
});
