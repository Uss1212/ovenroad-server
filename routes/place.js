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

/* 장소 목록 캐시 (필터 없는 전체 조회만 대상, TTL 5분) */
let placesListCache = null;
let placesCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function invalidatePlacesCache() {
  placesListCache = null;
  placesCacheTime = 0;
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
    const noFilter = !keyword && !region && !category && !menu && !sort && !limit;

    /* 필터 없는 전체 조회는 캐시 반환 */
    if (noFilter && placesListCache && Date.now() - placesCacheTime < CACHE_TTL) {
      return res.json(placesListCache);
    }

    /* JOIN 방식으로 한 번에 집계 (correlated subquery 제거) */
    let query = `
      SELECT
        p.PLACE_NUM, p.PLACE_NAME, p.ADDRESS, p.LATITUDE, p.LONGITUDE,
        p.GOOGLE_PLACE_ID,
        ROUND(r.avgRating, 1)       AS avgRating,
        COALESCE(r.reviewCount, 0)  AS reviewCount,
        pi.IMAGE_URL                AS thumbnailImage,
        pc.CATEGORY_NAME            AS categoryName,
        pc.RIBBON_COUNT             AS ribbonCount,
        pc.CERTIFICATION            AS certification,
        pm.menuTags
      FROM PLACES p
      LEFT JOIN (
        SELECT PLACE_NUM, AVG(RATING) AS avgRating, COUNT(*) AS reviewCount
        FROM PLACE_REVIEW GROUP BY PLACE_NUM
      ) r  ON r.PLACE_NUM  = p.PLACE_NUM
      LEFT JOIN (
        SELECT PLACE_NUM, MIN(IMAGE_URL) AS IMAGE_URL
        FROM PLACE_IMAGE GROUP BY PLACE_NUM
      ) pi ON pi.PLACE_NUM = p.PLACE_NUM
      LEFT JOIN (
        SELECT PLACE_NUM,
               MIN(CATEGORY_NAME) AS CATEGORY_NAME,
               MIN(RIBBON_COUNT)  AS RIBBON_COUNT,
               MIN(CERTIFICATION) AS CERTIFICATION
        FROM PLACE_CATEGORY GROUP BY PLACE_NUM
      ) pc ON pc.PLACE_NUM = p.PLACE_NUM
      LEFT JOIN (
        SELECT PLACE_NUM,
               GROUP_CONCAT(MENU_NAME ORDER BY MENU_NUM SEPARATOR ',') AS menuTags
        FROM PLACE_MENU GROUP BY PLACE_NUM
      ) pm ON pm.PLACE_NUM = p.PLACE_NUM
      WHERE 1=1
    `;
    const params = [];

    /* 키워드 검색 (장소 이름 OR 주소 OR 메뉴 이름) */
    if (keyword) {
      query += ` AND (
        p.PLACE_NAME LIKE ? OR p.ADDRESS LIKE ?
        OR p.PLACE_NUM IN (SELECT PLACE_NUM FROM PLACE_MENU WHERE MENU_NAME LIKE ?)
      )`;
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    /* 메뉴 전용 필터 (태그 클릭 시) */
    if (menu) {
      query += ' AND p.PLACE_NUM IN (SELECT PLACE_NUM FROM PLACE_MENU WHERE MENU_NAME LIKE ?)';
      params.push(`%${menu}%`);
    }

    /* 지역 필터 */
    if (region) {
      query += ' AND p.ADDRESS LIKE ?';
      params.push(`%${region}%`);
    }

    /* 카테고리 필터 */
    if (category) {
      query += ' AND p.PLACE_NUM IN (SELECT PLACE_NUM FROM PLACE_CATEGORY WHERE CATEGORY_NAME = ?)';
      params.push(category);
    }

    if (sort === 'rating') {
      query += ' AND r.reviewCount > 0 ORDER BY avgRating DESC, reviewCount DESC, p.PLACE_NUM DESC';
    } else {
      query += ' ORDER BY p.PLACE_NUM DESC';
    }

    const limitNum = parseInt(limit, 10);
    if (!Number.isNaN(limitNum) && limitNum > 0 && limitNum <= 100) {
      query += ` LIMIT ${limitNum}`;
    }

    const [rows] = await pool.query(query, params);

    if (noFilter) {
      placesListCache = rows;
      placesCacheTime = Date.now();
    }

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

    const mapped = results.map(p => ({
      placeId:  p.place_id,
      name:     p.name,
      address:  p.vicinity || '',
      lat:      p.geometry.location.lat,
      lng:      p.geometry.location.lng,
      rating:   p.rating || 0,
      photoUrl: p.photos && p.photos.length > 0
        ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${p.photos[0].photo_reference}&key=${GOOGLE_KEY}`
        : null,
    }));

    /* 응답은 즉시 반환, DB 저장은 백그라운드에서 처리 */
    res.json(mapped);

    /* ── 백그라운드: 조회된 빵집 전부 DB에 저장 ── */
    saveNearbyToDb(results, GOOGLE_KEY).catch(e =>
      console.error('nearby 백그라운드 저장 에러:', e)
    );

  } catch (err) {
    console.error('nearby-bakeries 에러:', err);
    res.json([]);
  }
});

/* 주변 베이커리 DB 저장 헬퍼 함수 */
async function saveNearbyToDb(places, googleKey) {
  if (!places || places.length === 0) return;

  /* 1) 이미 DB에 있는 GOOGLE_PLACE_ID 한번에 조회 */
  const placeIds = places.map(p => p.place_id).filter(Boolean);
  const [existingRows] = await pool.query(
    `SELECT GOOGLE_PLACE_ID FROM PLACES WHERE GOOGLE_PLACE_ID IN (${placeIds.map(() => '?').join(',')})`,
    placeIds
  );
  const existingSet = new Set(existingRows.map(r => r.GOOGLE_PLACE_ID));

  /* 2) 새로운 빵집만 저장 (10개씩 병렬 처리) */
  const newPlaces = places.filter(p => p.place_id && !existingSet.has(p.place_id));
  const CHUNK = 10;
  for (let i = 0; i < newPlaces.length; i += CHUNK) {
    await Promise.all(newPlaces.slice(i, i + CHUNK).map(async p => {
      try {
        const [ins] = await pool.query(
          'INSERT INTO PLACES (PLACE_NAME, ADDRESS, LATITUDE, LONGITUDE, GOOGLE_PLACE_ID) VALUES (?, ?, ?, ?, ?)',
          [p.name, p.vicinity || '', p.geometry.location.lat, p.geometry.location.lng, p.place_id]
        );
        /* 대표 사진도 함께 저장 */
        if (ins.insertId && p.photos && p.photos.length > 0) {
          const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photoreference=${p.photos[0].photo_reference}&key=${googleKey}`;
          await pool.query(
            'INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES (?, ?)',
            [ins.insertId, photoUrl]
          );
        }
      } catch { /* 중복 등 개별 오류 무시 */ }
    }));
  }
}

