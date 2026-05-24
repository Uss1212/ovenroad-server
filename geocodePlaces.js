require('dotenv').config();
const pool = require('./db');
const https = require('https');

const CLIENT_ID = process.env.NAVER_GEOCODING_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_GEOCODING_CLIENT_SECRET;

const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

function geocode(address) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(address);
    const options = {
      hostname: 'maps.googleapis.com',
      path: `/maps/api/geocode/json?address=${query}&key=${GOOGLE_KEY}&language=ko`,
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'OK' && json.results.length > 0) {
            const loc = json.results[0].geometry.location;
            resolve({ lat: loc.lat, lng: loc.lng });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const [rows] = await pool.query(
    'SELECT PLACE_NUM, PLACE_NAME, ADDRESS FROM PLACES WHERE (LATITUDE IS NULL OR LATITUDE = 0) AND ADDRESS IS NOT NULL LIMIT 300'
  );
  console.log(`좌표 없는 빵집: ${rows.length}개`);

  let success = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const { PLACE_NUM, PLACE_NAME, ADDRESS } = rows[i];
    const result = await geocode(ADDRESS);
    if (result) {
      await pool.query('UPDATE PLACES SET LATITUDE = ?, LONGITUDE = ? WHERE PLACE_NUM = ?',
        [result.lat, result.lng, PLACE_NUM]);
      success++;
    } else {
      fail++;
    }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${rows.length} 처리 중... (성공 ${success}, 실패 ${fail})`);
    await sleep(50);
  }

  console.log(`완료! 성공: ${success}, 실패: ${fail}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
