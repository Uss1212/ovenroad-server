/* ===================================================
   커뮤니티 게시판 API 라우터
   - 게시글 CRUD (목록 조회, 상세 조회, 작성, 수정, 삭제)
   - 좋아요 토글
   - 댓글 CRUD
   =================================================== */

const express = require('express');
const router = express.Router();
const pool = require('../db'); /* MySQL 연결 풀 */

/* ── 1) 게시글 목록 조회 ── */
/* GET /api/board */
/* 커뮤니티 페이지에서 게시글 목록을 가져옴 */
/* ?category=자유 → 특정 카테고리만 필터링 */
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;

    /* 게시글 목록 쿼리 */
    /* 작성자 닉네임, 좋아요 수, 댓글 수도 함께 가져옴 */
    let sql = `
      SELECT
        b.BOARD_NUM,
        b.CATEGORY,
        b.TITLE,
        b.CONTENT,
        b.VIEWS,
        b.CREATED_TIME,
        u.NICKNAME AS author,
        u.PROFILE_IMAGE AS authorImage,
        (SELECT COUNT(*) FROM BOARD_LIKE bl WHERE bl.BOARD_NUM = b.BOARD_NUM) AS likes,
        (SELECT COUNT(*) FROM BOARD_COMMENT bc WHERE bc.BOARD_NUM = b.BOARD_NUM) AS comments,
        (SELECT bi.IMAGE_URL FROM BOARD_IMAGE bi WHERE bi.BOARD_NUM = b.BOARD_NUM LIMIT 1) AS thumbnail
      FROM BOARD b
      JOIN USER u ON b.USER_NUM = u.USER_NUM
    `;

    const params = [];
    /* WHERE 조건들을 모아두는 배열 */
    const conditions = [];

    /* 카테고리 필터가 있으면 조건 추가 */
    if (category && category !== '전체') {
      conditions.push('b.CATEGORY = ?');
      params.push(category);
    }

    /* 검색어가 있으면 제목 또는 내용에서 검색 */
    if (search && search.trim()) {
      conditions.push('(b.TITLE LIKE ? OR b.CONTENT LIKE ?)');
      const keyword = `%${search.trim()}%`;
      params.push(keyword, keyword);
    }

    /* 조건이 있으면 WHERE 절 추가 */
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    /* 최신 글이 위로 오도록 정렬 */
    sql += ' ORDER BY b.CREATED_TIME DESC';

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error('게시글 목록 조회 에러:', error);
    res.status(500).json({ message: '게시글 목록을 불러오지 못했습니다.' });
  }
});

/* ── 2) 인기 게시글 조회 ── */
/* GET /api/board/popular */
/* 좋아요 많은 순으로 상위 5개 */
router.get('/popular', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        b.BOARD_NUM,
        b.TITLE,
        (SELECT COUNT(*) FROM BOARD_LIKE bl WHERE bl.BOARD_NUM = b.BOARD_NUM) AS likes
      FROM BOARD b
      ORDER BY likes DESC
      LIMIT 5
    `);
    res.json(rows);
  } catch (error) {
    console.error('인기 게시글 조회 에러:', error);
    res.status(500).json({ message: '인기 게시글을 불러오지 못했습니다.' });
  }
});

/* ── 3) 게시글 상세 조회 ── */
/* GET /api/board/:id */
/* 게시글 하나의 상세 내용을 가져옴 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    /* 조회수 1 증가 */
    await pool.query('UPDATE BOARD SET VIEWS = VIEWS + 1 WHERE BOARD_NUM = ?', [id]);

    /* 게시글 정보 가져오기 */
    const [rows] = await pool.query(`
      SELECT
        b.BOARD_NUM,
        b.USER_NUM,
        b.CATEGORY,
        b.TITLE,
        b.CONTENT,
        b.VIEWS,
        b.CREATED_TIME,
        u.NICKNAME AS author,
        u.PROFILE_IMAGE AS authorImage,
        (SELECT COUNT(*) FROM BOARD_LIKE bl WHERE bl.BOARD_NUM = b.BOARD_NUM) AS likes
      FROM BOARD b
      JOIN USER u ON b.USER_NUM = u.USER_NUM
      WHERE b.BOARD_NUM = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    }

    /* 게시글에 첨부된 이미지 가져오기 */
    const [images] = await pool.query(
      'SELECT IMAGE_URL FROM BOARD_IMAGE WHERE BOARD_NUM = ?', [id]
    );

    /* 댓글 가져오기 */
    const [comments] = await pool.query(`
      SELECT
        bc.COMMENT_NUM,
        bc.CONTENT,
        bc.CREATED_TIME,
        bc.USER_NUM,
        u.NICKNAME AS author,
        u.PROFILE_IMAGE AS authorImage
      FROM BOARD_COMMENT bc
      JOIN USER u ON bc.USER_NUM = u.USER_NUM
      WHERE bc.BOARD_NUM = ?
      ORDER BY bc.CREATED_TIME ASC
    `, [id]);

    /* 게시글 + 이미지 + 댓글을 합쳐서 보내줌 */
    res.json({
      ...rows[0],
      images: images.map(img => img.IMAGE_URL),
      comments,
    });
  } catch (error) {
    console.error('게시글 상세 조회 에러:', error);
    res.status(500).json({ message: '게시글을 불러오지 못했습니다.' });
  }
});

