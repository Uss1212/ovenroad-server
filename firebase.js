/* ===================================================
   Firebase Storage 설정
   - 이미지 파일을 Firebase Storage에 업로드하는 도구
   - 업로드 후 공개 URL을 돌려줌
   =================================================== */

const admin = require('firebase-admin');

/* --- Firebase 초기화 --- */
/* 환경변수(FIREBASE_SERVICE_ACCOUNT)에서 서비스 계정 키를 가져옴 */
/* 환경변수가 없으면 로컬의 json 파일을 사용 (개발용) */
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./firebase-service-account.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  /* Storage 버킷 주소 (Firebase 콘솔 → Storage에서 확인 가능) */
  storageBucket: 'ovenroad-a0dc3.firebasestorage.app',
});

/* --- Storage 버킷 가져오기 --- */
const bucket = admin.storage().bucket();

/* --- 이미지 업로드 함수 --- */
/* buffer: 이미지 파일 데이터 (Buffer) */
/* fileName: 저장할 파일 이름 (예: 'places/bread1.jpg') */
/* mimeType: 파일 종류 (예: 'image/jpeg') */
async function uploadToFirebase(buffer, fileName, mimeType) {
  /* Firebase Storage에 파일 만들기 */
  const file = bucket.file(fileName);

  /* 파일 업로드 */
  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
    },
  });

  /* 파일을 누구나 볼 수 있게 공개 설정 */
  await file.makePublic();

  /* 공개 URL 만들어서 돌려줌 */
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
  return publicUrl;
}

module.exports = { bucket, uploadToFirebase };
