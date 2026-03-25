/* ===================================================
   코스(Course) API 라우터
   - 코스 CRUD (만들기, 조회, 수정, 삭제)
   - 코스 좋아요 / 스크랩
   - COURSES, COURSE_PLACE, COURSE_LIKE, COURSE_SCRAP 테이블 사용
   =================================================== */

const express = require('express');
const pool = require('../db');
const multer = require('multer');  /* 파일 업로드 도구 */
const path = require('path');
const router = express.Router();

/* --- 이미지 업로드 설정 --- */
/* uploads 폴더에 파일을 저장, 파일명은 날짜+랜덤숫자로 중복 방지 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `course_${Date.now()}_${Math.round(Math.random() * 1000)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); /* 최대 5MB */

/* ── 1) 코스 목록 조회 ── */
/* GET /api/courses */
/* 정렬: ?sort=latest(최신) / popular(인기) / scrap(스크랩 많은 순) */
/* 필터: ?region=마포구 (지역별 필터) */
router.get('/', async (req, res) => {
  try {
    const { sort = 'latest', region } = req.query;

    /* 기본 쿼리: 코스 목록 + 작성자 닉네임 + 좋아요/스크랩 수 */
    let query = `
      SELECT
        c.COURSE_NUM, c.TITLE, c.SUBTITLE, c.CONTENT, c.CREATED_TIME, c.COVER_IMAGE,
        u.NICKNAME AS author,
        u.USER_NUM AS authorNum,
        (SELECT COUNT(*) FROM COURSE_LIKE cl WHERE cl.COURSE_NUM = c.COURSE_NUM) AS likeCount,
        (SELECT COUNT(*) FROM COURSE_SCRAP cs WHERE cs.COURSE_NUM = c.COURSE_NUM) AS scrapCount,
        (SELECT pi.IMAGE_URL FROM COURSE_PLACE cp
         JOIN PLACE_IMAGE pi ON pi.PLACE_NUM = cp.PLACE_NUM
         WHERE cp.COURSE_NUM = c.COURSE_NUM AND cp.IS_THUMBNAIL = 1
         LIMIT 1) AS thumbnailImage
      FROM COURSES c
      JOIN USER u ON u.USER_NUM = c.USER_NUM
    `;

    const params = [];

    /* 지역 필터가 있으면 해당 지역의 장소를 포함한 코스만 */
    if (region) {
      query += `
        WHERE c.COURSE_NUM IN (
          SELECT cp.COURSE_NUM FROM COURSE_PLACE cp
          JOIN PLACES p ON p.PLACE_NUM = cp.PLACE_NUM
          WHERE p.ADDRESS LIKE ?
        )
      `;
      params.push(`%${region}%`);
    }

    /* 정렬 */
    if (sort === 'popular') {
      query += ' ORDER BY likeCount DESC, c.CREATED_TIME DESC';
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
/* 이미지 파일 1개를 서버에 저장하고 URL을 돌려줌 */
router.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '이미지 파일이 없습니다.' });
  /* 저장된 파일의 접근 URL을 돌려줌 */
  const imageUrl = `/uploads/${req.file.filename}`;
  res.json({ message: '이미지 업로드 성공', imageUrl });
});

