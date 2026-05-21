/* ===================================================
   고객지원 API 라우터
   - 공지사항(NOTICE), FAQ, 문의(QUESTION), 답변(ANSWER)
   =================================================== */

const express = require('express');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const router = express.Router();

/* ===================================================
   공통 유틸
   =================================================== */

/* 관리자 여부 확인
   - 현재 프로젝트에 auth middleware가 없어서 userNum을 body/query로 받음
   - USER.GRADE가 'admin' 또는 1이면 관리자라고 가정
*/
function isAdmin(user) {
  if (!user) return false;
  return user.grade === 'admin' || user.grade === 1 || user.grade === '1';
}

/* 질문 상태 동기화
   - 답변이 1개 이상 있으면 STATUS=1(답변완료)
   - 없으면 STATUS=0(답변대기)
*/
async function syncQuestionStatus(questionNum) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS count FROM ANSWER WHERE QUESTION_NUM = ?',
    [questionNum]
  );

  const status = rows[0].count > 0 ? 1 : 0;

  await pool.query(
    'UPDATE QUESTION SET STATUS = ? WHERE QUESTION_NUM = ?',
    [status, questionNum]
  );
}

/* JWT 인증 미들웨어 */
function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: '로그인이 필요합니다.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (error) {
    console.error('JWT 인증 에러:', error);
    return res.status(401).json({ message: '유효하지 않은 토큰입니다.' });
  }
}


/* ===== 공지사항 ===== */

/* ── 1) 공지사항 목록 조회 ── */
/* GET /api/notice */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT n.NOTICE_NUM, n.TITLE, n.CREATED_TIME, u.NICKNAME AS author
      FROM NOTICE n
      JOIN USER u ON u.USER_NUM = n.USER_NUM
      ORDER BY n.CREATED_TIME DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('공지사항 목록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 공지사항 상세 조회 ── */
/* GET /api/notice/:noticeNum */
router.get('/:noticeNum', async (req, res) => {
  try {
    const { noticeNum } = req.params;
    const [rows] = await pool.query(`
      SELECT n.*, u.NICKNAME AS author
      FROM NOTICE n
      JOIN USER u ON u.USER_NUM = n.USER_NUM
      WHERE n.NOTICE_NUM = ?
    `, [noticeNum]);

    if (rows.length === 0) {
      return res.status(404).json({ message: '공지사항을 찾을 수 없습니다.' });
    }

    /* 이전글 / 다음글 */
    const [prevNotice] = await pool.query(
      'SELECT NOTICE_NUM, TITLE FROM NOTICE WHERE NOTICE_NUM < ? ORDER BY NOTICE_NUM DESC LIMIT 1',
      [noticeNum]
    );
    const [nextNotice] = await pool.query(
      'SELECT NOTICE_NUM, TITLE FROM NOTICE WHERE NOTICE_NUM > ? ORDER BY NOTICE_NUM ASC LIMIT 1',
      [noticeNum]
    );

    res.json({
      ...rows[0],
      prevNotice: prevNotice[0] || null,
      nextNotice: nextNotice[0] || null,
    });
  } catch (error) {
    console.error('공지사항 상세 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});


/* 공지사항 등록 */
/* POST /api/notice */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, content } = req.body;
    const userNum = req.user.userNum;

    if (!userNum || !title || !title.trim()) {
      return res.status(400).json({ message: '작성자와 제목은 필수입니다.' });
    }

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 공지사항을 작성할 수 있습니다.' });
    }

    const [result] = await pool.query(
      'INSERT INTO NOTICE (USER_NUM, TITLE, CONTENT) VALUES (?, ?, ?)',
      [userNum, title.trim(), content || null]
    );

    res.status(201).json({
      message: '공지사항이 등록되었습니다.',
      noticeNum: result.insertId,
    });
  } catch (error) {
    console.error('공지사항 작성 에러:', error);
    res.status(500).json({ message: '공지사항 등록에 실패했습니다.' });
  }
});

/* 공지사항 수정 */
/* PUT /api/notice/:noticeNum */
router.put('/:noticeNum', authMiddleware, async (req, res) => {
  try {
    const { noticeNum } = req.params;
    const { title, content } = req.body;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 공지사항을 수정할 수 있습니다.' });
    }

    const [existing] = await pool.query(
      'SELECT NOTICE_NUM FROM NOTICE WHERE NOTICE_NUM = ?',
      [noticeNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '공지사항을 찾을 수 없습니다.' });
    }

    await pool.query(
      'UPDATE NOTICE SET TITLE = COALESCE(?, TITLE), CONTENT = COALESCE(?, CONTENT) WHERE NOTICE_NUM = ?',
      [title || null, content || null, noticeNum]
    );

    res.json({ message: '공지사항이 수정되었습니다.' });
  } catch (error) {
    console.error('공지사항 수정 에러:', error);
    res.status(500).json({ message: '공지사항 수정에 실패했습니다.' });
  }
});

