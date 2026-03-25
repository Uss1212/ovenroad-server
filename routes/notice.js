/* ===================================================
   고객지원 API 라우터
   - 공지사항(NOTICE), FAQ, 문의(QUESTION), 답변(ANSWER)
   =================================================== */

const express = require('express');
const pool = require('../db');
const router = express.Router();

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

/* ── 3) 공지사항 작성 ── */
/* POST /api/notice */
router.post('/', async (req, res) => {
  try {
    const { userNum, title, content } = req.body;
    const [result] = await pool.query(
      'INSERT INTO NOTICE (USER_NUM, TITLE, CONTENT) VALUES (?, ?, ?)',
      [userNum, title, content || null]
    );
    res.status(201).json({ message: '공지사항이 등록되었습니다.', noticeNum: result.insertId });
  } catch (error) {
    console.error('공지사항 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
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

/* ===== 문의 (QUESTION + ANSWER) ===== */

/* ── 5) 문의 목록 조회 ── */
/* GET /api/notice/question/list */
router.get('/question/list', async (req, res) => {
  try {
    const { userNum } = req.query;

    let query = `
      SELECT q.*, u.NICKNAME AS author,
        (SELECT COUNT(*) FROM ANSWER a WHERE a.QUESTION_NUM = q.QUESTION_NUM) AS answerCount
      FROM QUESTION q
      JOIN USER u ON u.USER_NUM = q.USER_NUM
    `;
    const params = [];

    /* 특정 사용자의 문의만 조회 */
    if (userNum) {
      query += ' WHERE q.USER_NUM = ?';
      params.push(userNum);
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
router.get('/question/:questionNum', async (req, res) => {
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
router.post('/question', async (req, res) => {
  try {
    const { userNum, title, content } = req.body;
    const [result] = await pool.query(
      'INSERT INTO QUESTION (USER_NUM, TITLE, CONTENT) VALUES (?, ?, ?)',
      [userNum, title, content || null]
    );
    res.status(201).json({ message: '문의가 등록되었습니다.', questionNum: result.insertId });
  } catch (error) {
    console.error('문의 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 8) 답변 작성 ── */
/* POST /api/notice/question/:questionNum/answer */
router.post('/question/:questionNum/answer', async (req, res) => {
  try {
    const { questionNum } = req.params;
    const { userNum, content } = req.body;

    /* 답변 저장 */
    const [result] = await pool.query(
      'INSERT INTO ANSWER (QUESTION_NUM, USER_NUM, CONTENT) VALUES (?, ?, ?)',
      [questionNum, userNum, content || null]
    );

    /* 문의 상태를 "답변완료(1)"로 변경 */
    await pool.query('UPDATE QUESTION SET STATUS = 1 WHERE QUESTION_NUM = ?', [questionNum]);

    res.status(201).json({ message: '답변이 등록되었습니다.', answerNum: result.insertId });
  } catch (error) {
    console.error('답변 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
