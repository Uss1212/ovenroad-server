/* ===================================================
   MySQL 데이터베이스 연결 설정
   - 여러 파일에서 같은 DB 연결을 공유하기 위해 따로 분리
   - pool(풀): 여러 개의 DB 연결을 미리 만들어놓고 재사용
   =================================================== */

const mysql = require('mysql2/promise');

/* --- MySQL 연결 풀 만들기 --- */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',         /* DB 서버 주소 */
  port: process.env.DB_PORT || 3306,                /* MySQL 포트 */
  user: process.env.DB_USER || 'root',              /* DB 사용자 이름 */
  password: process.env.DB_PASSWORD || '',           /* DB 비밀번호 (.env에서 가져옴) */
  database: process.env.DB_NAME || 'ovenroad',      /* 데이터베이스 이름 */
  charset: 'utf8mb4',     /* 한글 등 유니코드 문자 깨짐 방지 */
  waitForConnections: true,
  connectionLimit: 10,
  /* Aiven 등 클라우드 DB는 SSL 필수 */
  ...(process.env.DB_SSL === 'true' && {
    ssl: { rejectUnauthorized: false },
  }),
});

module.exports = pool;