/* 공지사항 삭제 */
/* DELETE /api/notice/:noticeNum */
router.delete('/:noticeNum', authMiddleware, async (req, res) => {
  try {
    const { noticeNum } = req.params;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 공지사항을 삭제할 수 있습니다.' });
    }

    const [result] = await pool.query(
      'DELETE FROM NOTICE WHERE NOTICE_NUM = ?',
      [noticeNum]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '공지사항을 찾을 수 없습니다.' });
    }

    res.json({ message: '공지사항이 삭제되었습니다.' });
  } catch (error) {
    console.error('공지사항 삭제 에러:', error);
    res.status(500).json({ message: '공지사항 삭제에 실패했습니다.' });
  }
});

/* ===== FAQ ===== */

/* ── 4) FAQ 목록 조회 ── */
/* GET /api/notice/faq/list */
router.get('/faq/list', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM FAQ ORDER BY DISPLAY_ORDER ASC'
    );
    res.json(rows);
  } catch (error) {
    console.error('FAQ 목록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* FAQ 등록 */
/* POST /api/notice/faq */
router.post('/faq', authMiddleware, async (req, res) => {
  try {
    const { question, answer, displayOrder } = req.body;

    if (!question || !question.trim() || !answer || !answer.trim()) {
      return res.status(400).json({ message: '질문과 답변은 필수입니다.' });
    }

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 FAQ를 등록할 수 있습니다.' });
    }

    const [result] = await pool.query(
      'INSERT INTO FAQ (USER_NUM, FAQ_QUESTION, FAQ_ANSWER, DISPLAY_ORDER) VALUES (?, ?, ?, ?)',
      [req.user.userNum, question.trim(), answer.trim(), displayOrder ?? 0]
    );

    res.status(201).json({
      message: 'FAQ가 등록되었습니다.',
      faqNum: result.insertId,
    });
  } catch (error) {
    console.error('FAQ 등록 에러:', error);
    res.status(500).json({ message: 'FAQ 등록에 실패했습니다.' });
  }
});

/* FAQ 수정 */
/* PUT /api/notice/faq/:faqNum */
router.put('/faq/:faqNum', authMiddleware, async (req, res) => {
  try {
    const { faqNum } = req.params;
    const { question, answer, displayOrder } = req.body;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 FAQ를 수정할 수 있습니다.' });
    }

    const [existing] = await pool.query(
      'SELECT FAQ_NUM FROM FAQ WHERE FAQ_NUM = ?',
      [faqNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: 'FAQ를 찾을 수 없습니다.' });
    }

    await pool.query(
      `UPDATE FAQ
       SET FAQ_QUESTION = COALESCE(?, FAQ_QUESTION),
           FAQ_ANSWER = COALESCE(?, FAQ_ANSWER),
           DISPLAY_ORDER = COALESCE(?, DISPLAY_ORDER)
       WHERE FAQ_NUM = ?`,
      [question || null, answer || null, displayOrder ?? null, faqNum]
    );

    res.json({ message: 'FAQ가 수정되었습니다.' });
  } catch (error) {
    console.error('FAQ 수정 에러:', error);
    res.status(500).json({ message: 'FAQ 수정에 실패했습니다.' });
  }
});

/* FAQ 삭제 */
/* DELETE /api/notice/faq/:faqNum */
router.delete('/faq/:faqNum', authMiddleware, async (req, res) => {
  try {
    const { faqNum } = req.params;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 FAQ를 삭제할 수 있습니다.' });
    }

    const [result] = await pool.query(
      'DELETE FROM FAQ WHERE FAQ_NUM = ?',
      [faqNum]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'FAQ를 찾을 수 없습니다.' });
    }

    res.json({ message: 'FAQ가 삭제되었습니다.' });
  } catch (error) {
    console.error('FAQ 삭제 에러:', error);
    res.status(500).json({ message: 'FAQ 삭제에 실패했습니다.' });
  }
});

/* ===== 문의 (QUESTION + ANSWER) ===== */

