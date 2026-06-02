/* ===================================================
   코스(Course) API 라우터
   - 코스 CRUD (만들기, 조회, 수정, 삭제)
   - 코스 좋아요 / 스크랩
   - COURSES, COURSE_PLACE, COURSE_LIKE, COURSE_SCRAP 테이블 사용
   =================================================== */

const express = require('express');
const pool = require('../db');
const multer = require('multer');  /* 파일 업로드 도구 */
const { uploadToFirebase } = require('../firebase'); /* Firebase 이미지 업로드 */
const jwt = require('jsonwebtoken');
const router = express.Router();

/* --- 이미지 업로드 설정 --- */
/* 메모리에 파일을 임시 저장 후 Firebase Storage에 업로드 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); /* 최대 5MB */

/* --- JWT 인증 미들웨어 --- */
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

/* ── 1) 코스 목록 조회 ── */
/* GET /api/courses */
/* 정렬: ?sort=latest(최신) / popular(인기) / scrap(스크랩 많은 순) */
/* 필터: ?region=마포구 (지역별 필터) */
router.get('/', async (req, res) => {
  try {
    const { sort = 'latest', region, userNum } = req.query;

    /* 기본 쿼리: 코스 목록 + 작성자 닉네임 + 좋아요/스크랩 수 */
    let query = `
      SELECT
        c.COURSE_NUM, c.TITLE, c.SUBTITLE, c.CONTENT, c.CREATED_TIME, c.COVER_IMAGE,
        u.NICKNAME AS author,
        u.USER_NUM AS authorNum,
        u.PROFILE_IMAGE AS authorImage,
        (SELECT COUNT(*) FROM COURSE_LIKE cl WHERE cl.COURSE_NUM = c.COURSE_NUM) AS likeCount,
        (SELECT COUNT(*) FROM COURSE_SCRAP cs WHERE cs.COURSE_NUM = c.COURSE_NUM) AS scrapCount,
        (SELECT pi.IMAGE_URL FROM COURSE_PLACE cp
         JOIN PLACE_IMAGE pi ON pi.PLACE_NUM = cp.PLACE_NUM
         WHERE cp.COURSE_NUM = c.COURSE_NUM AND cp.IS_THUMBNAIL = 1
         LIMIT 1) AS thumbnailImage
      FROM COURSES c
      JOIN USER u ON u.USER_NUM = c.USER_NUM
    `;

    const conditions = [];
    const params = [];

    /* 특정 작성자 필터가 없으면 AI 코스 제외 */
    if (!userNum) conditions.push('c.IS_AI = 0');

    if (region) {
      conditions.push(`c.COURSE_NUM IN (
        SELECT cp.COURSE_NUM FROM COURSE_PLACE cp
        JOIN PLACES p ON p.PLACE_NUM = cp.PLACE_NUM
        WHERE p.ADDRESS LIKE ?
      )`);
      params.push(`%${region}%`);
    }

    if (userNum) {
      conditions.push('c.USER_NUM = ?');
      params.push(userNum);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    /* 정렬 */
    if (sort === 'popular') {
      query += ' ORDER BY c.VIEW_COUNT DESC, c.CREATED_TIME DESC';
    } else if (sort === 'scrap') {
      query += ' ORDER BY scrapCount DESC, c.CREATED_TIME DESC';
    } else {
      query += ' ORDER BY c.CREATED_TIME DESC';
    }

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('코스 목록 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 11) 코스 커버 이미지 업로드 ── */
/* POST /api/courses/upload-image */
/* 이미지 파일 1개를 Firebase Storage에 저장하고 URL을 돌려줌 */
router.post('/upload-image', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: '이미지 파일이 없습니다.' });
    /* Firebase Storage에 업로드 */
    const fileName = `courses/course_${Date.now()}_${Math.round(Math.random() * 1000)}${require('path').extname(req.file.originalname)}`;
    const imageUrl = await uploadToFirebase(req.file.buffer, fileName, req.file.mimetype);
    res.json({ message: '이미지 업로드 성공', imageUrl });
  } catch (error) {
    console.error('이미지 업로드 에러:', error);
    res.status(500).json({ message: '이미지 업로드에 실패했습니다.' });
  }
});

/* ── 8) 임시저장 하기 ── */
/* POST /api/courses/draft */
/* 코스 작성 중 임시저장 (제목, 설명, 태그, 장소, 코멘트를 JSON으로 저장) */
router.post('/draft', authMiddleware, async (req, res) => {
  try {
    const userNum = req.user.userNum;
    const { draftNum, title, description, tags, places, placeComments, coverImages } = req.body;
    console.log('=== 임시저장 요청 ===');
    console.log('coverImages 받은 값:', coverImages);
    console.log('req.body 전체 키:', Object.keys(req.body));
    if (!userNum) return res.status(400).json({ message: '로그인이 필요합니다.' });

    const jsonTags = JSON.stringify(tags || []);
    const jsonPlaces = JSON.stringify(places || []);
    const jsonComments = JSON.stringify(placeComments || {});
    const jsonImages = JSON.stringify(coverImages || []);

    /* draftNum이 없어도 유저의 기존 임시저장이 있으면 그걸 수정 (중복 방지) */
    let targetDraftNum = draftNum || null;
    if (!targetDraftNum) {
      const [existing] = await pool.query(
        'SELECT DRAFT_NUM FROM DRAFT_COURSE WHERE USER_NUM = ? ORDER BY DRAFT_NUM DESC LIMIT 1',
        [userNum]
      );
      if (existing.length > 0) targetDraftNum = existing[0].DRAFT_NUM;
    }

    if (targetDraftNum) {
      /* 기존 임시저장 수정 */
      await pool.query(
        'UPDATE DRAFT_COURSE SET TITLE = ?, DESCRIPTION = ?, TAGS = ?, PLACES = ?, PLACE_COMMENTS = ?, COVER_IMAGES = ? WHERE DRAFT_NUM = ? AND USER_NUM = ?',
        [title || '', description || '', jsonTags, jsonPlaces, jsonComments, jsonImages, targetDraftNum, userNum]
      );
      res.json({ message: '임시저장이 수정되었습니다.', draftNum: targetDraftNum });
    } else {
      /* 임시저장이 하나도 없을 때만 새로 생성 */
      const [result] = await pool.query(
        'INSERT INTO DRAFT_COURSE (USER_NUM, TITLE, DESCRIPTION, TAGS, PLACES, PLACE_COMMENTS, COVER_IMAGES) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userNum, title || '', description || '', jsonTags, jsonPlaces, jsonComments, jsonImages]
      );
      res.status(201).json({ message: '임시저장되었습니다.', draftNum: result.insertId });
    }
  } catch (error) {
    console.error('임시저장 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 9) 내 임시저장 목록 조회 ── */
/* GET /api/courses/drafts/:userNum */
/* ⚠️ 이 라우트는 반드시 /:courseNum 위에 있어야 함 (안 그러면 "drafts"가 courseNum으로 매칭됨) */
router.get('/drafts/:userNum', authMiddleware, async (req, res) => {
  try {
    const { userNum } = req.params;

    if (Number(userNum) !== Number(req.user.userNum)) {
      return res.status(403).json({ message: '본인 임시저장만 조회할 수 있습니다.' });
    }

    const [rows] = await pool.query(
      'SELECT * FROM DRAFT_COURSE WHERE USER_NUM = ? ORDER BY UPDATED_TIME DESC',
      [userNum]
    );
    res.json(rows);
  } catch (error) {
    console.error('임시저장 목록 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 10-1) 임시저장 수정 ── */
/* PUT /api/courses/draft/:draftNum */
/* 기존 임시저장을 덮어쓰기 (중복 생성 방지) */
router.put('/draft/:draftNum', authMiddleware, async (req, res) => {
  try {
    const { draftNum } = req.params;
    const userNum = req.user.userNum;
    const { title, description, tags, places, placeComments, coverImages } = req.body;

    const [existing] = await pool.query(
      'SELECT USER_NUM FROM DRAFT_COURSE WHERE DRAFT_NUM = ?',
      [draftNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '임시저장을 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      return res.status(403).json({ message: '본인 임시저장만 수정할 수 있습니다.' });
    }

    await pool.query(
      'UPDATE DRAFT_COURSE SET TITLE = ?, DESCRIPTION = ?, TAGS = ?, PLACES = ?, PLACE_COMMENTS = ?, COVER_IMAGES = ? WHERE DRAFT_NUM = ?',
      [title || '', description || '', JSON.stringify(tags || []), JSON.stringify(places || []), JSON.stringify(placeComments || {}), JSON.stringify(coverImages || []), draftNum]
    );

    res.json({ message: '임시저장이 수정되었습니다.' });
  } catch (error) {
    console.error('임시저장 수정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 10) 임시저장 삭제 ── */
/* DELETE /api/courses/draft/:draftNum */
router.delete('/draft/:draftNum', authMiddleware, async (req, res) => {
  try {
    const { draftNum } = req.params;
    const userNum = req.user.userNum;

    const [existing] = await pool.query(
      'SELECT USER_NUM FROM DRAFT_COURSE WHERE DRAFT_NUM = ?',
      [draftNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '임시저장을 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      return res.status(403).json({ message: '본인 임시저장만 삭제할 수 있습니다.' });
    }

    await pool.query('DELETE FROM DRAFT_COURSE WHERE DRAFT_NUM = ?', [draftNum]);
    res.json({ message: '임시저장이 삭제되었습니다.' });
  } catch (error) {
    console.error('임시저장 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 코스 상세 조회 ── */
/* GET /api/courses/:courseNum */
router.get('/:courseNum', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const userNum = req.query.userNum || null;

    /* 조회수 증가 */
    await pool.query('UPDATE COURSES SET VIEW_COUNT = VIEW_COUNT + 1 WHERE COURSE_NUM = ?', [courseNum]);

    /* 코스 기본 정보 */
    const [courses] = await pool.query(`
      SELECT
        c.*, u.NICKNAME AS author, u.PROFILE_IMAGE AS authorImage,
        (SELECT COUNT(*) FROM COURSE_LIKE cl WHERE cl.COURSE_NUM = c.COURSE_NUM) AS likeCount,
        (SELECT COUNT(*) FROM COURSE_SCRAP cs WHERE cs.COURSE_NUM = c.COURSE_NUM) AS scrapCount
      FROM COURSES c
      JOIN USER u ON u.USER_NUM = c.USER_NUM
      WHERE c.COURSE_NUM = ?
    `, [courseNum]);

    if (courses.length === 0) {
      return res.status(404).json({ message: '코스를 찾을 수 없습니다.' });
    }

    /* 코스에 포함된 장소 목록 (순서대로, 메뉴·평점 포함) */
    const [places] = await pool.query(`
      SELECT
        cp.PLACE_ORDER, cp.MEMO, cp.IS_THUMBNAIL,
        p.PLACE_NUM, p.PLACE_NAME, p.ADDRESS, p.LATITUDE, p.LONGITUDE,
        (SELECT GROUP_CONCAT(pi.IMAGE_URL) FROM PLACE_IMAGE pi WHERE pi.PLACE_NUM = p.PLACE_NUM) AS images,
        (SELECT GROUP_CONCAT(pm.MENU_NAME ORDER BY pm.MENU_NUM SEPARATOR ', ')
         FROM PLACE_MENU pm WHERE pm.PLACE_NUM = p.PLACE_NUM) AS menuTags,
        (SELECT ROUND(AVG(pr.RATING), 1)
         FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS avgRating,
        (SELECT COUNT(*)
         FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS reviewCount
      FROM COURSE_PLACE cp
      JOIN PLACES p ON p.PLACE_NUM = cp.PLACE_NUM
      WHERE cp.COURSE_NUM = ?
      ORDER BY cp.PLACE_ORDER ASC
    `, [courseNum]);

    let isLiked = false;
    let isScrapped = false;
    if (userNum) {
      const [likeRows] = await pool.query('SELECT 1 FROM COURSE_LIKE WHERE COURSE_NUM = ? AND USER_NUM = ?', [courseNum, userNum]);
      const [scrapRows] = await pool.query('SELECT 1 FROM COURSE_SCRAP WHERE COURSE_NUM = ? AND USER_NUM = ?', [courseNum, userNum]);
      isLiked = likeRows.length > 0;
      isScrapped = scrapRows.length > 0;
    }

    res.json({
      ...courses[0],
      places: places,
      isLiked,
      isScrapped,
    });
  } catch (error) {
    console.error('코스 상세 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 3) 코스 만들기 ── */
/* POST /api/courses */
/* body: { userNum, title, subtitle, content, places: [{ placeNum, order, memo, isThumbnail }] } */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userNum = req.user.userNum;
    const { title, subtitle, content, places, coverImage, coverImages, tags } = req.body;

    if (!userNum || !title || !subtitle) {
      return res.status(400).json({ message: '필수 항목을 입력해주세요.' });
    }

    const [result] = await pool.query(
      'INSERT INTO COURSES (USER_NUM, TITLE, SUBTITLE, CONTENT, COVER_IMAGE, COVER_IMAGES, TAGS) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userNum, title, subtitle, content || null, coverImage || null, JSON.stringify(coverImages || []), JSON.stringify(tags || [])]
    );

    const courseNum = result.insertId;

    /* 코스에 장소 추가 */
    if (places && places.length > 0) {
      const placeValues = places.map(p => [
        p.order, courseNum, p.placeNum, p.memo || null, p.isThumbnail ? 1 : 0
      ]);
      await pool.query(
        'INSERT INTO COURSE_PLACE (PLACE_ORDER, COURSE_NUM, PLACE_NUM, MEMO, IS_THUMBNAIL) VALUES ?',
        [placeValues]
      );
    }

    res.status(201).json({ message: '코스가 생성되었습니다.', courseNum });
  } catch (error) {
    console.error('코스 만들기 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 4) 코스 수정 ── */
/* PUT /api/courses/:courseNum */
router.put('/:courseNum', authMiddleware, async (req, res) => {
  try {
    const { courseNum } = req.params;
    const userNum = req.user.userNum;
    const { title, subtitle, content, places, coverImage, coverImages, tags } = req.body;

    const [courseRows] = await pool.query(
      'SELECT USER_NUM FROM COURSES WHERE COURSE_NUM = ?',
      [courseNum]
    );

    if (courseRows.length === 0) {
      return res.status(404).json({ message: '코스를 찾을 수 없습니다.' });
    }

    if (Number(courseRows[0].USER_NUM) !== Number(userNum)) {
      return res.status(403).json({ message: '본인이 만든 코스만 수정할 수 있습니다.' });
    }

    await pool.query(
      'UPDATE COURSES SET TITLE = COALESCE(?, TITLE), SUBTITLE = COALESCE(?, SUBTITLE), CONTENT = COALESCE(?, CONTENT), COVER_IMAGE = COALESCE(?, COVER_IMAGE), COVER_IMAGES = COALESCE(?, COVER_IMAGES), TAGS = COALESCE(?, TAGS) WHERE COURSE_NUM = ?',
      [title, subtitle, content, coverImage, coverImages ? JSON.stringify(coverImages) : null, tags ? JSON.stringify(tags) : null, courseNum]
    );

    /* 장소 정보 변경 (기존 삭제 후 다시 추가) */
    if (places) {
      await pool.query('DELETE FROM COURSE_PLACE WHERE COURSE_NUM = ?', [courseNum]);
      if (places.length > 0) {
        const placeValues = places.map(p => [
          p.order, courseNum, p.placeNum, p.memo || null, p.isThumbnail ? 1 : 0
        ]);
        await pool.query(
          'INSERT INTO COURSE_PLACE (PLACE_ORDER, COURSE_NUM, PLACE_NUM, MEMO, IS_THUMBNAIL) VALUES ?',
          [placeValues]
        );
      }
    }

    res.json({ message: '코스가 수정되었습니다.' });
  } catch (error) {
    console.error('코스 수정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 5) 코스 삭제 ── */
/* DELETE /api/courses/:courseNum */
router.delete('/:courseNum', authMiddleware, async (req, res) => {
  try {
    const { courseNum } = req.params;
    const userNum = req.user.userNum;

    const [courseRows] = await pool.query(
      'SELECT USER_NUM FROM COURSES WHERE COURSE_NUM = ?',
      [courseNum]
    );

    if (courseRows.length === 0) {
      return res.status(404).json({ message: '코스를 찾을 수 없습니다.' });
    }

    const isAdmin = req.user.grade === 'admin' || req.user.grade === 1 || req.user.grade === '1';
    if (Number(courseRows[0].USER_NUM) !== Number(userNum) && !isAdmin) {
      return res.status(403).json({ message: '본인이 만든 코스만 삭제할 수 있습니다.' });
    }

    await pool.query('DELETE FROM COURSE_PLACE WHERE COURSE_NUM = ?', [courseNum]);
    await pool.query('DELETE FROM COURSE_LIKE WHERE COURSE_NUM = ?', [courseNum]);
    await pool.query('DELETE FROM COURSE_SCRAP WHERE COURSE_NUM = ?', [courseNum]);
    await pool.query('DELETE FROM COURSES WHERE COURSE_NUM = ?', [courseNum]);

    res.json({ message: '코스가 삭제되었습니다.' });
  } catch (error) {
    console.error('코스 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 6) 코스 좋아요 토글 ── */
/* POST /api/courses/:courseNum/like */
/* body: { userNum } */
router.post('/:courseNum/like', authMiddleware, async (req, res) => {
  try {
    const { courseNum } = req.params;
    const userNum = req.user.userNum;

    /* 이미 좋아요 했는지 확인 */
    const [existing] = await pool.query(
      'SELECT * FROM COURSE_LIKE WHERE COURSE_NUM = ? AND USER_NUM = ?',
      [courseNum, userNum]
    );

    if (existing.length > 0) {
      await pool.query('DELETE FROM COURSE_LIKE WHERE COURSE_NUM = ? AND USER_NUM = ?', [courseNum, userNum]);
    } else {
      await pool.query('INSERT INTO COURSE_LIKE (COURSE_NUM, USER_NUM) VALUES (?, ?)', [courseNum, userNum]);
    }

    const [[{ likeCount }]] = await pool.query(
      'SELECT COUNT(*) AS likeCount FROM COURSE_LIKE WHERE COURSE_NUM = ?',
      [courseNum]
    );
    res.json({ liked: existing.length === 0, likeCount });
  } catch (error) {
    console.error('좋아요 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 7) 코스 스크랩 토글 ── */
/* POST /api/courses/:courseNum/scrap */
/* body: { userNum } */
router.post('/:courseNum/scrap', authMiddleware, async (req, res) => {
  try {
    const { courseNum } = req.params;
    const userNum = req.user.userNum;

    const [existing] = await pool.query(
      'SELECT * FROM COURSE_SCRAP WHERE COURSE_NUM = ? AND USER_NUM = ?',
      [courseNum, userNum]
    );

    if (existing.length > 0) {
      await pool.query('DELETE FROM COURSE_SCRAP WHERE COURSE_NUM = ? AND USER_NUM = ?', [courseNum, userNum]);
      res.json({ message: '스크랩이 취소되었습니다.', scraped: false });
    } else {
      await pool.query('INSERT INTO COURSE_SCRAP (COURSE_NUM, USER_NUM) VALUES (?, ?)', [courseNum, userNum]);
      res.json({ message: '스크랩했습니다.', scraped: true });
    }
  } catch (error) {
    console.error('스크랩 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 8) 코스 댓글 목록 조회 ── */
router.get('/:courseNum/comments', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const [rows] = await pool.query(
      `SELECT c.*, u.NICKNAME, u.PROFILE_IMAGE
       FROM COURSE_COMMENT c
       JOIN USER u ON c.USER_NUM = u.USER_NUM
       WHERE c.COURSE_NUM = ?
       ORDER BY c.CREATED_TIME ASC`,
      [courseNum]
    );
    res.json(rows);
  } catch (error) {
    console.error('댓글 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 9) 코스 댓글 작성 ── */
router.post('/:courseNum/comments', authMiddleware, async (req, res) => {
  try {
    const { courseNum } = req.params;
    const { userNum, content, parentNum } = req.body;
    const [result] = await pool.query(
      `INSERT INTO COURSE_COMMENT (COURSE_NUM, USER_NUM, CONTENT, PARENT_NUM)
       VALUES (?, ?, ?, ?)`,
      [courseNum, userNum, content, parentNum || null]
    );
    res.json({ message: '댓글이 작성되었습니다.', commentNum: result.insertId });
  } catch (error) {
    console.error('댓글 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 10) 코스 댓글 삭제 ── */
router.delete('/:courseNum/comments/:commentNum', authMiddleware, async (req, res) => {
  try {
    const { commentNum } = req.params;
    const userNum = req.user.userNum;
    await pool.query(
      'DELETE FROM COURSE_COMMENT WHERE COMMENT_NUM = ? AND USER_NUM = ?',
      [commentNum, userNum]
    );
    res.json({ message: '댓글이 삭제되었습니다.' });
  } catch (error) {
    console.error('댓글 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;