/* ── 3) 외부 베이커리 DB 저장 ── */
/* POST /api/places/save-external */
/* Google Places 빵집을 DB에 저장하고 PLACE_NUM 반환 (이미 있으면 기존 ID 반환) */
router.post('/save-external', async (req, res) => {
  const { placeId } = req.body;
  if (!placeId) return res.status(400).json({ message: 'placeId 필요' });

  try {
    /* 1) 이미 DB에 있는지 GOOGLE_PLACE_ID로 확인 */
    const [existing] = await pool.query(
      'SELECT PLACE_NUM FROM PLACES WHERE GOOGLE_PLACE_ID = ?',
      [placeId]
    );
    if (existing.length > 0) {
      return res.json({ placeNum: existing[0].PLACE_NUM });
    }

    /* 2) Google Places Details API로 상세 정보 가져오기 */
    const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
    if (!GOOGLE_KEY) return res.status(503).json({ message: 'API 키 없음' });

    const fields = 'name,formatted_address,geometry,photos,rating';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&language=ko&key=${GOOGLE_KEY}`;
    const data = await httpsGet(url);

    if (data.status !== 'OK') {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    const r = data.result;
    const lat = r.geometry?.location?.lat || null;
    const lng = r.geometry?.location?.lng || null;

    /* 3) 같은 이름의 빵집이 DB에 있는지 확인 (중복 방지) */
    const [byName] = await pool.query(
      'SELECT PLACE_NUM FROM PLACES WHERE PLACE_NAME = ? LIMIT 1',
      [r.name]
    );
    if (byName.length > 0) {
      /* 기존 빵집에 GOOGLE_PLACE_ID 연결 */
      await pool.query('UPDATE PLACES SET GOOGLE_PLACE_ID = ? WHERE PLACE_NUM = ?', [placeId, byName[0].PLACE_NUM]);
      return res.json({ placeNum: byName[0].PLACE_NUM });
    }

    /* 4) 새 빵집 DB에 삽입 */
    const [result] = await pool.query(
      `INSERT INTO PLACES (PLACE_NAME, ADDRESS, LATITUDE, LONGITUDE, GOOGLE_PLACE_ID)
       VALUES (?, ?, ?, ?, ?)`,
      [r.name, r.formatted_address || '', lat, lng, placeId]
    );
    const placeNum = result.insertId;

    /* 5) 대표 사진이 있으면 PLACE_IMAGE에도 저장 */
    if (r.photos && r.photos.length > 0) {
      const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${r.photos[0].photo_reference}&key=${GOOGLE_KEY}`;
      await pool.query(
        'INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES (?, ?)',
        [placeNum, photoUrl]
      );
    }

    res.json({ placeNum });
  } catch (err) {
    console.error('save-external 에러:', err);
    res.status(500).json({ message: '저장 실패' });
  }
});