/* ── 5) 문의 목록 조회 ── */
/* GET /api/notice/question/list */
router.get('/question/list', authMiddleware, async (req, res) => {
  try {
    const requestUserNum = req.query.userNum;
    const admin = isAdmin(req.user);

    let query = `
      SELECT q.*, u.NICKNAME AS author,
        (SELECT COUNT(*) FROM ANSWER a WHERE a.QUESTION_NUM = q.QUESTION_NUM) AS answerCount
      FROM QUESTION q
      JOIN USER u ON u.USER_NUM = q.USER_NUM
    `;
    const params = [];

    if (admin) {
      /* 관리자: userNum 파라미터가 있으면 해당 사용자만, 없으면 전체 조회 */
      if (requestUserNum) {
        query += ' WHERE q.USER_NUM = ?';
        params.push(requestUserNum);
      }
    } else {
      /* 일반 사용자: 본인 문의만 조회 */
      query += ' WHERE q.USER_NUM = ?';
      params.push(req.user.userNum);
    }

    query += ' ORDER BY q.CREATED_TIME DESC';

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('문의 목록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 6) 문의 상세 + 답변 조회 ── */
/* GET /api/notice/question/:questionNum */
router.get('/question/:questionNum', authMiddleware, async (req, res) => {
  try {
    const { questionNum } = req.params;

    /* 문의 내용 */
    const [questions] = await pool.query(`
      SELECT q.*, u.NICKNAME AS author
      FROM QUESTION q
      JOIN USER u ON u.USER_NUM = q.USER_NUM
      WHERE q.QUESTION_NUM = ?
    `, [questionNum]);

    if (questions.length === 0) {
      return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });
    }

    const admin = isAdmin(req.user);
    if (!admin && Number(questions[0].USER_NUM) !== Number(req.user.userNum)) {
      return res.status(403).json({ message: '본인 문의만 조회할 수 있습니다.' });
    }

    /* 답변 목록 */
    const [answers] = await pool.query(`
      SELECT a.*, u.NICKNAME AS author
      FROM ANSWER a
      JOIN USER u ON u.USER_NUM = a.USER_NUM
      WHERE a.QUESTION_NUM = ?
      ORDER BY a.CREATED_TIME ASC
    `, [questionNum]);

    res.json({
      ...questions[0],
      answers,
    });
  } catch (error) {
    console.error('문의 상세 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 7) 문의 작성 ── */
/* POST /api/notice/question */
router.post('/question', authMiddleware, async (req, res) => {
  try {
    const { title, content, isPrivate } = req.body;
    const userNum = req.user.userNum;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: '문의 제목을 입력해주세요.' });
    }

    const [result] = await pool.query(
      'INSERT INTO QUESTION (USER_NUM, TITLE, CONTENT, IS_PRIVATE) VALUES (?, ?, ?, ?)',
      [userNum, title.trim(), content || null, isPrivate ? 1 : 0]
    );
    res.status(201).json({ message: '문의가 등록되었습니다.', questionNum: result.insertId });
  } catch (error) {
    console.error('문의 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* 문의 수정 */
/* PUT /api/notice/question/:questionNum */
router.put('/question/:questionNum', authMiddleware, async (req, res) => {
  try {
    const { questionNum } = req.params;
    const { title, content, isPrivate } = req.body;
    const userNum = req.user.userNum;

    const [existing] = await pool.query(
      'SELECT USER_NUM, STATUS FROM QUESTION WHERE QUESTION_NUM = ?',
      [questionNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      const admin = isAdmin(req.user);
      if (!admin) {
        return res.status(403).json({ message: '본인이 작성한 문의만 수정할 수 있습니다.' });
      }
    }

    /* 이미 답변이 달린 문의는 작성자가 수정 불가 (관리자는 가능) */
    if (existing[0].STATUS === 1 && !isAdmin(req.user)) {
      return res.status(400).json({ message: '답변이 등록된 문의는 수정할 수 없습니다.' });
    }

    if ((!title || !title.trim()) && (content === undefined || content === null)) {
      return res.status(400).json({ message: '수정할 내용을 입력해주세요.' });
    }

    await pool.query(
      'UPDATE QUESTION SET TITLE = COALESCE(?, TITLE), CONTENT = COALESCE(?, CONTENT), IS_PRIVATE = COALESCE(?, IS_PRIVATE) WHERE QUESTION_NUM = ?',
      [title ? title.trim() : null, content ?? null, isPrivate !== undefined ? (isPrivate ? 1 : 0) : null, questionNum]
    );

    res.json({ message: '문의가 수정되었습니다.' });
  } catch (error) {
    console.error('문의 수정 에러:', error);
    res.status(500).json({ message: '문의 수정에 실패했습니다.' });
  }
});

/* 문의 삭제 */
/* DELETE /api/notice/question/:questionNum */
router.delete('/question/:questionNum', authMiddleware, async (req, res) => {
  try {
    const { questionNum } = req.params;
    const userNum = req.user.userNum;

    const [existing] = await pool.query(
      'SELECT USER_NUM FROM QUESTION WHERE QUESTION_NUM = ?',
      [questionNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      const admin = isAdmin(req.user);
      if (!admin) {
        return res.status(403).json({ message: '본인 또는 관리자만 삭제할 수 있습니다.' });
      }
    }

    /* 답변 먼저 삭제 후 질문 삭제 */
    await pool.query('DELETE FROM ANSWER WHERE QUESTION_NUM = ?', [questionNum]);
    await pool.query('DELETE FROM QUESTION WHERE QUESTION_NUM = ?', [questionNum]);

    res.json({ message: '문의가 삭제되었습니다.' });
  } catch (error) {
    console.error('문의 삭제 에러:', error);
    res.status(500).json({ message: '문의 삭제에 실패했습니다.' });
  }
});
/* ── 8) 답변 작성 ── */
/* POST /api/notice/question/:questionNum/answer */
router.post('/question/:questionNum/answer', authMiddleware, async (req, res) => {
  try {
    const { questionNum } = req.params;
    const { content } = req.body;
    const userNum = req.user.userNum;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: '작성자와 답변 내용은 필수입니다.' });
    }

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 답변을 작성할 수 있습니다.' });
    }

    const [question] = await pool.query(
      'SELECT QUESTION_NUM FROM QUESTION WHERE QUESTION_NUM = ?',
      [questionNum]
    );

    if (question.length === 0) {
      return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });
    }

    const [result] = await pool.query(
      'INSERT INTO ANSWER (QUESTION_NUM, USER_NUM, CONTENT) VALUES (?, ?, ?)',
      [questionNum, userNum, content.trim()]
    );

    await syncQuestionStatus(questionNum);

    res.status(201).json({
      message: '답변이 등록되었습니다.',
      answerNum: result.insertId,
    });
  } catch (error) {
    console.error('답변 작성 에러:', error);
    res.status(500).json({ message: '답변 등록에 실패했습니다.' });
  }
});

/* 답변 수정 */
/* PUT /api/notice/question/:questionNum/answer/:answerNum */
router.put('/question/:questionNum/answer/:answerNum', authMiddleware, async (req, res) => {
  try {
    const { questionNum, answerNum } = req.params;
    const { content } = req.body;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 답변을 수정할 수 있습니다.' });
    }

    const [existing] = await pool.query(
      'SELECT ANSWER_NUM FROM ANSWER WHERE ANSWER_NUM = ? AND QUESTION_NUM = ?',
      [answerNum, questionNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '답변을 찾을 수 없습니다.' });
    }

    await pool.query(
      'UPDATE ANSWER SET CONTENT = COALESCE(?, CONTENT) WHERE ANSWER_NUM = ?',
      [content || null, answerNum]
    );

    res.json({ message: '답변이 수정되었습니다.' });
  } catch (error) {
    console.error('답변 수정 에러:', error);
    res.status(500).json({ message: '답변 수정에 실패했습니다.' });
  }
});

/* 답변 삭제 */
/* DELETE /api/notice/question/:questionNum/answer/:answerNum */
router.delete('/question/:questionNum/answer/:answerNum', authMiddleware, async (req, res) => {
  try {
    const { questionNum, answerNum } = req.params;

    const admin = isAdmin(req.user);
    if (!admin) {
      return res.status(403).json({ message: '관리자만 답변을 삭제할 수 있습니다.' });
    }

    const [result] = await pool.query(
      'DELETE FROM ANSWER WHERE ANSWER_NUM = ? AND QUESTION_NUM = ?',
      [answerNum, questionNum]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '답변을 찾을 수 없습니다.' });
    }

    await syncQuestionStatus(questionNum);

    res.json({ message: '답변이 삭제되었습니다.' });
  } catch (error) {
    console.error('답변 삭제 에러:', error);
    res.status(500).json({ message: '답변 삭제에 실패했습니다.' });
  }
});

module.exports = router;