/* ── 8) 임시저장 하기 ── */
/* POST /api/courses/draft */
/* 코스 작성 중 임시저장 (제목, 설명, 태그, 장소, 코멘트를 JSON으로 저장) */
router.post('/draft', async (req, res) => {
  try {
    const { userNum, draftNum, title, description, tags, places, placeComments, coverImages } = req.body;
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
        'UPDATE DRAFT_COURSE SET TITLE = ?, DESCRIPTION = ?, TAGS = ?, PLACES = ?, PLACE_COMMENTS = ?, COVER_IMAGES = ? WHERE DRAFT_NUM = ?',
        [title || '', description || '', jsonTags, jsonPlaces, jsonComments, jsonImages, targetDraftNum]
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
router.get('/drafts/:userNum', async (req, res) => {
  try {
    const { userNum } = req.params;
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
router.put('/draft/:draftNum', async (req, res) => {
  try {
    const { draftNum } = req.params;
    const { title, description, tags, places, placeComments, coverImages } = req.body;

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
router.delete('/draft/:draftNum', async (req, res) => {
  try {
    const { draftNum } = req.params;
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

    res.json({
      ...courses[0],
      places: places,
    });
  } catch (error) {
    console.error('코스 상세 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 3) 코스 만들기 ── */
/* POST /api/courses */
/* body: { userNum, title, subtitle, content, places: [{ placeNum, order, memo, isThumbnail }] } */
router.post('/', async (req, res) => {
  try {
    const { userNum, title, subtitle, content, places, coverImage } = req.body;

    if (!userNum || !title || !subtitle) {
      return res.status(400).json({ message: '필수 항목을 입력해주세요.' });
    }

    /* 코스 저장 (커버 이미지 포함) */
    const [result] = await pool.query(
      'INSERT INTO COURSES (USER_NUM, TITLE, SUBTITLE, CONTENT, COVER_IMAGE) VALUES (?, ?, ?, ?, ?)',
      [userNum, title, subtitle, content || null, coverImage || null]
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
router.put('/:courseNum', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const { title, subtitle, content, places } = req.body;

    /* 코스 정보 수정 */
    await pool.query(
      'UPDATE COURSES SET TITLE = COALESCE(?, TITLE), SUBTITLE = COALESCE(?, SUBTITLE), CONTENT = COALESCE(?, CONTENT) WHERE COURSE_NUM = ?',
      [title, subtitle, content, courseNum]
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
router.delete('/:courseNum', async (req, res) => {
  try {
    const { courseNum } = req.params;
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
router.post('/:courseNum/like', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const { userNum } = req.body;

    /* 이미 좋아요 했는지 확인 */
    const [existing] = await pool.query(
      'SELECT * FROM COURSE_LIKE WHERE COURSE_NUM = ? AND USER_NUM = ?',
      [courseNum, userNum]
    );

    if (existing.length > 0) {
      /* 이미 좋아요 → 취소 (삭제) */
      await pool.query('DELETE FROM COURSE_LIKE WHERE COURSE_NUM = ? AND USER_NUM = ?', [courseNum, userNum]);
      res.json({ message: '좋아요가 취소되었습니다.', liked: false });
    } else {
      /* 좋아요 안 함 → 추가 */
      await pool.query('INSERT INTO COURSE_LIKE (COURSE_NUM, USER_NUM) VALUES (?, ?)', [courseNum, userNum]);
      res.json({ message: '좋아요를 눌렀습니다.', liked: true });
    }
  } catch (error) {
    console.error('좋아요 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 12) 코스 댓글 목록 조회 ── */
/* GET /api/courses/:courseNum/comments */
/* 댓글 + 답글을 모두 가져옴 (작성자 닉네임 포함) */
router.get('/:courseNum/comments', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const [rows] = await pool.query(`
      SELECT
        cc.COMMENT_NUM, cc.COURSE_NUM, cc.USER_NUM, cc.PARENT_NUM,
        cc.CONTENT, cc.CREATED_TIME,
        u.NICKNAME, u.PROFILE_IMAGE
      FROM COURSE_COMMENT cc
      JOIN USER u ON u.USER_NUM = cc.USER_NUM
      WHERE cc.COURSE_NUM = ?
      ORDER BY cc.CREATED_TIME ASC
    `, [courseNum]);
    res.json(rows);
  } catch (error) {
    console.error('댓글 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 13) 코스 댓글 작성 ── */
/* POST /api/courses/:courseNum/comments */
/* body: { userNum, content, parentNum(선택) } */
router.post('/:courseNum/comments', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const { userNum, content, parentNum } = req.body;

    if (!userNum || !content) {
      return res.status(400).json({ message: '내용을 입력해주세요.' });
    }

    const [result] = await pool.query(
      'INSERT INTO COURSE_COMMENT (COURSE_NUM, USER_NUM, PARENT_NUM, CONTENT) VALUES (?, ?, ?, ?)',
      [courseNum, userNum, parentNum || null, content]
    );

    /* 방금 작성한 댓글을 닉네임과 함께 돌려줌 */
    const [rows] = await pool.query(`
      SELECT cc.*, u.NICKNAME, u.PROFILE_IMAGE
      FROM COURSE_COMMENT cc
      JOIN USER u ON u.USER_NUM = cc.USER_NUM
      WHERE cc.COMMENT_NUM = ?
    `, [result.insertId]);

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('댓글 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 14) 코스 댓글 삭제 ── */
/* DELETE /api/courses/:courseNum/comments/:commentNum */
/* body: { userNum } */
router.delete('/:courseNum/comments/:commentNum', async (req, res) => {
  try {
    const { commentNum } = req.params;
    const { userNum } = req.body;

    /* 본인이 쓴 댓글만 삭제 가능 */
    const [existing] = await pool.query(
      'SELECT * FROM COURSE_COMMENT WHERE COMMENT_NUM = ? AND USER_NUM = ?',
      [commentNum, userNum]
    );
    if (existing.length === 0) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    /* 답글도 함께 삭제 */
    await pool.query('DELETE FROM COURSE_COMMENT WHERE COMMENT_NUM = ? OR PARENT_NUM = ?', [commentNum, commentNum]);
    res.json({ message: '댓글이 삭제되었습니다.' });
  } catch (error) {
    console.error('댓글 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 7) 코스 스크랩 토글 ── */
/* POST /api/courses/:courseNum/scrap */
/* body: { userNum } */
router.post('/:courseNum/scrap', async (req, res) => {
  try {
    const { courseNum } = req.params;
    const { userNum } = req.body;

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

module.exports = router;