/* ── 4) 외부 베이커리 상세 조회 (Google Places Details) ── */
/* GET /api/places/external/:placeId */
/* DB에 없는 Google Places 베이커리의 상세 정보를 가져옴 */
router.get('/external/:placeId', async (req, res) => {
  const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!GOOGLE_KEY) return res.status(503).json({ message: 'API 키 없음' });

  const { placeId } = req.params;

  try {
    const fields = 'name,formatted_address,geometry,opening_hours,formatted_phone_number,website,photos,rating,user_ratings_total,business_status';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=${fields}&language=ko&key=${GOOGLE_KEY}`;
    const data = await httpsGet(url);

    if (data.status !== 'OK') {
      return res.status(404).json({ message: '장소를 찾을 수 없습니다.' });
    }

    const r = data.result;

    /* 사진 URL 최대 5장 */
    const photos = (r.photos || []).slice(0, 5).map(p =>
      `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${p.photo_reference}&key=${GOOGLE_KEY}`
    );

    res.json({
      placeId,
      name:          r.name,
      address:       r.formatted_address || '',
      lat:           r.geometry?.location?.lat || null,
      lng:           r.geometry?.location?.lng || null,
      phone:         r.formatted_phone_number || null,
      website:       r.website || null,
      rating:        r.rating || 0,
      ratingCount:   r.user_ratings_total || 0,
      businessStatus: r.business_status || null,
      openingHours:  r.opening_hours?.weekday_text || null,
      isOpenNow:     r.opening_hours?.open_now ?? null,
      photos,
    });
  } catch (err) {
    console.error('external place 에러:', err);
    res.status(500).json({ message: '장소 정보를 가져오지 못했습니다.' });
  }
});

/* ── 4) 장소 상세 조회 ── */
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

    invalidatePlacesCache();
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

    invalidatePlacesCache();
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

    invalidatePlacesCache();
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

    const fields = 'opening_hours,formatted_phone_number,website,business_status,photos';
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${GOOGLE_PLACE_ID}&fields=${fields}&language=ko&key=${GOOGLE_KEY}`;
    const detailResult = await httpsGet(detailUrl);

    if (detailResult.status !== 'OK') {
      return res.json({ found: false });
    }

    const r = detailResult.result;
    const photoUrl = r.photos && r.photos.length > 0
      ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=600&photoreference=${r.photos[0].photo_reference}&key=${GOOGLE_KEY}`
      : null;

    /* 사진이 있고 DB에 아직 없으면 저장 (다음 조회부터 DB에서 바로 반환) */
    if (photoUrl) {
      const [existingImg] = await pool.query(
        'SELECT PLACE_NUM FROM PLACE_IMAGE WHERE PLACE_NUM = ? LIMIT 1', [placeNum]
      );
      if (existingImg.length === 0) {
        await pool.query(
          'INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES (?, ?)', [placeNum, photoUrl]
        );
      }
    }

    res.json({
      found: true,
      photoUrl,
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

/* ── 빵집 좋아요 토글 ── */
router.post('/:placeNum/like', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;
    const userNum = req.user.userNum;
    const [existing] = await pool.query('SELECT * FROM PLACE_LIKE WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
    if (existing.length > 0) {
      await pool.query('DELETE FROM PLACE_LIKE WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO PLACE_LIKE (PLACE_NUM, USER_NUM) VALUES (?, ?)', [placeNum, userNum]);
      res.json({ liked: true });
    }
  } catch (error) {
    console.error('빵집 좋아요 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 빵집 북마크 토글 ── */
router.post('/:placeNum/bookmark', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;
    const userNum = req.user.userNum;
    const [existing] = await pool.query('SELECT * FROM PLACE_BOOKMARK WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
    if (existing.length > 0) {
      await pool.query('DELETE FROM PLACE_BOOKMARK WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
      res.json({ bookmarked: false });
    } else {
      await pool.query('INSERT INTO PLACE_BOOKMARK (PLACE_NUM, USER_NUM) VALUES (?, ?)', [placeNum, userNum]);
      res.json({ bookmarked: true });
    }
  } catch (error) {
    console.error('빵집 북마크 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 빵집 좋아요/북마크 상태 조회 ── */
router.get('/:placeNum/status', authMiddleware, async (req, res) => {
  try {
    const { placeNum } = req.params;
    const userNum = req.user.userNum;
    const [likeRows] = await pool.query('SELECT 1 FROM PLACE_LIKE WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
    const [bmRows] = await pool.query('SELECT 1 FROM PLACE_BOOKMARK WHERE PLACE_NUM = ? AND USER_NUM = ?', [placeNum, userNum]);
    res.json({ liked: likeRows.length > 0, bookmarked: bmRows.length > 0 });
  } catch (error) {
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 내가 북마크한 빵집 목록 ── */
router.get('/my/bookmarks', authMiddleware, async (req, res) => {
  try {
    const userNum = req.user.userNum;
    const [rows] = await pool.query(
      `SELECT p.PLACE_NUM, p.PLACE_NAME, p.ADDRESS,
        (SELECT pi.IMAGE_URL FROM PLACE_IMAGE pi WHERE pi.PLACE_NUM = p.PLACE_NUM LIMIT 1) AS thumbnailImage
       FROM PLACE_BOOKMARK pb
       JOIN PLACES p ON pb.PLACE_NUM = p.PLACE_NUM
       WHERE pb.USER_NUM = ?
       ORDER BY pb.CREATED_AT DESC`,
      [userNum]
    );
    res.json(rows);
  } catch (error) {
    console.error('북마크 목록 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;