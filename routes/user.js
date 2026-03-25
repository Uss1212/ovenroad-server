/* ===================================================
   사용자(User) API 라우터
   - 회원가입, 로그인, 아이디/닉네임 중복확인
   - 이메일 인증, 회원정보 조회/수정
   - USER 테이블 사용
   =================================================== */

const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer'); /* 이메일 보내주는 도구 */
const pool = require('../db');

/* ===================================================
   네이버 로그인 OAuth 설정
   - 네이버 개발자센터에서 발급받은 키
   - 사용자가 네이버로 로그인하면 네이버가 우리 서버로 "이 사람 맞아!" 정보를 보내줌
   =================================================== */
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;           /* 네이버가 우리 앱을 구분하는 ID */
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;   /* 네이버가 우리 앱을 확인하는 비밀 키 */
const NAVER_REDIRECT_URI = process.env.NAVER_REDIRECT_URI;     /* 네이버 로그인 후 돌아올 주소 */

/* ===================================================
   카카오 로그인 OAuth 설정
   - 카카오 개발자센터에서 발급받은 키
   - 사용자가 카카오로 로그인하면 카카오가 우리 서버로 정보를 보내줌
   =================================================== */
const KAKAO_CLIENT_ID = process.env.KAKAO_CLIENT_ID;           /* 카카오 REST API 키 */
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET;   /* 카카오 클라이언트 시크릿 */
const KAKAO_REDIRECT_URI = process.env.KAKAO_REDIRECT_URI;     /* 카카오 로그인 후 돌아올 주소 */

/* --- Gmail로 이메일 보내는 도구 설정 --- */
/* transporter: 우체부 같은 역할 (Gmail 우체국을 통해 편지를 보냄) */
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',   /* Gmail SMTP 서버 주소 */
  port: 587,                /* 587 포트 사용 (Render 무료 플랜 호환) */
  secure: false,            /* 587은 STARTTLS 방식이라 false */
  auth: {
    user: process.env.GMAIL_USER,     /* 보내는 사람 이메일 주소 (.env에서 가져옴) */
    pass: process.env.GMAIL_PASS,     /* Gmail 앱 비밀번호 (.env에서 가져옴) */
  },
});

/* --- 라우터 만들기 --- */
/* 라우터: 비슷한 종류의 API를 하나로 묶어주는 도구 */
const router = express.Router();

/* --- 이메일 인증코드 임시 저장소 --- */
/* 나중에 Redis 같은 것으로 교체 예정 */
const emailCodes = {};