/* ── 4) 게시글 작성 ── */
/* POST /api/board */
/* 새 글을 DB에 저장 */
router.post('/', async (req, res) => {
  try {
    const { userNum, category, title, content, images } = req.body;

    /* 필수 항목 확인 */
    if (!userNum || !category || !title || !content) {
      return res.status(400).json({ message: '필수 항목을 모두 입력해주세요.' });
    }

    /* 게시글 저장 */
    const [result] = await pool.query(
      'INSERT INTO BOARD (USER_NUM, CATEGORY, TITLE, CONTENT) VALUES (?, ?, ?, ?)',
      [userNum, category, title, content]
    );

    const boardNum = result.insertId;

    /* 이미지 URL이 있으면 BOARD_IMAGE 테이블에 저장 */
    if (images && images.length > 0) {
      const imageValues = images.map(url => [boardNum, url]);
      await pool.query(
        'INSERT INTO BOARD_IMAGE (BOARD_NUM, IMAGE_URL) VALUES ?',
        [imageValues]
      );
    }

    res.json({
      message: '글이 등록되었습니다!',
      boardNum: boardNum,
    });
  } catch (error) {
    console.error('게시글 작성 에러:', error);
    res.status(500).json({ message: '글 등록에 실패했습니다.' });
  }
});

/* ── 5) 게시글 수정 ── */
/* PUT /api/board/:id */
/* 본인이 쓴 글의 제목, 내용, 카테고리, 이미지를 수정 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userNum, category, title, content, images } = req.body;

    /* 본인이 쓴 글인지 확인 */
    const [check] = await pool.query('SELECT USER_NUM FROM BOARD WHERE BOARD_NUM = ?', [id]);
    if (check.length === 0) {
      return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    }
    if (check[0].USER_NUM !== userNum) {
      return res.status(403).json({ message: '본인이 작성한 글만 수정할 수 있습니다.' });
    }

    /* 게시글 내용 수정 */
    await pool.query(
      'UPDATE BOARD SET CATEGORY = ?, TITLE = ?, CONTENT = ? WHERE BOARD_NUM = ?',
      [category, title, content, id]
    );

    /* 기존 이미지 삭제 후 새 이미지 등록 */
    await pool.query('DELETE FROM BOARD_IMAGE WHERE BOARD_NUM = ?', [id]);
    if (images && images.length > 0) {
      const imageValues = images.map(url => [id, url]);
      await pool.query(
        'INSERT INTO BOARD_IMAGE (BOARD_NUM, IMAGE_URL) VALUES ?',
        [imageValues]
      );
    }

    res.json({ message: '글이 수정되었습니다!' });
  } catch (error) {
    console.error('게시글 수정 에러:', error);
    res.status(500).json({ message: '글 수정에 실패했습니다.' });
  }
});

