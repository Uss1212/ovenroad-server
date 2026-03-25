/* ===================================================
   빵집 데이터 가져오기 스크립트
   - 노션에서 내보낸 CSV 파일을 읽어서
   - 네이버 Geocoding API로 주소 → 위도/경도 변환
   - MySQL PLACES 테이블에 저장
   =================================================== */

require('dotenv').config();          /* .env 파일에서 환경변수 불러오기 */
const fs = require('fs');           /* 파일 읽기 도구 */
const path = require('path');       /* 파일 경로 도구 */
const pool = require('./db');       /* DB 연결 (db.js에서 가져옴) */

/* --- 카카오 REST API 키 (.env에서 가져옴) --- */
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY;

/* ===================================================
   1단계: CSV 파일 읽기
   - 노션에서 내보낸 CSV를 한 줄씩 읽어서
   - 자바스크립트 객체 배열로 변환
   =================================================== */
function parseCSV(filePath) {
  /* 파일 내용을 텍스트로 읽기 */
  const raw = fs.readFileSync(filePath, 'utf-8');

  /* 줄 단위로 자르기 */
  const lines = raw.split('\n');

  /* 첫 번째 줄은 헤더 (컬럼 이름) */
  /* 가게명,대표메뉴,동네,분류,블루리본 개수,상태,주소,참가자명 */

  /* 결과를 담을 배열 */
  const places = [];

  /* 두 번째 줄부터 데이터 읽기 (i=1부터) */
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    /* 빈 줄이면 건너뛰기 */
    if (!line) continue;

    /* CSV 파싱: 쉼표로 나누되, 쌍따옴표 안의 쉼표는 무시 */
    const fields = parseCSVLine(line);

    /* 가게명이 비어있으면 건너뛰기 (빈 행) */
    const name = fields[0] ? fields[0].trim() : '';
    if (!name) continue;

    /* 주소가 비어있으면 건너뛰기 */
    const address = fields[6] ? fields[6].trim() : '';
    if (!address) continue;

    /* 객체로 만들어서 배열에 추가 */
    places.push({
      name: name,                                          /* 가게명 */
      signature: fields[1] ? fields[1].trim() : '',        /* 대표메뉴 */
      district: fields[2] ? fields[2].trim() : '',         /* 동네 (구) */
      category: fields[3] ? fields[3].trim() : '',         /* 분류 */
      ribbonCount: fields[4] ? parseInt(fields[4]) || 0 : 0, /* 블루리본 개수 */
      address: address,                                    /* 주소 */
    });
  }

  return places;
}

/* --- CSV 한 줄을 필드 배열로 파싱 --- */
/* "쉼표가 포함된 값" 처리를 위해 쌍따옴표를 고려 */
function parseCSVLine(line) {
  const fields = [];        /* 파싱 결과 */
  let current = '';         /* 현재 필드 */
  let inQuotes = false;     /* 쌍따옴표 안인지 여부 */

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      /* 쌍따옴표를 만나면 상태 전환 */
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      /* 쌍따옴표 밖에서 쉼표를 만나면 필드 구분 */
      fields.push(current);
      current = '';
    } else {
      /* 일반 문자는 현재 필드에 추가 */
      current += char;
    }
  }

  /* 마지막 필드 추가 */
  fields.push(current);

  return fields;
}

/* ===================================================
   2단계: 네이버 Geocoding API로 주소 → 좌표 변환
   - 주소를 보내면 위도(latitude), 경도(longitude) 반환
   =================================================== */
