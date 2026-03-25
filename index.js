/* ===================================================
   오븐로드 백엔드 서버 (Express + MySQL)
   - 프론트엔드(React)에서 보내는 요청을 받아서 처리하는 서버
   - 포트: 8080 (http://localhost:8080)
   - MySQL 데이터베이스(ovenroad)와 연결
   - API 라우터를 기능별로 분리해서 관리
   =================================================== */

/* --- .env 파일에서 환경변수 불러오기 (가장 먼저 실행!) --- */
require('dotenv').config();

/* --- 필요한 도구들 가져오기 --- */
const express = require('express');   /* 서버를 쉽게 만들어주는 도구 */
const cors = require('cors');         /* 프론트엔드(다른 포트)에서 요청을 허용하는 도구 */
const path = require('path');         /* 파일 경로 도구 */

/* --- API 라우터 가져오기 --- */
/* 기능별로 분리한 API 파일들 */
const userRouter = require('./routes/user');       /* 사용자 (회원가입, 로그인 등) */
const courseRouter = require('./routes/course');    /* 코스 (CRUD, 좋아요, 스크랩) */
const placeRouter = require('./routes/place');      /* 장소 (검색, 리뷰 등) */
const noticeRouter = require('./routes/notice');    /* 고객지원 (공지, FAQ, 문의) */
const boardRouter = require('./routes/board');      /* 커뮤니티 게시판 (글쓰기, 댓글 등) */
const eventRouter = require('./routes/event');      /* 이벤트 (목록, 상세, 등록) */
const uploadRouter = require('./routes/upload');    /* 이미지 업로드 (Firebase Storage) */

/* --- Express 앱 만들기 --- */
const app = express();

/* --- 미들웨어 설정 --- */
/* cors(): 우리 프론트엔드 주소에서만 요청 허용 (보안) */
app.use(cors({
  origin: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  credentials: true,
}));
/* express.json(): 요청 본문의 JSON 데이터를 자동으로 파싱 */
app.use(express.json({ limit: '10mb' })); /* 이미지 base64 전송을 위해 크기 제한 늘림 */
/* /uploads 경로로 업로드된 이미지 파일을 직접 접근 가능하게 */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* --- API 라우터 연결 --- */
/* /api/user/xxx → userRouter가 처리 */
/* /api/courses/xxx → courseRouter가 처리 */
/* /api/places/xxx → placeRouter가 처리 */
/* /api/notice/xxx → noticeRouter가 처리 */
app.use('/api/user', userRouter);
app.use('/api/courses', courseRouter);
app.use('/api/places', placeRouter);
app.use('/api/notice', noticeRouter);
app.use('/api/board', boardRouter);   /* /api/board/xxx → boardRouter가 처리 */
app.use('/api/events', eventRouter);  /* /api/events/xxx → eventRouter가 처리 */
app.use('/api/upload', uploadRouter); /* /api/upload/xxx → uploadRouter가 처리 */

/* --- 서버 상태 확인용 API --- */
/* GET / → 서버가 살아있는지 확인 */
app.get('/', (req, res) => {
  res.json({ message: '오븐로드 백엔드 서버가 실행 중입니다!' });
});

/* ===================================================
   에러 처리 미들웨어
   - API에서 처리 못한 에러가 여기로 옴
   - 서버가 에러 하나 때문에 죽지 않도록 보호
   =================================================== */
app.use((err, req, res, next) => {
  console.error('서버 에러:', err.message);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

/* --- 예상치 못한 에러로 서버가 죽는 걸 방지 --- */
process.on('uncaughtException', (err) => {
  console.error('처리되지 않은 에러:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('처리되지 않은 Promise 에러:', err.message);
});

/* ===================================================
   서버 시작
   =================================================== */
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log('');
  console.log('===========================================');
  console.log('  오븐로드 백엔드 서버가 시작되었습니다!');
  console.log(`  주소: http://localhost:${PORT}`);
  console.log('');
  console.log('  API 목록:');
  console.log('  - /api/user     (회원가입, 로그인)');
  console.log('  - /api/courses  (코스 CRUD, 좋아요, 스크랩)');
  console.log('  - /api/places   (장소 검색, 리뷰)');
  console.log('  - /api/notice   (공지, FAQ, 문의)');
  console.log('===========================================');
  console.log('');
});
