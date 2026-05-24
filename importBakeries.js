require('dotenv').config();
const fs = require('fs');
const pool = require('./db');

function parseCSV(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headers = lines[0].replace(/^\xEF\xBB\xBF/, '').replace(/^﻿/, '').split(',');
  const rows = [];
  let i = 1;
  while (i < lines.length) {
    let line = lines[i];
    while ((line.match(/\"/g) || []).length % 2 !== 0 && i + 1 < lines.length) {
      i++; line += ' ' + lines[i];
    }
    if (!line.trim()) { i++; continue; }
    const cols = [];
    let cur = '', inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') inQ = !inQ;
      else if (line[c] === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += line[c];
    }
    cols.push(cur.trim());
    const row = {};
    headers.forEach((h, idx) => row[h.trim()] = (cols[idx] || '').trim());
    if (row['가게명']) rows.push(row);
    i++;
  }
  return rows;
}

(async () => {
  try {
    const r1 = parseCSV(fs.readFileSync('/Users/haesol/Downloads/개인 페이지 & 공유된 페이지/베이커리 리스트 정리 31e804d2d658801792b3c20e2c6ec640_all.csv', 'utf-8'));
    const r2 = parseCSV(fs.readFileSync('/Users/haesol/Downloads/개인 페이지 & 공유된 페이지/베이커리 리스트 정리 31e804d2d658801792b3c20e2c6ec640.csv', 'utf-8'));

    // 두 CSV 합치기 - 가게명으로 중복 제거
    const map = new Map();
    for (const r of [...r1, ...r2]) {
      const key = r['가게명'].replace(/\s/g, '').toLowerCase();
      if (!map.has(key)) map.set(key, r);
    }
    const all = [...map.values()];
    console.log(`CSV 총 고유 빵집: ${all.length}개`);

    // DB에 이미 있는 빵집 이름 목록
    const [existing] = await pool.query('SELECT PLACE_NAME FROM PLACES');
    const existingNames = new Set(existing.map(r => r.PLACE_NAME.replace(/\s/g, '').toLowerCase()));
    console.log(`DB 기존 빵집: ${existingNames.size}개`);

    const toInsert = all.filter(r => {
      const name = r['가게명'];
      if (!name || name.startsWith('http') || name.length > 200) return false;
      return !existingNames.has(name.replace(/\s/g, '').toLowerCase());
    });
    console.log(`새로 추가할 빵집: ${toInsert.length}개`);

    let inserted = 0;
    for (const row of toInsert) {
      const name = row['가게명'];
      const address = row['주소'] || '';
      const category = row['분류'] || '';
      const menus = (row['대표메뉴'] || '').split(',').map(m => m.trim()).filter(Boolean);
      const ribbonCount = parseInt(row['블루리본 개수']) || 0;
      const status = row['상태'] || '일반';

      // PLACES 삽입
      const [result] = await pool.query(
        'INSERT INTO PLACES (PLACE_NAME, ADDRESS) VALUES (?, ?)',
        [name, address]
      );
      const placeNum = result.insertId;

      // PLACE_CATEGORY 삽입
      if (category) {
        await pool.query(
          'INSERT INTO PLACE_CATEGORY (PLACE_NUM, CATEGORY_NAME, RIBBON_COUNT, CERTIFICATION) VALUES (?, ?, ?, ?)',
          [placeNum, category, ribbonCount, status]
        );
      }

      // PLACE_MENU 삽입
      for (const menu of menus) {
        await pool.query(
          'INSERT INTO PLACE_MENU (PLACE_NUM, MENU_NAME) VALUES (?, ?)',
          [placeNum, menu]
        );
      }

      inserted++;
      if (inserted % 10 === 0) console.log(`  ${inserted}/${toInsert.length} 삽입 중...`);
    }

    console.log(`완료! ${inserted}개 빵집 추가됨`);
    process.exit(0);
  } catch (e) {
    console.error('에러:', e.message);
    process.exit(1);
  }
})();