async function geocode(address) {
  /* 카카오 Geocoding API 호출 */
  /* 주소를 보내면 위도(y), 경도(x)를 돌려줌 */
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `KakaoAK ${KAKAO_REST_KEY}`,   /* 카카오 인증 헤더 */
    },
  });

  const data = await response.json();

  /* API 응답에서 좌표 꺼내기 */
  if (data.documents && data.documents.length > 0) {
    return {
      latitude: parseFloat(data.documents[0].y),   /* 위도 (y) */
      longitude: parseFloat(data.documents[0].x),   /* 경도 (x) */
    };
  }

  /* 주소 검색 실패 시 키워드 검색으로 재시도 */
  const url2 = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`;
  const response2 = await fetch(url2, {
    headers: {
      'Authorization': `KakaoAK ${KAKAO_REST_KEY}`,
    },
  });
  const data2 = await response2.json();

  if (data2.documents && data2.documents.length > 0) {
    return {
      latitude: parseFloat(data2.documents[0].y),
      longitude: parseFloat(data2.documents[0].x),
    };
  }

  /* 좌표를 못 찾으면 null 반환 */
  console.log(`  ⚠ 좌표 변환 실패: ${address}`);
  return null;
}

/* ===================================================
   3단계: DB에 저장
   - PLACES 테이블에 가게 정보 저장
   - PLACE_CATEGORY 테이블에 분류 저장
   =================================================== */
async function insertToDB(places) {
  let successCount = 0;   /* 성공 개수 */
  let failCount = 0;      /* 실패 개수 */

  for (let i = 0; i < places.length; i++) {
    const place = places[i];
    console.log(`[${i + 1}/${places.length}] ${place.name} 처리 중...`);

    /* --- 주소 → 좌표 변환 --- */
    const coords = await geocode(place.address);

    /* 좌표 변환 실패하면 0, 0으로 저장 (나중에 수정 가능) */
    const lat = coords ? coords.latitude : 0;
    const lng = coords ? coords.longitude : 0;

    try {
      /* --- PLACES 테이블에 저장 --- */
      const [result] = await pool.execute(
        `INSERT INTO PLACES (PLACE_NAME, ADDRESS, LATITUDE, LONGITUDE)
         VALUES (?, ?, ?, ?)`,
        [place.name, place.address, lat, lng]
      );

      /* 방금 저장한 장소의 번호 (자동 생성된 PK) */
      const placeNum = result.insertId;

      /* --- PLACE_CATEGORY 테이블에 분류 저장 --- */
      if (place.category) {
        await pool.execute(
          `INSERT INTO PLACE_CATEGORY (PLACE_NUM, CATEGORY_NAME, RIBBON_COUNT)
           VALUES (?, ?, ?)`,
          [placeNum, place.category, place.ribbonCount]
        );
      }

      successCount++;
      console.log(`  ✔ 저장 완료 (위도: ${lat}, 경도: ${lng})`);

    } catch (err) {
      failCount++;
      console.log(`  ✖ 저장 실패: ${err.message}`);
    }

    /* --- API 호출 간격 (0.2초) --- */
    /* 너무 빨리 보내면 API가 차단될 수 있으므로 잠깐 대기 */
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`\n===== 완료 =====`);
  console.log(`성공: ${successCount}개`);
  console.log(`실패: ${failCount}개`);
}

/* ===================================================
   실행!
   =================================================== */
async function main() {
  /* --- CSV 파일 경로 --- */
  const csvPath = path.join(
    'C:', 'Users', 'erf', 'Downloads',
    'ea9ea1f2-2eec-4f4b-9792-dbd09646830e_ExportBlock-b5e7e7be-a394-45b4-a277-fcc25978594d',
    'ExportBlock-b5e7e7be-a394-45b4-a277-fcc25978594d-Part-1',
    '베이커리 리스트 정리 31e804d2d658801792b3c20e2c6ec640_all.csv'
  );

  console.log('===== 빵집 데이터 가져오기 시작 =====\n');

  /* 1단계: CSV 읽기 */
  console.log('1단계: CSV 파일 읽는 중...');
  const places = parseCSV(csvPath);
  console.log(`  → ${places.length}개 빵집 발견!\n`);

  /* 2단계 + 3단계: 좌표 변환 + DB 저장 */
  console.log('2단계: 좌표 변환 + DB 저장 중...\n');
  await insertToDB(places);

  /* DB 연결 종료 */
  await pool.end();
  console.log('\nDB 연결 종료. 끝!');
}

/* 실행 */
main().catch(err => {
  console.error('오류 발생:', err);
  process.exit(1);
});
