/* ===================================================
   이미지 업로드 API 라우터
   - 이미지를 Firebase Storage에 업로드
   - 업로드 후 공개 URL을 돌려줌
   =================================================== */

const express = require('express');
const multer = require('multer');
const { uploadToFirebase } = require('../firebase');
const pool = require('../db');
const router = express.Router();

/* --- multer 설정 (메모리에 임시 저장) --- */
/* 파일을 디스크가 아닌 메모리(Buffer)에 저장 → Firebase로 바로 전송 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, /* 최대 10MB */
});

/* ── 1) 범용 이미지 업로드 ── */
/* POST /api/upload/image */
/* 어디서든 이미지를 올리고 URL을 받을 수 있음 */
router.post('/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '이미지 파일이 없습니다.' });
    }

    /* 파일 이름 만들기: 폴더/시간_원본이름 */
    const folder = req.body.folder || 'general';
    const fileName = `${folder}/${Date.now()}_${req.file.originalname}`;

    /* Firebase Storage에 업로드 */
    const url = await uploadToFirebase(req.file.buffer, fileName, req.file.mimetype);

    res.json({ url });
  } catch (error) {
    console.error('이미지 업로드 에러:', error);
    res.status(500).json({ message: '이미지 업로드에 실패했습니다.' });
  }
});

/* ── 2) 장소 이미지 업로드 ── */
/* POST /api/upload/place-image */
/* 장소 번호와 함께 이미지를 올리면 DB에도 저장 */
router.post('/place-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '이미지 파일이 없습니다.' });
    }

    const { placeNum } = req.body;
    if (!placeNum) {
      return res.status(400).json({ message: '장소 번호(placeNum)가 필요합니다.' });
    }

    /* Firebase Storage에 업로드 */
    const fileName = `places/${placeNum}/${Date.now()}_${req.file.originalname}`;
    const url = await uploadToFirebase(req.file.buffer, fileName, req.file.mimetype);

    /* DB의 PLACE_IMAGE 테이블에도 저장 */
    await pool.query(
      'INSERT INTO PLACE_IMAGE (PLACE_NUM, IMAGE_URL) VALUES (?, ?)',
      [placeNum, url]
    );

    res.json({ url, message: '장소 이미지가 등록되었습니다.' });
  } catch (error) {
    console.error('장소 이미지 업로드 에러:', error);
    res.status(500).json({ message: '이미지 업로드에 실패했습니다.' });
  }
});

/* ── 3) 여러 장 한번에 업로드 ── */
/* POST /api/upload/images */
/* 최대 5장까지 한번에 업로드 */
router.post('/images', upload.array('images', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: '이미지 파일이 없습니다.' });
    }

    const folder = req.body.folder || 'general';
    const urls = [];

    /* 각 파일을 Firebase에 업로드 */
    for (const file of req.files) {
      const fileName = `${folder}/${Date.now()}_${file.originalname}`;
      const url = await uploadToFirebase(file.buffer, fileName, file.mimetype);
      urls.push(url);
    }

    res.json({ urls });
  } catch (error) {
    console.error('다중 이미지 업로드 에러:', error);
    res.status(500).json({ message: '이미지 업로드에 실패했습니다.' });
  }
});

module.exports = router;