/* ── 6) 게시글 삭제 ── */
/* DELETE /api/board/:id */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userNum } = req.body;

    /* 본인이 쓴 글인지 확인 */
    const [check] = await pool.query('SELECT USER_NUM FROM BOARD WHERE BOARD_NUM = ?', [id]);
    if (check.length === 0) {
      return res.status(404).json({ message: '게시글을 찾을 수 없습니다.' });
    }
    if (check[0].USER_NUM !== userNum) {
      return res.status(403).json({ message: '본인이 작성한 글만 삭제할 수 있습니다.' });
    }

    /* 관련 데이터 삭제 (댓글, 좋아요, 이미지, 게시글 순서) */
    await pool.query('DELETE FROM BOARD_COMMENT WHERE BOARD_NUM = ?', [id]);
    await pool.query('DELETE FROM BOARD_LIKE WHERE BOARD_NUM = ?', [id]);
    await pool.query('DELETE FROM BOARD_IMAGE WHERE BOARD_NUM = ?', [id]);
    await pool.query('DELETE FROM BOARD WHERE BOARD_NUM = ?', [id]);

    res.json({ message: '글이 삭제되었습니다.' });
  } catch (error) {
    console.error('게시글 삭제 에러:', error);
    res.status(500).json({ message: '글 삭제에 실패했습니다.' });
  }
});

/* ── 6) 좋아요 토글 ── */
/* POST /api/board/:id/like */
/* 좋아요가 없으면 추가, 있으면 취소 */
router.post('/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const { userNum } = req.body;

    /* 이미 좋아요 했는지 확인 */
    const [existing] = await pool.query(
      'SELECT * FROM BOARD_LIKE WHERE BOARD_NUM = ? AND USER_NUM = ?',
      [id, userNum]
    );

    if (existing.length > 0) {
      /* 이미 좋아요 → 취소 */
      await pool.query('DELETE FROM BOARD_LIKE WHERE BOARD_NUM = ? AND USER_NUM = ?', [id, userNum]);
    } else {
      /* 좋아요 추가 */
      await pool.query('INSERT INTO BOARD_LIKE (BOARD_NUM, USER_NUM) VALUES (?, ?)', [id, userNum]);
    }

    /* 현재 좋아요 수 반환 */
    const [count] = await pool.query('SELECT COUNT(*) AS likes FROM BOARD_LIKE WHERE BOARD_NUM = ?', [id]);
    res.json({ likes: count[0].likes, liked: existing.length === 0 });
  } catch (error) {
    console.error('좋아요 토글 에러:', error);
    res.status(500).json({ message: '좋아요 처리에 실패했습니다.' });
  }
});

/* ── 7) 댓글 작성 ── */
/* POST /api/board/:id/comments */
router.post('/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;
    const { userNum, content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: '댓글 내용을 입력해주세요.' });
    }

    const [result] = await pool.query(
      'INSERT INTO BOARD_COMMENT (BOARD_NUM, USER_NUM, CONTENT) VALUES (?, ?, ?)',
      [id, userNum, content]
    );

    /* 방금 작성한 댓글 정보 반환 */
    const [newComment] = await pool.query(`
      SELECT
        bc.COMMENT_NUM,
        bc.CONTENT,
        bc.CREATED_TIME,
        bc.USER_NUM,
        u.NICKNAME AS author,
        u.PROFILE_IMAGE AS authorImage
      FROM BOARD_COMMENT bc
      JOIN USER u ON bc.USER_NUM = u.USER_NUM
      WHERE bc.COMMENT_NUM = ?
    `, [result.insertId]);

    res.json(newComment[0]);
  } catch (error) {
    console.error('댓글 작성 에러:', error);
    res.status(500).json({ message: '댓글 등록에 실패했습니다.' });
  }
});

/* ── 8) 댓글 삭제 ── */
/* DELETE /api/board/:id/comments/:commentId */
router.delete('/:id/comments/:commentId', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { userNum } = req.body;

    /* 본인 댓글인지 확인 */
    const [check] = await pool.query('SELECT USER_NUM FROM BOARD_COMMENT WHERE COMMENT_NUM = ?', [commentId]);
    if (check.length === 0) {
      return res.status(404).json({ message: '댓글을 찾을 수 없습니다.' });
    }
    if (check[0].USER_NUM !== userNum) {
      return res.status(403).json({ message: '본인이 작성한 댓글만 삭제할 수 있습니다.' });
    }

    await pool.query('DELETE FROM BOARD_COMMENT WHERE COMMENT_NUM = ?', [commentId]);
    res.json({ message: '댓글이 삭제되었습니다.' });
  } catch (error) {
    console.error('댓글 삭제 에러:', error);
    res.status(500).json({ message: '댓글 삭제에 실패했습니다.' });
  }
});

module.exports = router;
