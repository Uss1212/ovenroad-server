/* ===================================================
   이벤트 API 라우터
   - 이벤트 목록 조회, 상세 조회, 등록
   =================================================== */

const express = require('express');
const pool = require('../db');
const router = express.Router();

/* ── 1) 이벤트 목록 조회 ── */
/* GET /api/events */
/* 상태(status) 쿼리로 필터링 가능: 진행중, 예정, 종료 */
router.get('/', async (req, res) => {
  try {
    /* 모든 이벤트를 가져옴 (최신순) */
    const [rows] = await pool.query(`
      SELECT e.*, u.NICKNAME AS author
      FROM EVENT e
      JOIN USER u ON u.USER_NUM = e.USER_NUM
      ORDER BY e.START_DATE DESC
    `);

    /* 각 이벤트에 상태(진행중/예정/종료)를 자동 계산해서 붙여줌 */
    const today = new Date();
    today.setHours(0, 0, 0, 0); /* 오늘 날짜의 시작 시점 */

    const eventsWithStatus = rows.map((event) => {
      const start = new Date(event.START_DATE);
      const end = new Date(event.END_DATE);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999); /* 종료일 끝까지 포함 */

      let status;
      if (today < start) {
        status = '예정';
      } else if (today > end) {
        status = '종료';
      } else {
        status = '진행중';
      }

      /* D-day 계산 */
      let dday;
      if (status === '진행중') {
        const diff = Math.ceil((end - today) / (1000 * 60 * 60 * 24));
        dday = `D-${diff}`;
      } else if (status === '예정') {
        const diff = Math.ceil((start - today) / (1000 * 60 * 60 * 24));
        dday = `시작까지 D-${diff}`;
      } else {
        dday = '종료';
      }

      return { ...event, status, dday };
    });

    res.json(eventsWithStatus);
  } catch (error) {
    console.error('이벤트 목록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 이벤트 상세 조회 ── */
/* GET /api/events/:eventNum */
router.get('/:eventNum', async (req, res) => {
  try {
    const { eventNum } = req.params;
    const [rows] = await pool.query(`
      SELECT e.*, u.NICKNAME AS author
      FROM EVENT e
      JOIN USER u ON u.USER_NUM = e.USER_NUM
      WHERE e.EVENT_NUM = ?
    `, [eventNum]);

    if (rows.length === 0) {
      return res.status(404).json({ message: '이벤트를 찾을 수 없습니다.' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('이벤트 상세 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 3) 이벤트 등록 ── */
/* POST /api/events */
router.post('/', async (req, res) => {
  try {
    const { userNum, title, description, image, startDate, endDate, reward } = req.body;
    const [result] = await pool.query(
      'INSERT INTO EVENT (USER_NUM, TITLE, DESCRIPTION, IMAGE, START_DATE, END_DATE, REWARD) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userNum, title, description || null, image || null, startDate, endDate, reward || null]
    );
    res.status(201).json({ message: '이벤트가 등록되었습니다.', eventNum: result.insertId });
  } catch (error) {
    console.error('이벤트 등록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 4) 이벤트 삭제 ── */
/* DELETE /api/events/:eventNum */
router.delete('/:eventNum', async (req, res) => {
  try {
    const { eventNum } = req.params;
    const [result] = await pool.query('DELETE FROM EVENT WHERE EVENT_NUM = ?', [eventNum]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '이벤트를 찾을 수 없습니다.' });
    }

    res.json({ message: '이벤트가 삭제되었습니다.' });
  } catch (error) {
    console.error('이벤트 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
