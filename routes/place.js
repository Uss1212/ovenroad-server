/* ===================================================
   장소(Place) API 라우터
   - 장소 CRUD + 검색 (메뉴 이름으로도 검색 가능)
   - 장소 이미지, 카테고리, 리뷰
   - PLACES, PLACE_IMAGE, PLACE_CATEGORY, PLACE_REVIEW, PLACE_MENU 테이블 사용
   =================================================== */

const express = require('express');
const https = require('https');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const router = express.Router();

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

function isAdmin(user) {
  if (!user) return false;
  return user.grade === 'admin' || user.grade === 1 || user.grade === '1';
}

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
router.get('/', async (req, res) => {
  try {
    const { keyword, region, category, menu, sort, limit } = req.query;

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

    if (sort === 'rating') {
      query += ' AND (SELECT COUNT(*) FROM PLACE_REVIEW pr WHERE pr.PLACE_NUM = p.PLACE_NUM) > 0';
      query += ' ORDER BY avgRating DESC, reviewCount DESC, p.PLACE_NUM DESC';
    } else {
      query += ' ORDER BY p.PLACE_NUM DESC';
    }

    const limitNum = parseInt(limit, 10);
    if (!Number.isNaN(limitNum) && limitNum > 0 && limitNum <= 100) {
      query += ` LIMIT ${limitNum}`;
    }

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('장소 목록 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 주변 베이커리 검색 (Google Places Nearby Search) ── */
/* GET /api/places/nearby-bakeries?lat=&lng=&radius= */
/* 현재 위치 기준으로 Google Maps에 등록된 베이커리를 최대 60개 가져옴 */
router.get('/nearby-bakeries', async (req, res) => {
  const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GOOGLE_KEY) return res.json([]);

  const lat    = parseFloat(req.query.lat)    || 37.5622;  /* 기본: 마포구 */
  const lng    = parseFloat(req.query.lng)    || 126.9086;
  const radius = parseInt(req.query.radius)   || 5000;     /* 기본 반경 5km */

  try {
    const results = [];
    let pageToken = null;

    /* Google Places는 한 번에 최대 20개, 페이지 토큰으로 최대 3페이지(60개)까지 가져옴 */
    for (let i = 0; i < 3; i++) {
      const url = pageToken
        ? `https://maps.googleapis.com/maps/api/place/nearbysearch/json?pagetoken=${pageToken}&key=${GOOGLE_KEY}`
        : `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=bakery&language=ko&key=${GOOGLE_KEY}`;

      const data = await httpsGet(url);
      if (data.results) results.push(...data.results);

      pageToken = data.next_page_token || null;
      if (!pageToken) break;
      /* 다음 페이지 토큰이 활성화되기까지 2초 대기 (Google API 스펙) */
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }

    res.json(results.map(p => ({
      placeId:  p.place_id,
      name:     p.name,
      address:  p.vicinity || '',
      lat:      p.geometry.location.lat,
      lng:      p.geometry.location.lng,
      rating:   p.rating || 0,
      /* 대표 사진: photo_reference를 이용해 Google Places Photo URL 생성 */
      photoUrl: p.photos && p.photos.length > 0
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${p.photos[0].photo_reference}&key=${GOOGLE_KEY}`
        : null,
    })));
  } catch (err) {
    console.error('nearby-bakeries 에러:', err);
    res.json([]);
  }
});

/* ── 3) 장소 상세 조회 ── */
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
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { placeName, address, latitude, longitude, images, categories } = req.body;

    if (!placeName) {
      return res.status(400).json({ message: '장소 이름을 입력해주세요.' });
    }

    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: '관리자만 장소를 등록할 수 있습니다.' });
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

/* ── 6) 장소 수정 ── */
/* PUT /api/places/:placeNum */
/* body: { placeName, address, latitude, longitude, images, categories } */
router.put('/:placeNum', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;
    const { placeName, address, latitude, longitude, images, categories } = req.body;

    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: '관리자만 장소를 수정할 수 있습니다.' });
    }

    const [existing] = await pool.query(
      'SELECT PLACE_NUM FROM PLACES WHERE PLACE_NUM = ?',
      [placeNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    /* 기본 정보 수정 */
    await pool.query(
      `UPDATE PLACES
       SET PLACE_NAME = COALESCE(?, PLACE_NAME),
           ADDRESS = COALESCE(?, ADDRESS),
           LATITUDE = COALESCE(?, LATITUDE),
           LONGITUDE = COALESCE(?, LONGITUDE)
       WHERE PLACE_NUM = ?`,
      [placeName ?? null, address ?? null, latitude ?? null, longitude ?? null, placeNum]
    );

    /* images가 배열로 오면 기존 이미지 전체 교체 */
    if (Array.isArray(images)) {
      await pool.query('DELETE FROM PLACE_IMAGE WHERE PLACE_NUM = ?', [placeNum]);

      if (images.length > 0) {
        const imageValues = images.map(url => [placeNum, url]);
        await pool.query(
          'INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES ?',
          [imageValues]
        );
      }
    }

    /* categories가 배열로 오면 기존 카테고리 전체 교체 */
    if (Array.isArray(categories)) {
      await pool.query('DELETE FROM PLACE_CATEGORY WHERE PLACE_NUM = ?', [placeNum]);

      if (categories.length > 0) {
        const catValues = categories.map(name => [placeNum, name]);
        await pool.query(
          'INSERT INTO PLACE_CATEGORY (PLACE_NUM, CATEGORY_NAME) VALUES ?',
          [catValues]
        );
      }
    }

    res.json({ message: '장소가 수정되었습니다.' });
  } catch (error) {
    console.error('장소 수정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 7) 장소 삭제 ── */
/* DELETE /api/places/:placeNum */
router.delete('/:placeNum', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;

    if (!isAdmin(req.user)) {
      return res.status(403).json({ message: '관리자만 장소를 삭제할 수 있습니다.' });
    }

    const [existing] = await pool.query(
      'SELECT PLACE_NUM FROM PLACES WHERE PLACE_NUM = ?',
      [placeNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    /* 연관 데이터 먼저 삭제 */
    await pool.query('DELETE FROM PLACE_REVIEW WHERE PLACE_NUM = ?', [placeNum]);
    await pool.query('DELETE FROM PLACE_IMAGE WHERE PLACE_NUM = ?', [placeNum]);
    await pool.query('DELETE FROM PLACE_CATEGORY WHERE PLACE_NUM = ?', [placeNum]);
    await pool.query('DELETE FROM PLACE_MENU WHERE PLACE_NUM = ?', [placeNum]);
    await pool.query('DELETE FROM COURSE_PLACE WHERE PLACE_NUM = ?', [placeNum]);

    /* 장소 삭제 */
    await pool.query('DELETE FROM PLACES WHERE PLACE_NUM = ?', [placeNum]);

    res.json({ message: '장소가 삭제되었습니다.' });
  } catch (error) {
    console.error('장소 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 4) 리뷰 작성 ── */
/* POST /api/places/:placeNum/reviews */
router.post('/:placeNum/reviews', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;
    const { rating, content } = req.body;
    const userNum = req.user.userNum;

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

/* ── 5-1) 리뷰 수정 ── */
/* PUT /api/places/:placeNum/reviews/:reviewNum */
/* body: { userNum, rating, content } */
router.put('/:placeNum/reviews/:reviewNum', authMiddleware, async (req, res) => {
  try {
    const { placeNum, reviewNum } = req.params;
    const { rating, content } = req.body;
    const userNum = req.user.userNum;

    if (!userNum) {
      return res.status(400).json({ message: '로그인이 필요합니다.' });
    }

    /* 본인 리뷰인지 확인 */
    const [existing] = await pool.query(
      'SELECT REVIEW_NUM, USER_NUM, PLACE_NUM FROM PLACE_REVIEW WHERE REVIEW_NUM = ?',
      [reviewNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '리뷰를 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      return res.status(403).json({ message: '본인이 작성한 리뷰만 수정할 수 있습니다.' });
    }

    if (Number(existing[0].PLACE_NUM) !== Number(placeNum)) {
      return res.status(400).json({ message: '잘못된 장소 리뷰 요청입니다.' });
    }

    await pool.query(
      `UPDATE PLACE_REVIEW
       SET RATING = COALESCE(?, RATING),
           CONTENT = COALESCE(?, CONTENT)
       WHERE REVIEW_NUM = ?`,
      [rating ?? null, content ?? null, reviewNum]
    );

    const [updated] = await pool.query(`
      SELECT pr.*, u.NICKNAME, u.PROFILE_IMAGE
      FROM PLACE_REVIEW pr
      JOIN USER u ON u.USER_NUM = pr.USER_NUM
      WHERE pr.REVIEW_NUM = ?
    `, [reviewNum]);

    res.json({
      message: '리뷰가 수정되었습니다.',
      review: updated[0],
    });
  } catch (error) {
    console.error('리뷰 수정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 5) 리뷰 삭제 ── */
/* DELETE /api/places/:placeNum/reviews/:reviewNum */
router.delete('/:placeNum/reviews/:reviewNum', authMiddleware, async (req, res) => {
  try {
    const { placeNum, reviewNum } = req.params;
    const userNum = req.user.userNum;

    if (!userNum) {
      return res.status(400).json({ message: '로그인이 필요합니다.' });
    }

    const [existing] = await pool.query(
      'SELECT REVIEW_NUM, USER_NUM, PLACE_NUM FROM PLACE_REVIEW WHERE REVIEW_NUM = ?',
      [reviewNum]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: '리뷰를 찾을 수 없습니다.' });
    }

    if (Number(existing[0].USER_NUM) !== Number(userNum)) {
      return res.status(403).json({ message: '본인이 작성한 리뷰만 삭제할 수 있습니다.' });
    }

    if (Number(existing[0].PLACE_NUM) !== Number(placeNum)) {
      return res.status(400).json({ message: '잘못된 장소 리뷰 요청입니다.' });
    }

    await pool.query('DELETE FROM PLACE_REVIEW WHERE REVIEW_NUM = ?', [reviewNum]);
    res.json({ message: '리뷰가 삭제되었습니다.' });
  } catch (error) {
    console.error('리뷰 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ===================================================
   Google Places API 연동
   =================================================== */

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/* GET /api/places/:placeNum/google-details */
router.get('/:placeNum/google-details', async (req, res) => {
  try {
    const { placeNum } = req.params;
    const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

    if (!GOOGLE_KEY || GOOGLE_KEY === '여기에_키_입력') {
      return res.status(503).json({ message: 'Google Places API 키가 설정되지 않았습니다.' });
    }

    const [places] = await pool.query(
      'SELECT PLACE_NAME, ADDRESS, GOOGLE_PLACE_ID FROM PLACES WHERE PLACE_NUM = ?',
      [placeNum]
    );

    if (places.length === 0) {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    let { PLACE_NAME, ADDRESS, GOOGLE_PLACE_ID } = places[0];

    if (!GOOGLE_PLACE_ID) {
      const query = encodeURIComponent(`${PLACE_NAME} ${ADDRESS || ''}`);
      const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${query}&inputtype=textquery&fields=place_id&language=ko&key=${GOOGLE_KEY}`;
      const searchResult = await httpsGet(searchUrl);

      if (searchResult.candidates && searchResult.candidates.length > 0) {
        GOOGLE_PLACE_ID = searchResult.candidates[0].place_id;
        await pool.query(
          'UPDATE PLACES SET GOOGLE_PLACE_ID = ? WHERE PLACE_NUM = ?',
          [GOOGLE_PLACE_ID, placeNum]
        );
      }
    }

    if (!GOOGLE_PLACE_ID) {
      return res.json({ found: false });
    }

    const fields = 'opening_hours,formatted_phone_number,website,business_status';
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${GOOGLE_PLACE_ID}&fields=${fields}&language=ko&key=${GOOGLE_KEY}`;
    const detailResult = await httpsGet(detailUrl);

    if (detailResult.status !== 'OK') {
      return res.json({ found: false });
    }

    const r = detailResult.result;
    res.json({
      found: true,
      openingHours: r.opening_hours?.weekday_text || null,
      isOpenNow: r.opening_hours?.open_now ?? null,
      phone: r.formatted_phone_number || null,
      website: r.website || null,
      businessStatus: r.business_status || null,
    });
  } catch (error) {
    console.error('Google Places 에러:', error);
    res.status(500).json({ message: '구글 장소 정보를 가져오지 못했습니다.' });
  }
});

module.exports = router;