/* ── 1) 회원가입 ── */
/* POST /api/user/signup */
router.post('/signup', async (req, res) => {
  try {
    const { id, password, name, nickname, email } = req.body;

    /* 필수값 확인 */
    if (!id || !password || !name || !nickname || !email) {
      return res.status(400).json({ message: '모든 항목을 입력해주세요.' });
    }

    /* 아이디 중복 확인 */
    const [existingId] = await pool.query('SELECT USER_NUM FROM USER WHERE ID = ?', [id]);
    if (existingId.length > 0) {
      return res.status(409).json({ message: '이미 사용 중인 아이디입니다.' });
    }

    /* 닉네임 중복 확인 */
    const [existingNickname] = await pool.query('SELECT USER_NUM FROM USER WHERE NICKNAME = ?', [nickname]);
    if (existingNickname.length > 0) {
      return res.status(409).json({ message: '이미 사용 중인 닉네임입니다.' });
    }

    /* 이메일 중복 확인 */
    const [existingEmail] = await pool.query('SELECT USER_NUM FROM USER WHERE EMAIL = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(409).json({ message: '이미 가입된 이메일입니다.' });
    }

    /* 비밀번호 암호화 */
    const hashedPassword = await bcrypt.hash(password, 10);

    /* DB에 새 회원 저장 */
    const [result] = await pool.query(
      'INSERT INTO USER (ID, USER_PW, NAME, NICKNAME, EMAIL) VALUES (?, ?, ?, ?, ?)',
      [id, hashedPassword, name, nickname, email]
    );

    res.status(201).json({
      message: '회원가입이 완료되었습니다.',
      userNum: result.insertId,
    });
  } catch (error) {
    console.error('회원가입 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 2) 로그인 ── */
/* POST /api/user/login */
/* 이메일 주소 = 아이디! 이메일로 로그인 */
router.post('/login', async (req, res) => {
  try {
    const { id, password } = req.body;

    if (!id || !password) {
      return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요.' });
    }

    /* DB에서 사용자 찾기 (이메일 = 아이디) */
    const [rows] = await pool.query('SELECT * FROM USER WHERE EMAIL = ?', [id]);
    if (rows.length === 0) {
      return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    const user = rows[0];

    /* 비밀번호 비교 */
    const isMatch = await bcrypt.compare(password, user.USER_PW);
    if (!isMatch) {
      return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    /* 로그인 성공 → 비밀번호 빼고 응답 */
    res.json({
      message: '로그인 성공',
      user: {
        userNum: user.USER_NUM,
        id: user.ID,
        name: user.NAME,
        nickname: user.NICKNAME,
        email: user.EMAIL,
        grade: user.GRADE,
        profileImage: user.PROFILE_IMAGE,
      },
    });
  } catch (error) {
    console.error('로그인 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 3) 아이디 중복확인 ── */
/* GET /api/user/check-id?id=xxx */
router.get('/check-id', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ message: '아이디를 입력해주세요.' });

    const [rows] = await pool.query('SELECT USER_NUM FROM USER WHERE ID = ?', [id]);
    if (rows.length > 0) {
      return res.status(409).json({ message: '이미 사용 중인 아이디입니다.', available: false });
    }
    res.json({ message: '사용 가능한 아이디입니다.', available: true });
  } catch (error) {
    console.error('아이디 중복확인 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 4) 닉네임 중복확인 ── */
/* GET /api/user/check-nickname?nickname=xxx */
router.get('/check-nickname', async (req, res) => {
  try {
    const { nickname } = req.query;
    if (!nickname) return res.status(400).json({ message: '닉네임을 입력해주세요.' });

    const [rows] = await pool.query('SELECT USER_NUM FROM USER WHERE NICKNAME = ?', [nickname]);
    if (rows.length > 0) {
      return res.status(409).json({ message: '이미 사용 중인 닉네임입니다.', available: false });
    }
    res.json({ message: '사용 가능한 닉네임입니다.', available: true });
  } catch (error) {
    console.error('닉네임 중복확인 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 5) 이메일 인증코드 전송 (Gmail SMTP) ── */
/* POST /api/user/send-email */
/* 사용자가 입력한 이메일 주소로 6자리 인증코드를 실제로 보냄 */
router.post('/send-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: '이메일을 입력해주세요.' });

    /* 6자리 랜덤 인증코드 생성 (100000 ~ 999999) */
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    /* 인증코드를 메모리에 저장 (나중에 확인할 때 비교용) */
    emailCodes[email] = code;

    /* 실제 이메일 보내기! */
    /* transporter.sendMail() = 우체부에게 "이 편지 보내줘!" 하는 것 */
    await transporter.sendMail({
      from: `"오븐로드" <${process.env.GMAIL_USER}>`,  /* 보내는 사람 (오븐로드 이름으로) */
      to: email,                                      /* 받는 사람 (사용자가 입력한 이메일) */
      subject: '[오븐로드] 이메일 인증코드',            /* 이메일 제목 */
      html: `
        <div style="font-family: 'Apple SD Gothic Neo', sans-serif; max-width: 500px; margin: 0 auto; padding: 30px; border: 1px solid #e5e7eb; border-radius: 12px;">
          <h2 style="color: #b45309; text-align: center;">🍞 오븐로드 이메일 인증</h2>
          <p style="color: #374151; font-size: 16px; text-align: center;">
            아래 인증코드를 회원가입 페이지에 입력해주세요.
          </p>
          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: bold; color: #92400e; letter-spacing: 8px;">${code}</span>
          </div>
          <p style="color: #6b7280; font-size: 13px; text-align: center;">
            본인이 요청하지 않았다면 이 이메일을 무시해주세요.
          </p>
        </div>
      `,
    });

    console.log(`[이메일 인증] ${email} → 인증코드 전송 완료`);
    res.json({ message: '인증코드가 전송되었습니다.' });
  } catch (error) {
    console.error('이메일 전송 에러:', error);
    res.status(500).json({ message: '이메일 전송에 실패했습니다. 이메일 주소를 확인해주세요.' });
  }
});

/* ── 6) 이메일 인증코드 확인 ── */
/* POST /api/user/verify-email */
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: '이메일과 인증코드를 입력해주세요.' });

    if (emailCodes[email] === code) {
      delete emailCodes[email];
      res.json({ message: '이메일 인증이 완료되었습니다.', verified: true });
    } else {
      res.status(400).json({ message: '인증코드가 일치하지 않습니다.', verified: false });
    }
  } catch (error) {
    console.error('인증코드 확인 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 7) 회원정보 조회 ── */
/* GET /api/user/:userNum */
router.get('/:userNum', async (req, res) => {
  try {
    const { userNum } = req.params;
    const [rows] = await pool.query(
      'SELECT USER_NUM, ID, NAME, NICKNAME, EMAIL, GRADE, PROFILE_IMAGE FROM USER WHERE USER_NUM = ?',
      [userNum]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('회원정보 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 8) 회원정보 수정 ── */
/* PUT /api/user/:userNum */
router.put('/:userNum', async (req, res) => {
  try {
    const { userNum } = req.params;
    const { nickname, email, profileImage } = req.body;

    await pool.query(
      'UPDATE USER SET NICKNAME = COALESCE(?, NICKNAME), EMAIL = COALESCE(?, EMAIL), PROFILE_IMAGE = COALESCE(?, PROFILE_IMAGE) WHERE USER_NUM = ?',
      [nickname, email, profileImage, userNum]
    );

    res.json({ message: '회원정보가 수정되었습니다.' });
  } catch (error) {
    console.error('회원정보 수정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 9) 비밀번호 변경 ── */
/* PUT /api/user/:userNum/password */
/* 현재 비밀번호를 확인한 후, 새 비밀번호로 변경 */
router.put('/:userNum/password', async (req, res) => {
  try {
    const { userNum } = req.params;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: '현재 비밀번호와 새 비밀번호를 입력해주세요.' });
    }

    /* DB에서 사용자 찾기 */
    const [rows] = await pool.query('SELECT USER_PW FROM USER WHERE USER_NUM = ?', [userNum]);
    if (rows.length === 0) {
      return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    }

    /* 현재 비밀번호가 맞는지 확인 */
    const isMatch = await bcrypt.compare(currentPassword, rows[0].USER_PW);
    if (!isMatch) {
      return res.status(401).json({ message: '현재 비밀번호가 올바르지 않습니다.' });
    }

    /* 새 비밀번호 암호화 후 저장 */
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE USER SET USER_PW = ? WHERE USER_NUM = ?', [hashedPassword, userNum]);

    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (error) {
    console.error('비밀번호 변경 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 10) 회원탈퇴 ── */
/* DELETE /api/user/:userNum */
/* 비밀번호를 확인한 후, 사용자 정보를 DB에서 삭제 */
router.delete('/:userNum', async (req, res) => {
  try {
    const { userNum } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: '비밀번호를 입력해주세요.' });
    }

    /* DB에서 사용자 찾기 */
    const [rows] = await pool.query('SELECT USER_PW FROM USER WHERE USER_NUM = ?', [userNum]);
    if (rows.length === 0) {
      return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    }

    /* 비밀번호 확인 */
    const isMatch = await bcrypt.compare(password, rows[0].USER_PW);
    if (!isMatch) {
      return res.status(401).json({ message: '비밀번호가 올바르지 않습니다.' });
    }

    /* 사용자 삭제 */
    await pool.query('DELETE FROM USER WHERE USER_NUM = ?', [userNum]);

    res.json({ message: '회원탈퇴가 완료되었습니다.' });
  } catch (error) {
    console.error('회원탈퇴 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 11) 네이버 로그인 - 네이버 로그인 페이지로 이동 ── */
/* GET /api/user/naver/login */
/* 프론트에서 이 주소로 요청하면 → 네이버 로그인 페이지로 보내줌 */
router.get('/naver/login', (req, res) => {
  /* state: 보안을 위한 랜덤 문자열 (해킹 방지용) */
  const state = Math.random().toString(36).substring(2, 15);

  /* 네이버 로그인 페이지 주소 만들기 */
  const naverAuthUrl = `https://nid.naver.com/oauth2.0/authorize`
    + `?response_type=code`             /* "코드를 줘!" 라고 요청 */
    + `&client_id=${NAVER_CLIENT_ID}`    /* 우리 앱의 ID */
    + `&redirect_uri=${encodeURIComponent(NAVER_REDIRECT_URI)}` /* 로그인 후 돌아올 주소 */
    + `&state=${state}`;                 /* 보안용 랜덤 문자열 */

  /* 네이버 로그인 페이지로 이동시킴 */
  res.redirect(naverAuthUrl);
});

/* ── 12) 네이버 로그인 - 콜백 (네이버가 우리한테 정보를 보내주는 곳) ── */
/* GET /api/user/naver/callback */
/* 사용자가 네이버에서 로그인 성공하면, 네이버가 이 주소로 "코드"를 보내줌 */
router.get('/naver/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    /* --- 1단계: 코드로 "토큰" 받기 --- */
    /* 토큰 = 네이버한테 "이 사람 정보 줘!" 할 때 쓰는 열쇠 */
    const tokenResponse = await fetch(
      `https://nid.naver.com/oauth2.0/token`
      + `?grant_type=authorization_code`    /* "코드를 토큰으로 바꿔줘!" */
      + `&client_id=${NAVER_CLIENT_ID}`
      + `&client_secret=${NAVER_CLIENT_SECRET}`
      + `&code=${code}`                     /* 네이버가 보내준 코드 */
      + `&state=${state}`
    );
    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=naver_token_failed`);
    }

    /* --- 2단계: 토큰으로 사용자 정보 가져오기 --- */
    /* "이 열쇠로 이 사람 정보 보여줘!" */
    const profileResponse = await fetch('https://openapi.naver.com/v1/nid/me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`, /* 열쇠(토큰)를 보여줌 */
      },
    });
    const profileData = await profileResponse.json();

    if (profileData.resultcode !== '00') {
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=naver_profile_failed`);
    }

    /* 네이버에서 받은 사용자 정보 꺼내기 */
    const naverUser = profileData.response;
    /* naverUser 안에 들어있는 것들:
       - id: 네이버 고유 번호
       - email: 이메일
       - name: 이름
       - nickname: 닉네임
       - profile_image: 프로필 사진 주소
    */

    /* --- 3단계: 우리 DB에 사용자가 있는지 확인 --- */
    const [existingUser] = await pool.query(
      'SELECT * FROM USER WHERE SOCIAL_TYPE = ? AND SOCIAL_ID = ?',
      ['naver', naverUser.id]
    );

    let user;

    if (existingUser.length > 0) {
      /* 이미 네이버로 가입한 적 있음 → 기존 정보 사용 */
      user = existingUser[0];
    } else {
      /* 같은 이메일로 이미 가입한 계정이 있는지 확인 */
      const [emailUser] = await pool.query('SELECT * FROM USER WHERE EMAIL = ?', [naverUser.email]);

      if (emailUser.length > 0) {
        /* 같은 이메일 계정이 있으면 → 네이버 정보를 연결해줌 */
        await pool.query(
          'UPDATE USER SET SOCIAL_TYPE = ?, SOCIAL_ID = ?, PROFILE_IMAGE = COALESCE(PROFILE_IMAGE, ?) WHERE USER_NUM = ?',
          ['naver', naverUser.id, naverUser.profile_image || null, emailUser[0].USER_NUM]
        );
        /* 업데이트된 사용자 정보 가져오기 */
        const [updated] = await pool.query('SELECT * FROM USER WHERE USER_NUM = ?', [emailUser[0].USER_NUM]);
        user = updated[0];
      } else {
        /* 완전 새 사용자 → 자동 회원가입! */

        /* 닉네임 중복 방지: 네이버닉네임 + 랜덤숫자 */
        let nickname = naverUser.nickname || naverUser.name || '네이버유저';
        const [nickCheck] = await pool.query('SELECT USER_NUM FROM USER WHERE NICKNAME = ?', [nickname]);
        if (nickCheck.length > 0) {
          nickname = nickname + Math.floor(Math.random() * 9999);
        }

        /* DB에 새 회원으로 저장 */
        const [result] = await pool.query(
          `INSERT INTO USER (NAME, NICKNAME, EMAIL, PROFILE_IMAGE, SOCIAL_TYPE, SOCIAL_ID)
           VALUES (?, ?, ?, ?, 'naver', ?)`,
          [
            naverUser.name || '네이버유저',
            nickname,
            naverUser.email || '',
            naverUser.profile_image || null,
            naverUser.id,
          ]
        );

        /* 방금 만든 사용자 정보 가져오기 */
        const [newUser] = await pool.query('SELECT * FROM USER WHERE USER_NUM = ?', [result.insertId]);
        user = newUser[0];
      }
    }

    /* --- 4단계: 프론트엔드로 사용자 정보 전달 --- */
    /* URL에 사용자 정보를 붙여서 프론트엔드로 보내줌 */
    const userData = encodeURIComponent(JSON.stringify({
      userNum: user.USER_NUM,
      id: user.ID,
      name: user.NAME,
      nickname: user.NICKNAME,
      email: user.EMAIL,
      grade: user.GRADE,
      profileImage: user.PROFILE_IMAGE,
      socialType: user.SOCIAL_TYPE,
    }));

    res.redirect(`${process.env.FRONTEND_URL}/login/naver-callback?user=${userData}`);
  } catch (error) {
    console.error('네이버 로그인 에러:', error);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=naver_server_error`);
  }
});

/* ── 13) 카카오 로그인 - 카카오 로그인 페이지로 이동 ── */
/* GET /api/user/kakao/login */
/* 프론트에서 이 주소로 요청하면 → 카카오 로그인 페이지로 보내줌 */
router.get('/kakao/login', (req, res) => {
  /* 카카오 로그인 페이지 주소 만들기 */
  const kakaoAuthUrl = `https://kauth.kakao.com/oauth/authorize`
    + `?response_type=code`              /* "코드를 줘!" 라고 요청 */
    + `&client_id=${KAKAO_CLIENT_ID}`     /* 우리 앱의 REST API 키 */
    + `&redirect_uri=${encodeURIComponent(KAKAO_REDIRECT_URI)}`; /* 로그인 후 돌아올 주소 */

  /* 카카오 로그인 페이지로 이동시킴 */
  res.redirect(kakaoAuthUrl);
});

/* ── 14) 카카오 로그인 - 콜백 (카카오가 우리한테 정보를 보내주는 곳) ── */
/* GET /api/user/kakao/callback */
/* 사용자가 카카오에서 로그인 성공하면, 카카오가 이 주소로 "코드"를 보내줌 */
router.get('/kakao/callback', async (req, res) => {
  try {
    const { code } = req.query;

    /* --- 1단계: 코드로 "토큰" 받기 --- */
    /* 토큰 = 카카오한테 "이 사람 정보 줘!" 할 때 쓰는 열쇠 */
    const tokenResponse = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',   /* "코드를 토큰으로 바꿔줘!" */
        client_id: KAKAO_CLIENT_ID,          /* 우리 앱의 REST API 키 */
        client_secret: KAKAO_CLIENT_SECRET,  /* 클라이언트 시크릿 키 */
        redirect_uri: KAKAO_REDIRECT_URI,    /* 콜백 주소 */
        code: code,                          /* 카카오가 보내준 코드 */
      }),
    });
    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      /* 에러 내용을 서버 콘솔에 출력 (디버깅용) */
      console.error('카카오 토큰 에러:', tokenData);
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=kakao_token_failed`);
    }

    /* --- 2단계: 토큰으로 사용자 정보 가져오기 --- */
    /* "이 열쇠로 이 사람 정보 보여줘!" */
    const profileResponse = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`, /* 열쇠(토큰)를 보여줌 */
      },
    });
    const profileData = await profileResponse.json();

    /* 카카오에서 받은 사용자 정보 꺼내기 */
    const kakaoId = String(profileData.id);                          /* 카카오 고유 번호 */
    const nickname = profileData.properties?.nickname || '카카오유저'; /* 닉네임 */
    const profileImage = profileData.properties?.profile_image || null; /* 프로필 사진 */
    /* 카카오는 이메일을 비즈앱만 받을 수 있어서, 없으면 빈 문자열 */
    const email = profileData.kakao_account?.email || '';

    /* --- 3단계: 우리 DB에 사용자가 있는지 확인 --- */
    const [existingUser] = await pool.query(
      'SELECT * FROM USER WHERE SOCIAL_TYPE = ? AND SOCIAL_ID = ?',
      ['kakao', kakaoId]
    );

    let user;

    if (existingUser.length > 0) {
      /* 이미 카카오로 가입한 적 있음 → 기존 정보 사용 */
      user = existingUser[0];
    } else {
      /* 이메일이 있으면 기존 계정 확인 */
      if (email) {
        const [emailUser] = await pool.query('SELECT * FROM USER WHERE EMAIL = ?', [email]);
        if (emailUser.length > 0) {
          /* 같은 이메일 계정이 있으면 → 카카오 정보를 연결해줌 */
          await pool.query(
            'UPDATE USER SET SOCIAL_TYPE = ?, SOCIAL_ID = ?, PROFILE_IMAGE = COALESCE(PROFILE_IMAGE, ?) WHERE USER_NUM = ?',
            ['kakao', kakaoId, profileImage, emailUser[0].USER_NUM]
          );
          const [updated] = await pool.query('SELECT * FROM USER WHERE USER_NUM = ?', [emailUser[0].USER_NUM]);
          user = updated[0];
        }
      }

      /* 기존 계정이 없으면 → 새로 회원가입 */
      if (!user) {
        /* 닉네임 중복 방지 */
        let finalNickname = nickname;
        const [nickCheck] = await pool.query('SELECT USER_NUM FROM USER WHERE NICKNAME = ?', [finalNickname]);
        if (nickCheck.length > 0) {
          finalNickname = finalNickname + Math.floor(Math.random() * 9999);
        }

        /* 카카오는 이메일이 없을 수 있으니, 없으면 고유한 임시 이메일 생성 */
        const finalEmail = email || `kakao_${kakaoId}@kakao.temp`;

        /* DB에 새 회원으로 저장 */
        const [result] = await pool.query(
          `INSERT INTO USER (NAME, NICKNAME, EMAIL, PROFILE_IMAGE, SOCIAL_TYPE, SOCIAL_ID)
           VALUES (?, ?, ?, ?, 'kakao', ?)`,
          [nickname, finalNickname, finalEmail, profileImage, kakaoId]
        );

        const [newUser] = await pool.query('SELECT * FROM USER WHERE USER_NUM = ?', [result.insertId]);
        user = newUser[0];
      }
    }

    /* --- 4단계: 프론트엔드로 사용자 정보 전달 --- */
    const userData = encodeURIComponent(JSON.stringify({
      userNum: user.USER_NUM,
      id: user.ID,
      name: user.NAME,
      nickname: user.NICKNAME,
      email: user.EMAIL,
      grade: user.GRADE,
      profileImage: user.PROFILE_IMAGE,
      socialType: user.SOCIAL_TYPE,
    }));

    res.redirect(`${process.env.FRONTEND_URL}/login/kakao-callback?user=${userData}`);
  } catch (error) {
    console.error('카카오 로그인 에러:', error);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=kakao_server_error`);
  }
});

/* ── 14-1) 아이디 찾기 ── */
/* POST /api/user/find-id */
/* 이메일로 가입된 아이디(ID)를 찾아서 돌려줌 */
router.post('/find-id', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: '이메일을 입력해주세요.' });

    /* 이메일로 사용자 찾기 (소셜 로그인 여부도 함께 조회) */
    const [rows] = await pool.query('SELECT ID, SOCIAL_TYPE FROM USER WHERE EMAIL = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ message: '해당 이메일로 가입된 계정이 없습니다.' });
    }

    /* 소셜 로그인으로 가입한 계정이면 별도 안내 */
    if (rows[0].SOCIAL_TYPE) {
      const socialName = rows[0].SOCIAL_TYPE === 'naver' ? '네이버'
        : rows[0].SOCIAL_TYPE === 'kakao' ? '카카오' : rows[0].SOCIAL_TYPE;
      return res.json({
        message: '소셜 로그인으로 가입된 계정입니다.',
        socialType: rows[0].SOCIAL_TYPE,
        socialName,
      });
    }

    /* 아이디를 일부만 보여줌 (보안) */
    /* 예: dean414@naver.com → de****4@naver.com */
    /* 예: asder → as**r */
    const fullId = rows[0].ID;
    let maskedId = fullId;
    if (fullId && fullId.includes('@')) {
      /* 이메일 형식인 경우 */
      const [localPart, domain] = fullId.split('@');
      if (localPart.length <= 2) {
        maskedId = localPart[0] + '*'.repeat(localPart.length - 1) + '@' + domain;
      } else {
        maskedId = localPart.slice(0, 2) + '*'.repeat(localPart.length - 3) + localPart.slice(-1) + '@' + domain;
      }
    } else if (fullId && fullId.length > 2) {
      /* 일반 아이디인 경우 */
      maskedId = fullId.slice(0, 2) + '*'.repeat(fullId.length - 3) + fullId.slice(-1);
    }

    res.json({
      message: '아이디를 찾았습니다.',
      id: maskedId,
    });
  } catch (error) {
    console.error('아이디 찾기 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 14-2) 비밀번호 재설정 ── */
/* POST /api/user/reset-password */
/* 이메일 인증 완료 후, 새 비밀번호로 변경 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) {
      return res.status(400).json({ message: '이메일과 새 비밀번호를 입력해주세요.' });
    }

    /* 이메일로 사용자 찾기 (소셜 로그인 여부도 확인) */
    const [rows] = await pool.query('SELECT USER_NUM, SOCIAL_TYPE FROM USER WHERE EMAIL = ?', [email]);
    if (rows.length === 0) {
      return res.status(404).json({ message: '해당 이메일로 가입된 계정이 없습니다.' });
    }

    /* 소셜 로그인 계정은 비밀번호 변경 불가 */
    if (rows[0].SOCIAL_TYPE) {
      return res.status(400).json({ message: '소셜 로그인으로 가입된 계정은 비밀번호를 변경할 수 없습니다.' });
    }

    /* 새 비밀번호 암호화 후 저장 */
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE USER SET USER_PW = ? WHERE EMAIL = ?', [hashedPassword, email]);

    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (error) {
    console.error('비밀번호 재설정 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 14-3) 리뷰 삭제 ── */
/* DELETE /api/user/reviews/:reviewNum */
/* 마이페이지에서 내가 쓴 리뷰를 삭제할 때 사용 */
router.delete('/reviews/:reviewNum', async (req, res) => {
  try {
    const { reviewNum } = req.params;
    const { userNum } = req.body;

    /* 본인 리뷰인지 확인 */
    const [review] = await pool.query('SELECT * FROM PLACE_REVIEW WHERE REVIEW_NUM = ? AND USER_NUM = ?', [reviewNum, userNum]);
    if (review.length === 0) {
      return res.status(403).json({ message: '삭제 권한이 없습니다.' });
    }

    await pool.query('DELETE FROM PLACE_REVIEW WHERE REVIEW_NUM = ?', [reviewNum]);
    res.json({ message: '리뷰가 삭제되었습니다.' });
  } catch (error) {
    console.error('리뷰 삭제 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 15) 내가 만든 코스 목록 ── */
/* GET /api/user/:userNum/my-courses */
/* 마이페이지에서 내가 만든 코스를 보여줄 때 사용 */
router.get('/:userNum/my-courses', async (req, res) => {
  try {
    const { userNum } = req.params;

    const [rows] = await pool.query(`
      SELECT
        c.COURSE_NUM, c.TITLE, c.SUBTITLE, c.CREATED_TIME,
        (SELECT COUNT(*) FROM COURSE_LIKE cl WHERE cl.COURSE_NUM = c.COURSE_NUM) AS likeCount,
        (SELECT COUNT(*) FROM COURSE_PLACE cp WHERE cp.COURSE_NUM = c.COURSE_NUM) AS placeCount
      FROM COURSES c
      WHERE c.USER_NUM = ?
      ORDER BY c.CREATED_TIME DESC
    `, [userNum]);

    res.json(rows);
  } catch (error) {
    console.error('내 코스 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 16) 내가 남긴 리뷰 목록 ── */
/* GET /api/user/:userNum/my-reviews */
/* 마이페이지에서 내가 작성한 리뷰를 보여줄 때 사용 */
router.get('/:userNum/my-reviews', async (req, res) => {
  try {
    const { userNum } = req.params;

    const [rows] = await pool.query(`
      SELECT
        pr.REVIEW_NUM, pr.RATING, pr.CONTENT, pr.CREATED_TIME,
        p.PLACE_NUM, p.PLACE_NAME
      FROM PLACE_REVIEW pr
      JOIN PLACES p ON p.PLACE_NUM = pr.PLACE_NUM
      WHERE pr.USER_NUM = ?
      ORDER BY pr.CREATED_TIME DESC
    `, [userNum]);

    res.json(rows);
  } catch (error) {
    console.error('내 리뷰 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 17) 좋아요한 코스 목록 ── */
/* GET /api/user/:userNum/liked-courses */
/* 마이페이지에서 내가 좋아요 누른 코스를 보여줄 때 사용 */
router.get('/:userNum/liked-courses', async (req, res) => {
  try {
    const { userNum } = req.params;

    const [rows] = await pool.query(`
      SELECT
        c.COURSE_NUM, c.TITLE, c.SUBTITLE, c.CREATED_TIME,
        u.NICKNAME AS author,
        (SELECT COUNT(*) FROM COURSE_LIKE cl2 WHERE cl2.COURSE_NUM = c.COURSE_NUM) AS likeCount,
        (SELECT COUNT(*) FROM COURSE_PLACE cp WHERE cp.COURSE_NUM = c.COURSE_NUM) AS placeCount
      FROM COURSE_LIKE cl
      JOIN COURSES c ON c.COURSE_NUM = cl.COURSE_NUM
      JOIN USER u ON u.USER_NUM = c.USER_NUM
      WHERE cl.USER_NUM = ?
      ORDER BY cl.CREATED_TIME DESC
    `, [userNum]);

    res.json(rows);
  } catch (error) {
    console.error('좋아요 코스 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 18) 스크랩한 코스 목록 ── */
/* GET /api/user/:userNum/scraped-courses */
/* 마이페이지에서 내가 스크랩한 코스를 보여줄 때 사용 */
router.get('/:userNum/scraped-courses', async (req, res) => {
  try {
    const { userNum } = req.params;

    const [rows] = await pool.query(`
      SELECT
        c.COURSE_NUM, c.TITLE, c.SUBTITLE, c.CREATED_TIME,
        u.NICKNAME AS author,
        (SELECT COUNT(*) FROM COURSE_SCRAP cs2 WHERE cs2.COURSE_NUM = c.COURSE_NUM) AS scrapCount,
        (SELECT COUNT(*) FROM COURSE_PLACE cp WHERE cp.COURSE_NUM = c.COURSE_NUM) AS placeCount
      FROM COURSE_SCRAP cs
      JOIN COURSES c ON c.COURSE_NUM = cs.COURSE_NUM
      JOIN USER u ON u.USER_NUM = c.USER_NUM
      WHERE cs.USER_NUM = ?
      ORDER BY cs.CREATED_TIME DESC
    `, [userNum]);

    res.json(rows);
  } catch (error) {
    console.error('스크랩 코스 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

/* ── 19) 내가 작성한 질문(게시글) 목록 ── */
/* GET /api/user/:userNum/my-posts */
/* 마이페이지에서 내가 쓴 커뮤니티 글을 보여줄 때 사용 */
router.get('/:userNum/my-posts', async (req, res) => {
  try {
    const { userNum } = req.params;

    const [rows] = await pool.query(`
      SELECT
        b.BOARD_NUM, b.CATEGORY, b.TITLE, b.CONTENT, b.VIEWS, b.CREATED_TIME,
        (SELECT COUNT(*) FROM BOARD_COMMENT bc WHERE bc.BOARD_NUM = b.BOARD_NUM) AS commentCount
      FROM BOARD b
      WHERE b.USER_NUM = ?
      ORDER BY b.CREATED_TIME DESC
    `, [userNum]);

    res.json(rows);
  } catch (error) {
    console.error('내 게시글 조회 에러:', error);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
