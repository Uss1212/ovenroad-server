const express = require('express');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

const router = express.Router();

function isAdmin(user) {
  return user && (user.grade === 1 || user.grade === 'admin' || Number(user.grade) === 1);
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ message: '로그인이 필요합니다.' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: '토큰이 유효하지 않습니다.' });
  }
}

/* 핵심 생성 로직 — 크론과 API 엔드포인트에서 공유 */
async function generateAICourses(count = 3) {
  const [places] = await pool.query(
    `SELECT p.PLACE_NUM, p.PLACE_NAME, p.ADDRESS,
            GROUP_CONCAT(m.MENU_NAME SEPARATOR ', ') AS MENUS
     FROM PLACES p
     LEFT JOIN PLACE_MENU m ON p.PLACE_NUM = m.PLACE_NUM
     GROUP BY p.PLACE_NUM
     ORDER BY RAND()
     LIMIT 30`
  );

  if (places.length === 0) throw new Error('빵집 데이터가 없습니다.');

  /* 최근 14일간 생성된 AI 코스 제목/테마 → 중복 방지용 */
  const [recentCourses] = await pool.query(
    `SELECT TITLE, TAGS FROM COURSES
     WHERE IS_AI = 1 AND CREATED_TIME >= DATE_SUB(NOW(), INTERVAL 14 DAY)
     ORDER BY CREATED_TIME DESC LIMIT 20`
  );
  const recentThemes = recentCourses.map(c => {
    try {
      const tags = typeof c.TAGS === 'string' ? JSON.parse(c.TAGS) : c.TAGS;
      return tags?.theme ? `${c.TITLE} (${tags.theme})` : c.TITLE;
    } catch { return c.TITLE; }
  });

  const placeText = places.map(p =>
    `- ${p.PLACE_NAME} (${p.ADDRESS || '서울'}) | 메뉴: ${p.MENUS || '다양한 빵'}`
  ).join('\n');

  const avoidText = recentThemes.length > 0
    ? `\n\n❌ 최근 2주간 이미 만든 코스 (이 테마들과 겹치지 않게 해주세요):\n${recentThemes.map(t => `- ${t}`).join('\n')}`
    : '';

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: `당신은 서울의 베이커리 투어 코스를 기획하는 전문가입니다.
주어진 빵집 목록을 바탕으로 테마별 빵집 투어 코스를 JSON 배열로 생성해주세요.
테마는 매번 신선하고 다양하게: 동네 산책, 시간대(아침/브런치/야식), 특정 재료(흑임자/말차/치즈), 분위기(레트로/모던/아늑한), 목적(데이트/혼자/친구) 등 창의적으로 구성하세요.
반드시 아래 형식의 JSON만 반환하고, 다른 텍스트는 포함하지 마세요:
[
  {
    "title": "코스 제목",
    "subtitle": "한 줄 설명",
    "description": "코스 설명 (2-3문장)",
    "theme": "테마",
    "places": [
      { "name": "빵집 이름", "reason": "선택 이유 한 줄" }
    ]
  }
]`
      },
      {
        role: 'user',
        content: `다음 빵집 목록으로 서로 다른 테마의 베이커리 투어 코스 ${count}개를 만들어주세요. 각 코스는 3-5개의 빵집으로 구성하세요.${avoidText}\n\n빵집 목록:\n${placeText}`
      }
    ],
    temperature: 1.0,
    max_tokens: 2000,
  });

  const raw = completion.choices[0].message.content.trim();
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  const courses = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

  const AI_USER_NUM = 20;

  for (const course of courses) {
    const [result] = await pool.query(
      `INSERT INTO COURSES (USER_NUM, TITLE, SUBTITLE, CONTENT, TAGS, IS_AI)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [
        AI_USER_NUM,
        course.title,
        course.subtitle || '',
        course.description || '',
        JSON.stringify({ theme: course.theme, places: course.places }),
      ]
    );
    const courseNum = result.insertId;

    /* 빵집 이름으로 PLACES 테이블에서 매칭 → COURSE_PLACE 연결 */
    let order = 1;
    for (const p of (course.places || [])) {
      const [matched] = await pool.query(
        'SELECT PLACE_NUM FROM PLACES WHERE PLACE_NAME LIKE ? LIMIT 1',
        [`%${p.name}%`]
      );
      if (matched.length > 0) {
        await pool.query(
          'INSERT INTO COURSE_PLACE (COURSE_NUM, PLACE_NUM, PLACE_ORDER, IS_THUMBNAIL) VALUES (?, ?, ?, ?)',
          [courseNum, matched[0].PLACE_NUM, order, order === 1 ? 1 : 0]
        );
        order++;
      }
    }
  }

  const [saved] = await pool.query(
    'SELECT * FROM COURSES WHERE IS_AI = 1 ORDER BY CREATED_TIME DESC LIMIT 3'
  );
  return saved;
}

/* GET /api/ai-course — AI 추천 코스 목록 반환 */
/* ?all=true 이면 전체, 기본값은 최신 3개 (메인 페이지용) */
router.get('/', async (req, res) => {
  try {
    const all = req.query.all === 'true';
    const [rows] = await pool.query(`
      SELECT c.*,
        u.NICKNAME AS author,
        u.PROFILE_IMAGE AS authorImage,
        (SELECT pi.IMAGE_URL FROM COURSE_PLACE cp
         JOIN PLACE_IMAGE pi ON pi.PLACE_NUM = cp.PLACE_NUM
         WHERE cp.COURSE_NUM = c.COURSE_NUM
         ORDER BY cp.PLACE_ORDER ASC
         LIMIT 1) AS thumbnailImage
      FROM COURSES c
      JOIN USER u ON u.USER_NUM = c.USER_NUM
      WHERE c.IS_AI = 1
      ORDER BY c.CREATED_TIME DESC
      ${all ? '' : 'LIMIT 3'}
    `);
    res.json(rows);
  } catch (err) {
    console.error('AI 코스 조회 에러:', err.message);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* POST /api/ai-course/generate — 관리자 전용, 수동 생성 */
router.post('/generate', requireAuth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ message: '관리자만 사용할 수 있습니다.' });
  try {
    const saved = await generateAICourses(3);
    res.json({ message: `${saved.length}개의 AI 추천 코스가 생성되었습니다.`, courses: saved });
  } catch (err) {
    console.error('AI 코스 생성 에러:', err.message);
    res.status(500).json({ message: '서버 오류: ' + err.message });
  }
});

/* POST /api/ai-course/cron — 외부 크론 서비스 전용 */
router.post('/cron', async (req, res) => {
  try {
    const saved = await generateAICourses(3);
    res.json({ message: `${saved.length}개의 AI 추천 코스가 생성되었습니다.` });
  } catch (err) {
    console.error('[크론] AI 코스 생성 실패:', err.message);
    res.status(500).json({ message: '서버 오류: ' + err.message });
  }
});

module.exports = { router, generateAICourses };
