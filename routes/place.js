/* ===================================================
   장소(Place) API 라우터
   - 장소 CRUD + 검색 (메뉴 이름으로도 검색 가능)
   - 장소 이미지, 카테고리, 리뷰
   - PLACES, PLACE_IMAGE, PLACE_CATEGORY, PLACE_REVIEW, PLACE_MENU 테이블 사용
   =================================================== */

const express = require('express');
const pool = require('../db');
const router = express.Router();

/* ── 0) 인기 메뉴 태그 목록 ── */
/* GET /api/places/tags */
/* 가장 많이 등록된 메뉴 이름을 태그로 돌려줌 (빵 종류별 대표 키워드) */
router.get('/tags', async (req, res) => {
  try {
    /* PLACE_MENU 테이블에서 메뉴 이름을 그룹핑하고, 많이 등록된 순으로 정렬 */
    const [rows] = await pool.query(`
      SELECT MENU_NAME AS name, COUNT(*) AS count
      FROM PLACE_MENU
      GROUP BY MENU_NAME
      HAVING COUNT(*) >= 2
      ORDER BY count DESC
      LIMIT 30
    `);
    res.json(rows);
  } catch (error) {
    console.error('인기 태그 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 1) 장소 목록 조회 (검색 + 필터) ── */
/* GET /api/places */
/* ?keyword=크로와상 &region=마포구 &category=베이커리 &menu=크로와상 */
router.get('/', async (req, res) => {
  try {
    const { keyword, region, category, menu } = req.query;

    let query = `
      SELECT
        p.PLACE_NUM, p.PLACE_NAME, p.ADDRESS, p.LATITUDE, p.LONGITUDE,
        (SELECT AVG(pr.RATING) FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS avgRating,
        (SELECT COUNT(*) FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS reviewCount,
        (SELECT pi.IMAGE_URL FROM PLACE_IMAGE pi WHERE pi.PLACE_NUM = p.PLACE_NUM LIMIT 1) AS thumbnailImage,
        (SELECT pc.CATEGORY_NAME FROM PLACE_CATEGORY pc WHERE pc.PLACE_NUM = p.PLACE_NUM LIMIT 1) AS categoryName,
        (SELECT pc.RIBBON_COUNT FROM PLACE_CATEGORY pc WHERE pc.PLACE_NUM = p.PLACE_NUM LIMIT 1) AS ribbonCount,
        (SELECT GROUP_CONCAT(pm.MENU_NAME ORDER BY pm.MENU_NUM SEPARATOR ',')
         FROM PLACE_MENU pm WHERE pm.PLACE_NUM = p.PLACE_NUM LIMIT 5) AS menuTags
      FROM PLACES p
      WHERE 1=1
    `;
    const params = [];

    /* 키워드 검색 (장소 이름 OR 주소 OR 메뉴 이름) */
    if (keyword) {
      query += ` AND (
        p.PLACE_NAME LIKE ? OR p.ADDRESS LIKE ?
        OR p.PLACE_NUM IN (SELECT pm.PLACE_NUM FROM PLACE_MENU pm WHERE pm.MENU_NAME LIKE ?)
      )`;
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    /* 메뉴 전용 필터 (태그 클릭 시) */
    if (menu) {
      query += ' AND p.PLACE_NUM IN (SELECT pm.PLACE_NUM FROM PLACE_MENU pm WHERE pm.MENU_NAME LIKE ?)';
      params.push(`%${menu}%`);
    }

    /* 지역 필터 */
    if (region) {
      query += ' AND p.ADDRESS LIKE ?';
      params.push(`%${region}%`);
    }

    /* 카테고리 필터 */
    if (category) {
      query += ' AND p.PLACE_NUM IN (SELECT pc.PLACE_NUM FROM PLACE_CATEGORY pc WHERE pc.CATEGORY_NAME = ?)';
      params.push(category);
    }

    query += ' ORDER BY p.PLACE_NUM DESC';

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('장소 목록 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 장소 상세 조회 ── */
/* GET /api/places/:placeNum */
router.get('/:placeNum', async (req, res) => {
  try {
    const { placeNum } = req.params;

    /* 장소 기본 정보 */
    const [places] = await pool.query(`
      SELECT
        p.*,
        (SELECT AVG(pr.RATING) FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS avgRating,
        (SELECT COUNT(*) FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) AS reviewCount
      FROM PLACES p WHERE p.PLACE_NUM = ?
    `, [placeNum]);

    if (places.length === 0) {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    /* 장소 이미지 */
    const [images] = await pool.query(
      'SELECT * FROM PLACE_IMAGE WHERE PLACE_NUM = ?', [placeNum]
    );

    /* 장소 카테고리 */
    const [categories] = await pool.query(
      'SELECT * FROM PLACE_CATEGORY WHERE PLACE_NUM = ?', [placeNum]
    );

    /* 장소 리뷰 (최신순, 최대 20개) */
    const [reviews] = await pool.query(`
      SELECT pr.*, u.NICKNAME, u.PROFILE_IMAGE
      FROM PLACE_REVIEW pr
      JOIN USER u ON u.USER_NUM = pr.USER_NUM
      WHERE pr.PLACE_NUM = ?
      ORDER BY pr.CREATED_TIME DESC
      LIMIT 20
    `, [placeNum]);

    /* 이 장소가 포함된 코스 목록 */
    const [courses] = await pool.query(`
      SELECT c.COURSE_NUM, c.TITLE, c.SUBTITLE
      FROM COURSES c
      JOIN COURSE_PLACE cp ON cp.COURSE_NUM = c.COURSE_NUM
      WHERE cp.PLACE_NUM = ?
    `, [placeNum]);

    /* 장소 메뉴 목록 (PLACE_MENU 테이블) */
    const [menus] = await pool.query(
      'SELECT * FROM PLACE_MENU WHERE PLACE_NUM = ? ORDER BY MENU_NUM', [placeNum]
    );

    res.json({
      ...places[0],
      images,
      categories,
      reviews,
      courses,
      menus,
    });
  } catch (error) {
    console.error('장소 상세 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 3) 장소 등록 ── */
/* POST /api/places */
router.post('/', async (req, res) => {
  try {
    const { placeName, address, latitude, longitude, images, categories } = req.body;

    if (!placeName) {
      return res.status(400).json({ message: '장소 이름을 입력해주세요.' });
    }

    /* 장소 기본 정보 저장 */
    const [result] = await pool.query(
      'INSERT INTO PLACES (PLACE_NAME, ADDRESS, LATITUDE, LONGITUDE) VALUES (?, ?, ?, ?)',
      [placeName, address || null, latitude || null, longitude || null]
    );

    const placeNum = result.insertId;

    /* 이미지 저장 */
    if (images && images.length > 0) {
      const imageValues = images.map(url => [placeNum, url]);
      await pool.query('INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES ?', [imageValues]);
    }

    /* 카테고리 저장 */
    if (categories && categories.length > 0) {
      const catValues = categories.map(name => [placeNum, name]);
      await pool.query('INSERT INTO PLACE_CATEGORY (PLACE_NUM, CATEGORY_NAME) VALUES ?', [catValues]);
    }

    res.status(201).json({ message: '장소가 등록되었습니다.', placeNum });
  } catch (error) {
    console.error('장소 등록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 4) 리뷰 작성 ── */
/* POST /api/places/:placeNum/reviews */
router.post('/:placeNum/reviews', async (req, res) => {
  try {
    const { placeNum } = req.params;
    const { userNum, rating, content } = req.body;

    if (!userNum) {
      return res.status(400).json({ message: '로그인이 필요합니다.' });
    }

    const [result] = await pool.query(
      'INSERT INTO PLACE_REVIEW (PLACE_NUM, USER_NUM, RATING, CONTENT) VALUES (?, ?, ?, ?)',
      [placeNum, userNum, rating || null, content || null]
    );

    res.status(201).json({ message: '리뷰가 작성되었습니다.', reviewNum: result.insertId });
  } catch (error) {
    console.error('리뷰 작성 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 5) 리뷰 삭제 ── */
/* DELETE /api/places/:placeNum/reviews/:reviewNum */
router.delete('/:placeNum/reviews/:reviewNum', async (req, res) => {
  try {
    const { reviewNum } = req.params;
    await pool.query('DELETE FROM PLACE_REVIEW WHERE REVIEW_NUM = ?', [reviewNum]);
    res.json({ message: '리뷰가 삭제되었습니다.' });
  } catch (error) {
    console.error('리뷰 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
