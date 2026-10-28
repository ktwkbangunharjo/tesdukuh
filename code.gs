/**
 * ============================================================
 * BACKEND API — SISTEM SELEKSI CALON DUKUH
 * File: code.gs (Full Fixed v3)
 * 
 * Endpoint:
 *   GET  ?action=getQuestions   → soal kuis (sanitasi kunci)
 *   GET  ?action=getPidato      → teks pidato Jawa
 *   GET  ?action=verify&id=xxx  → verifikasi submission
 *   GET  ?action=ping           → health check
 *   POST (body JSON)            → simpan nilai (idempotent)
 * ============================================================
 */

// ============================================================
// 1. KONFIGURASI
// ============================================================
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  || '19o52STHuFNWE9M48Y1JdZOtVR2cYROEyYwfuC14iotQ';

const SHEET_SOAL   = 'BankSoal';
const SHEET_HASIL  = 'HasilUjian';
const SHEET_PIDATO = 'TeksPidato';

const USE_CACHE        = true;
const CACHE_TTL_SEC    = 60;       // detik
const VERIFY_SCAN_ROWS = 100;      // jumlah baris terakhir yang di-scan untuk verify
const MAX_NAME_LENGTH  = 150;

// Schema resmi (auto-migrasi jika kolom belum ada)
const HEADERS_SOAL   = ['No','Kategori','Pertanyaan','OpsiA','OpsiB','OpsiC','OpsiD','Kunci','Pembahasan','Tipe','Paket'];
const HEADERS_HASIL  = ['Timestamp','Nama Peserta','Kuis','Ketik Word','Tabel Excel','Presentasi PPT','Pidato Jawa','Simulasi Rapat','Wawancara','Psikologi','Paket','SubmissionId'];
const HEADERS_PIDATO = ['ID','Judul','Teks_Lengkap'];

// ============================================================
// 2. HELPER — SPREADSHEET & SHEET
// ============================================================
function getSpreadsheet() {
  if (!SPREADSHEET_ID ||
      SPREADSHEET_ID === 'MASUKKAN_ID_SPREADSHEET_ANDA_DI_SINI' ||
      SPREADSHEET_ID.length < 20) {
    throw new Error("SPREADSHEET_ID belum diisi di code.gs (atau via Script Properties).");
  }
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    throw new Error("Gagal membuka Spreadsheet (ID salah / tidak ada akses). Detail: " + e.message);
  }
}

function getOrCreateSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight("bold").setBackground("#d9d9d9");
    try { sheet.setFrozenRows(1); } catch (e) {}
  }
  return sheet;
}

/**
 * Pastikan semua expected headers ada. Yang belum ada ditambahkan di kolom kanan.
 * Data lama tidak disentuh.
 */
function ensureHeaders(sheet, expectedHeaders) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 1);

  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders])
      .setFontWeight("bold").setBackground("#d9d9d9");
    try { sheet.setFrozenRows(1); } catch (e) {}
    return;
  }

  const currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h).trim());

  let nextCol = lastCol + 1;
  expectedHeaders.forEach(h => {
    if (currentHeaders.indexOf(h) === -1) {
      sheet.getRange(1, nextCol).setValue(h)
        .setFontWeight("bold").setBackground("#d9d9d9");
      nextCol++;
    }
  });
}

function readSheetAsObjects(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { headers: [], rows: [] };

  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = data[0].map(h => String(h).trim());
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const obj = {};
    headers.forEach((h, j) => { obj[h] = data[i][j]; });
    obj.__rowIndex = i + 1; // 1-based physical row
    rows.push(obj);
  }
  return { headers, rows };
}

// ============================================================
// 3. HELPER — SANITASI
// ============================================================
function safeString(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Parse kunci jawaban PG → index 0-3, atau null jika tidak bisa diresolusi.
 */
function parseAnswerKey(raw, options) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (typeof raw === 'number') {
    const n = Math.floor(raw);
    if (n >= 0 && n <= 3) return n;
  }

  const str = String(raw).trim();
  if (!str) return null;

  // Format "0"-"3"
  if (/^[0-3]$/.test(str)) return parseInt(str, 10);

  // Format "A", "B.", "C)", "D "
  if (/^[A-D][\.\)\s]*$/i.test(str)) {
    return ['A','B','C','D'].indexOf(str.charAt(0).toUpperCase());
  }

  // Format teks panjang → cocokkan dengan opsi
  const clean = s => String(s).toUpperCase()
    .replace(/^[A-D][\.\)\s]*/, '')
    .replace(/[^A-Z0-9]/g, '');

  const cleanKey = clean(str);
  if (!cleanKey) return null;

  // Exact match
  let idx = options.findIndex(o => clean(o) === cleanKey);
  if (idx !== -1) return idx;

  // Contains match (fallback)
  idx = options.findIndex(o => {
    const co = clean(o);
    if (!co) return false;
    return co.includes(cleanKey) || cleanKey.includes(co);
  });
  if (idx !== -1) return idx;

  return null;
}

function sanitizeScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ============================================================
// 4. HELPER — RESPONSE
// ============================================================
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg, extra) {
  return jsonResponse(Object.assign({ error: String(msg) }, extra || {}));
}

// ============================================================
// 5. GET ENDPOINTS
// ============================================================
function doGet(e) {
  if (!e || !e.parameter) {
    return jsonResponse({ status: "API Aktif", ts: new Date().toISOString() });
  }

  const action = String(e.parameter.action || '').trim();

  try {
    if (action === 'getQuestions') return handleGetQuestions();
    if (action === 'getPidato')    return handleGetPidato();
    if (action === 'verify')       return handleVerify(e.parameter.id);
    if (action === 'ping')         return handlePing();
    return errorResponse("Action tidak dikenali: " + action);
  } catch (err) {
    console.error('[doGet] Error:', err);
    return errorResponse(err.message || String(err));
  }
}

// ---------- 5.1 getQuestions ----------
function handleGetQuestions() {
  const cache = (USE_CACHE && typeof CacheService !== 'undefined')
    ? CacheService.getScriptCache()
    : null;
  const cacheKey = 'bs_v3';

  if (cache) {
    try {
      const cached = cache.get(cacheKey);
      if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
    } catch (e) { /* cache read failure = non-fatal */ }
  }

  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_SOAL, HEADERS_SOAL);
  ensureHeaders(sheet, HEADERS_SOAL);

  const { headers, rows } = readSheetAsObjects(sheet);
  if (rows.length === 0) throw new Error("Sheet 'BankSoal' kosong (tidak ada data).");

  const idx = h => headers.indexOf(h);
  const iTipe  = idx('Tipe');
  const iKunci = idx('Kunci');
  const iPemb  = idx('Pembahasan');
  const iPaket = idx('Paket');
  const iNo    = idx('No');
  const iKat   = idx('Kategori');
  const iQuest = idx('Pertanyaan');

  const questions = [];
  let skipped = 0;

  rows.forEach((row, ri) => {
    const pertanyaan = safeString(row['Pertanyaan']).trim();
    if (!pertanyaan) { skipped++; return; }

    const tipe = (iTipe !== -1 ? safeString(row['Tipe']) : 'pg').trim().toLowerCase() || 'pg';
    const options = [
      safeString(row['OpsiA']),
      safeString(row['OpsiB']),
      safeString(row['OpsiC']),
      safeString(row['OpsiD'])
    ];

    const rawKey = iKunci !== -1 ? row['Kunci'] : '';

    let answer;
    if (tipe === 'uraian') {
      answer = safeString(rawKey).trim();
    } else {
      // PG: wajib resolve jadi index 0-3
      if (options.filter(o => o.trim()).length < 2) { skipped++; return; }
      const parsed = parseAnswerKey(rawKey, options);
      if (parsed === null) {
        console.warn(`[getQuestions] Baris ${row.__rowIndex} ("${pertanyaan.slice(0,40)}...") kunci tidak bisa di-resolve. Skipped.`);
        skipped++;
        return;
      }
      answer = parsed;
    }

    questions.push({
      no:          iNo !== -1 && row['No'] !== '' ? row['No'] : (ri + 1),
      category:    iKat !== -1 ? safeString(row['Kategori']).trim() || 'Umum' : 'Umum',
      question:    pertanyaan,
      options,
      answer,
      explanation: iPemb !== -1 ? safeString(row['Pembahasan']).trim() : '',
      tipe,
      paket:       iPaket !== -1 ? safeString(row['Paket']).trim() : ''
    });
  });

  if (questions.length === 0) {
    throw new Error(`Tidak ada soal valid di 'BankSoal' (${skipped} baris di-skip karena format tidak valid).`);
  }

  const payload = JSON.stringify(questions);

  if (cache) {
    try { cache.put(cacheKey, payload, CACHE_TTL_SEC); } catch (e) {}
  }

  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 5.2 getPidato ----------
function handleGetPidato() {
  const cache = (USE_CACHE && typeof CacheService !== 'undefined')
    ? CacheService.getScriptCache()
    : null;
  const cacheKey = 'pd_v3';

  if (cache) {
    try {
      const cached = cache.get(cacheKey);
      if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
    } catch (e) {}
  }

  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_PIDATO, HEADERS_PIDATO);

  const { rows } = readSheetAsObjects(sheet);
  const result = [];
  rows.forEach(row => {
    const id   = safeString(row['ID']).trim();
    const teks = safeString(row['Teks_Lengkap']);
    if (!id || !teks.trim()) return;
    result.push({
      id,
      judul: safeString(row['Judul']).trim() || ('Pidato ' + id),
      teks
    });
  });

  const payload = JSON.stringify(result);
  if (cache) { try { cache.put(cacheKey, payload, CACHE_TTL_SEC); } catch (e) {} }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 5.3 verify ----------
function handleVerify(submissionId) {
  const id = safeString(submissionId).trim();
  if (!id) return jsonResponse({ success: false, error: 'Parameter id wajib.' });

  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_HASIL, HEADERS_HASIL);
  ensureHeaders(sheet, HEADERS_HASIL);

  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return jsonResponse({ success: false, reason: 'empty' });

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h).trim());
  const idxId = headers.indexOf('SubmissionId');
  if (idxId === -1) return jsonResponse({ success: false, error: 'Kolom SubmissionId tidak ditemukan. Jalankan ensureHeaders.' });

  const scanFrom = Math.max(2, lastRow - (VERIFY_SCAN_ROWS - 1));
  const numRows  = lastRow - scanFrom + 1;
  if (numRows <= 0) return jsonResponse({ success: false, reason: 'no_rows' });

  const data = sheet.getRange(scanFrom, 1, numRows, lastCol).getValues();

  // Scan dari bawah (kemungkinan besar submission terbaru)
  for (let i = data.length - 1; i >= 0; i--) {
    if (safeString(data[i][idxId]).trim() === id) {
      return jsonResponse({ success: true, row: scanFrom + i });
    }
  }
  return jsonResponse({ success: false, reason: 'not_found' });
}

// ---------- 5.4 ping ----------
function handlePing() {
  return jsonResponse({ success: true, ts: Date.now(), iso: new Date().toISOString() });
}

// ============================================================
// 6. POST — SIMPAN NILAI
// ============================================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ result: 'error', error: 'Tidak ada data yang diterima.' });
    }

    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse({ result: 'error', error: 'Body bukan JSON valid.' });
    }

    if (!data || typeof data !== 'object') {
      return jsonResponse({ result: 'error', error: 'Payload tidak valid.' });
    }

    const nama = safeString(data.nama).trim();
    if (!nama) return jsonResponse({ result: 'error', error: 'Nama peserta kosong.' });
    if (nama.length > MAX_NAME_LENGTH) {
      return jsonResponse({ result: 'error', error: 'Nama terlalu panjang (maks ' + MAX_NAME_LENGTH + ').' });
    }

    const submissionId = safeString(data.submissionId).trim() ||
      ('srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));

    const ss = getSpreadsheet();
    const sheet = getOrCreateSheet(ss, SHEET_HASIL, HEADERS_HASIL);
    ensureHeaders(sheet, HEADERS_HASIL);

    // --- Idempotency: skip jika submissionId sudah ada di 100 baris terakhir ---
    const dupCheck = handleVerify(submissionId);
    const dupObj = JSON.parse(dupCheck.getContent());
    if (dupObj && dupObj.success) {
      return jsonResponse({ result: 'success', duplicated: true, submissionId });
    }

    // --- Bangun row sesuai urutan header aktual ---
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim());
    const row = new Array(headers.length).fill('');

    const values = {
      'Timestamp':      new Date(),
      'Nama Peserta':   nama,
      'Kuis':           sanitizeScore(data.kuis),
      'Ketik Word':     sanitizeScore(data.word),
      'Tabel Excel':    sanitizeScore(data.excel),
      'Presentasi PPT': sanitizeScore(data.presentasi),
      'Pidato Jawa':    sanitizeScore(data.pidato),
      'Simulasi Rapat': sanitizeScore(data.rapat),
      'Wawancara':      sanitizeScore(data.wawancara),
      'Psikologi':      sanitizeScore(data.psikologi),
      'Paket':          safeString(data.paket).trim(),
      'SubmissionId':   submissionId
    };

    headers.forEach((h, i) => {
      if (h in values) row[i] = values[h];
    });

    sheet.appendRow(row);

    return jsonResponse({
      result: 'success',
      submissionId,
      row: sheet.getLastRow()
    });

  } catch (err) {
    console.error('[doPost] Error:', err);
    return jsonResponse({ result: 'error', error: err.message || String(err) });
  }
}

// ============================================================
// 7. ADMIN — SETUP & MAINTENANCE (jalankan manual dari editor)
// ============================================================

/**
 * Inisialisasi semua sheet + header. Jalankan sekali setelah spreadsheets dibuat.
 */
function setupSpreadsheet() {
  const ss = getSpreadsheet();
  getOrCreateSheet(ss, SHEET_SOAL,   HEADERS_SOAL);
  getOrCreateSheet(ss, SHEET_HASIL,  HEADERS_HASIL);
  getOrCreateSheet(ss, SHEET_PIDATO, HEADERS_PIDATO);
  ensureHeaders(ss.getSheetByName(SHEET_SOAL),   HEADERS_SOAL);
  ensureHeaders(ss.getSheetByName(SHEET_HASIL),  HEADERS_HASIL);
  ensureHeaders(ss.getSheetByName(SHEET_PIDATO), HEADERS_PIDATO);
  SpreadsheetApp.getUi().alert("✅ Setup selesai. Semua sheet & header siap.");
}

/**
 * Bagi soal ke 5 paket seimbang per kategori (round-robin).
 * Paket dipakai client untuk anti-nyontek (random paket per sesi).
 */
function bagiSoalKe5Paket() {
  const JUMLAH_PAKET = 5;
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SOAL);
  if (!sheet) return SpreadsheetApp.getUi().alert("Sheet BankSoal tidak ditemukan.");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return SpreadsheetApp.getUi().alert("Bank soal kosong.");

  ensureHeaders(sheet, HEADERS_SOAL);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(h => String(h).trim());
  const idxPaket    = headers.indexOf('Paket');
  const idxTipe     = headers.indexOf('Tipe');
  const idxKategori = headers.indexOf('Kategori');
  const idxPertanyaan = headers.indexOf('Pertanyaan');

  if (idxPaket === -1) return SpreadsheetApp.getUi().alert("Header 'Paket' tidak ditemukan.");
  if (idxTipe === -1)  return SpreadsheetApp.getUi().alert("Header 'Tipe' tidak ditemukan.");

  const pgIdx = [], urIdx = [];
  for (let i = 1; i < data.length; i++) {
    if (!safeString(data[i][idxPertanyaan]).trim()) continue;
    const tipe = (safeString(data[i][idxTipe]) || 'pg').toLowerCase();
    if (tipe === 'uraian') urIdx.push(i);
    else pgIdx.push(i);
  }

  function assignPerKategori(indices) {
    const perCat = {};
    indices.forEach(i => {
      const cat = (idxKategori !== -1 ? safeString(data[i][idxKategori]) : '').trim() || 'Umum';
      (perCat[cat] = perCat[cat] || []).push(i);
    });
    const assign = {};
    Object.values(perCat).forEach(list => {
      list.forEach((rowIdx, j) => {
        assign[rowIdx] = (j % JUMLAH_PAKET) + 1;
      });
    });
    return assign;
  }

  const assignPG = assignPerKategori(pgIdx);
  const assignUR = assignPerKategori(urIdx);
  const paketCol = idxPaket + 1;

  for (let i = 1; i < data.length; i++) {
    let paket = '';
    if (assignPG[i] !== undefined) paket = assignPG[i];
    else if (assignUR[i] !== undefined) paket = assignUR[i];
    sheet.getRange(i + 1, paketCol).setValue(paket);
  }

  SpreadsheetApp.getUi().alert(`✅ Pembagian selesai: ${pgIdx.length} PG + ${urIdx.length} Uraian dibagi ke ${JUMLAH_PAKET} paket.`);
}

/**
 * Setup sheet TeksPidato dengan 5 teks pidato Bahasa Jawa.
 * PERINGATAN: akan menimpa sheet yang sudah ada.
 */
function setupTeksPidatoOtomatis() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    'Konfirmasi',
    'Sheet TeksPidato akan DIBUAT ULANG dan teks lama akan HILANG. Lanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_PIDATO);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(SHEET_PIDATO);
  sheet.getRange(1, 1, 1, 3).setValues([HEADERS_PIDATO])
    .setFontWeight("bold").setBackground("#d9d9d9");
  try { sheet.setFrozenRows(1); } catch (e) {}

  const dataPidato = [
    ["sambutan_rapat", "Pidato Sambutan Rapat Warga",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Alhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal mursalin. Amma ba'du.
Dhumateng Bapak Lurah, para Pamong Kalurahan, Ketua RT/RW, lan sedoyo warga ingkang kinurmatan.
Sumangga kita sedaya tansah ngunjukaken raos puji syukur dhumateng Gusti Allah SWT, amargi ing dinten menika kita saged kempal wonten ing Musyawarah Padukuhan menika kanthi wilujeng.
Wosing gati rapat menika inggih menika mrembag babagan rencana pembangunan lingkungan lan penertiban keamanan warga. Kula minangka Dukuh ngaturaken agunging panuwun dhumateng panjenengan sedaya ingkang sampun kersa rawuh.
Mugi-mugi sedaya ingkang kita rembag ing dinten menika saged paring manfaat lan keberkahan dhumateng kita sedaya. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`],

    ["ahli_waris", "Atur Wakil Ahli Waris (Takziah)",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Innalillahi wa inna ilaihi raji'un.
Alhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal mursalin, wa 'ala alihi wa shahbihi ajma'in. Amma ba'du.
Dhumateng para sesepuh, pinisepuh ingkang tansah dahat kinabekten.
Dhumateng para takziyah, para tangga teparo, dalah para rawuh sedaya ingkang winantu ing pakurmatan.
Kula minangka sesulih utawi wakilipun kulawarga ageng ahli waris saking almarhum Bapak Harjo Sunarto, kanthi raos sedhih lan pasrah, keparenga matur wonten ngarsa panjenengan sedaya.
Ingkang kapisan, minangka titah sawantah, sumangga kita tansah ngunjukaken raos puji syukur wonten ngarsanipun Gusti Allah SWT. Dene ing kalodhangan menika kita saged kempal manunggal wonten ing dalem duka Dusun Kaliurang mriki, nindakaken kuwajiban sesarengan nguntapaken jenazah, kanthi wilujeng nir ing sambekala.
Para rawuh ingkang kinurmatan,
Gusti Allah Ingkang Maha Kuwaos sampun ngresersaken, bilih ing dinten Kaping Pisan (Minggu) kepengkur, pinanggal 25 Oktober 2026, wanci jam 19.30 WIB, sederek kita, sepuh kita, inggih almarhum Bapak Harjo Sunarto sampun tinimbalan sowan wonten ngarsanipun Gusti Ingkang Maha Kawasa, kanthi tentrem ing yuswa 76 taun.
Kula minangka pangarsaning dhusun utawi Dukuh wonten ing mriki, ngaturaken matur nuwun ingkang tanpa upami dhumateng panjenengan sedaya, para tangga teparo, lan para takziyah ingkang sampun kersa rawuh. Matur nuwun sanget awit saking pambiyantu panjenengan sedaya, arupi wragad, tanaga, penggalihan, menapa dene donga pamuji ingkang sampun dipun-paringaken kagem almarhum lan ahli waris. Mugi-mugi sedaya amal kesaenan panjenengan dipunwales dening Gusti Allah kanthi berkah ingkang tikel matikel.
Ingkang kaping kalih, kula minangka wakilipun ahli waris, kanthi andhap asoring manah nyuwun agunging samudrasih pangaksama saking panjenengan sedaya. Mbok bilih ing wekdal gesangipun almarhum Bapak Harjo Sunarto kagadhah kalepatan, tindak-tanduk ingkang kirang mranani, utawi muna-muni ingkang nglarani penggalih panjenengan sedaya, mugi kersa paring pangapunten ingkang tulus lan ikhlas.
Ugi babagan dunya, bilih almarhum taksih kagadhah urusan utang-piutang menapa dene jaminan kaliyan panjenengan sedaya, kasuwun panjenengan kersa sesambungan kaliyan ahli waris sasampunipun adicara menika, supados sedaya urusan saged dipun-rampungaken kanthi sae lan almarhum saged bidhal kanthi entheng.
Para rawuh ingkang sinuba ing pakurmatan,
Sekedhap malih, jenazah almarhum badhe dipun-angkat lan dipun-makamaken wonten ing Makam Sasanalaya Dusun Kaliurang. Pramila, kula nyuwun donga pamuji saking panjenengan sedaya, mugi-mugi almarhum dipun-tampi sedaya amal kesaenanipun, dipun-apunten sedaya dosanipun, dipun-paringi papan ingkang padhang lan jembar, sarta husnul khatimah. Kagem kulawarga ingkang dipun-tinggal, mugi dipun-paringi ketabahan, kesabaran, lan keikhlasan.
Pungkasaning atur saking kula minangka wakil ahli waris, mbok bilih wonten kiranging aruh, lungguh, lan suguh ingkang boten mranani penggalih panjenengan sedaya, kula nyuwun agunging pangapunten.
Mugi Gusti Allah tansah njangkung lampah kita sedaya. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`],

    ["budaling", "Budaling Lelayon (Takziah)",
`Ass. Wr. Wb
Bismillahirohmanirrohim
Alhamdulillahi robbil alamin wassolatu wa salamu alla asyrofil anbiya i wal mursalin, wa alla alihi wa sohbihi aj main. Amma ba'du
Nyuwun panjenenganipun poro sepuh pini sepuh ingkang kinabekten, linangkung bapak Lurah Bangunharjo, Bapak Nur Hidayat Sag Msi ingkang tansah kinurmatan, ibu RT 1, bapak RT 02, bapak RT 08&9 jotawang, tokoh masyarakat, Simbah kaum Rois lan sagung poro takziah kakung soho putri ingkang tansah kulo hormati.
Pinongko purwakaning atur, sumawi kulo derekaken manengku pujo wonten ngarso dalem allah ta'alla. Ingkang tansah soho taseh paring rahmat, hidayah soho inayahipun
Rahmat soho salam mugi karentahno dumateng junjungan kito nabi agung muhammad SAW sak garwo putro soho penderekipun ingkang tansah kito antu2 syafaatipun wonten ing yaumul qiyamah sak mangke.
Sak lajengipun, sedoyo ahli waris, hangaturaken pambagyo kawilujengan sugeng rawuh soho ngaturaken sanget agunging panuwun ingkang tanpo pepindan, Dene panjengan sami sampun kepareng hangentengaken saliro, mijiaken wekdal rawuh inggih kejawi nglaeraken raos sungkowo, ugi paring pakurmatan ingkang pungkasan dumateng almarhum bapak Herlan Setiabudi
Sagung poro takziah ingkang minulyo, atur uningo bilih ing dinten Jumat pon, suryo kaping 18 wulan september warso 2026 kirang langkung tabuh 04.15 enjing, panjenganipun almarhum bapak Herlan Setiabudi tinimbalan sowan wonten ngarsa dalem Allah ta'ala.
Sedanipun almarhum pinaringan ganjaran yuswo kirang langkung 62 th. (Kanti nilar garwo 1, Putro putrinipun 3,) Pramilo kanti puniko nyuwun panjurung dongo dumateng poro takziah kakung soho putri amrih sowanipun almarhum bapak Herlan Setiabudi wonten ngarsanipun gusti Allah dipun tampi sedoyo amal kesaenanipun, dipun apunten sedoyo doso kalepatanipun pinaringan padang jembar kuburipun lan ugi sedanipun kalebetno sedo ingkang husnul khotimah Aamiin 3x YRA.
(Pramilo kanti meniko mbok bilih rikolo sugengipun almarhum anggenipun sesrawungan dumateng panjenengan pinanggih bab2 ingkang dereng karampungaken, sae puniko sambet sinambet soho hak2 adami, panjenengan saget irembakan kaliyan sedoyo ahli warisipun.
Ewo semanten mbok bilih sampun kaikhlasaken lajeng karelaken sedoyo ahli waris namung saget ngaturaken sanget agunging panuwun.)
Sagung poro takziah ingkang minulyo, wonten ing kalodangan puniko mboten kesupen, sedoyo ahli waris ugi ngaturaken sanget agunging panuwun dumateng tonggo tepalih, sanak kadang, pamong mitro, ingkang sampun kepareng paring pambiantu ingkang awujud nopo kemawon.
Pinongko pungkasaning atur, nyuwun dumateng panjenengan kerso derekaken lampahing jenazah ingkang sak mangke dipun sareaken ing makam suci Salakan jotawang, Bangunharjo Sewon bantul..
Ewo semanten, ingkang gadahi sesanggeman sanes, lajeng enggal2 bade ngersa'aken kondur sedoyo ahli waris ngaturaken sugeng kondur mugi tansah rahayu ingkang pinanggih.
Soho anggenipun nampi karawuhan panjenengan sami bilih wonten kirangipun karono kawontenan ahli waris nyuwun agunging Samudro pangaksami.
Poro takziah kakung soho putri mekaten aturipun ahli waris almarhum lumantar kulo, mbok bilih anggenipun kulo matur pinanggih lepat ing mriki kulo nyuwun agunging pangapunten.
Akhiruk kalam Assalammu alaikum wr.wb`],

    ["pasrah", "Atur Pasrah Penganten (Pawiwahan)",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Alhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal morsalin, wa 'ala alihi wa shahbihi ajma'in. Amma ba'du.
Dhumateng para sesepuh, pinisepuh ingkang tansah dahat kinabekten.
Dhumateng kulawarga ageng Bapak Harjo Sunarto ingkang satuhu kinurmatan. Mligi dhumateng Bapak Dukuh Mangunsuwito saking Dusun Kaliurang ingkang sinudarsana.
Kula, minangka sesulih utawi wakilipun Bapak kaliyan Ibu Hardi Wibowo saking Dusun Kasongan, Kasihan, Bantul, keparenga matur wonten ngarsa panjenengan sedaya.
Ingkang kapisan, sumangga kita tansah ngaturaken raos syukur dhumateng Gusti Allah SWT, ingkang sampun paring kesarasan lan kalodhangan, saengga kita saged kempal manunggal wonten ing adicara pawiwahan menika kanthi wilujeng nir ing sambekala.
Ingkang kaping kalih, kula ngaturaken salam taklimipun Bapak kaliyan Ibu Hardi Wibowo katur dhumateng Bapak kaliyan Ibu Harjo Sunarto sakulawarga, kanthi pamuji mugi-mugi keslametan lan kabagyan tansah kajiwa kasasar dhumateng kita sedaya.
Para rawuh ingkang kinurmatan,
Wosing gati utawi tujuwan sowan kula sakanca ing mriki, inggih menika nindakaken amanah pasrah penganten. Kula pasrahaken dhumateng kulawarga mriki, bilih anak mas Bagus Purnomo ingkang sampun nindakaken akad nikah, kanthi tulus ikhlasing manah kersaa dipunwengku lan dipuntampi dados kulawarga ageng wonten ing Dusun Kaliurang mriki.
Minangka mudha-mudhi ingkang nembe ngancik dunya bebrayan, anak mas Bagus Purnomo menika taksih kirang pengalamanipun, taksih kathah kekiranganipun, lan taksih mbetahaken bimbingan. Mligi kagem Bapak Dukuh Mangunsuwito ing mriki lan para sesepuh, kula titip anak kula menika supados dipun-didik, dipun-arahaken, saengga saged dados warga dusun ingkang sae, saged manunggal kaliyan masyarakat, lan saged mbangun kulawarga ingkang sakinah, mawaddah, warahmah.
Kanthi tulus ikhlas, mangga penganten putra menika dipungandheng kaliyan penganten putri, dipunbimbing sesarengan wonten ing margining kabagyan.
Ingkang pungkasan, kula sakulawarga saking Dusun Kasongan nyuwun agunging samudrasih pangaksama, mbok bilih wonten tindak-tanduk, muna-muni, utawi tata krami sowan kula sakanca ingkang kirang mranani penggalih panjenengan sedaya.
Mugi Gusti Allah SWT tansah njangkung lan ngijabahi niat sae kita sedaya. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`],

    ["tampi", "Atur Nampi Penganten (Pawiwahan)",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Bismillah walhamdulillah, washalahtu wasalamu 'ala rasulillah, sayyidina Muhammadin wa 'ala alihi wa sahbihi ajma'in. Amma ba'du.
Dhumateng para sesepuh, pinisepuh ingkang satuhu pantes sinudarsana.
Dhumateng Bapak Dukuh Sujatmiko saking Dusun Kasongan, Bantul dalah para pengombyong penganten putra ingkang agung kasatriyanipun.
Serta kulawarga ageng Bapak kaliyan Ibu Harjo Sunarto ingkang bagya mulya.
Kula minangka sesulih utawi wakil saking kulawarga ageng Bapak Harjo Sunarto, ugi minangka pangarsaning dhusun utawi Dukuh wonten ing Kaliurang mriki, keparenga amangsuli atur pasrah ingkang sampun dipun-andharaken kanthi cetha wela-wela dhumateng kita sedaya.
Ingkang kapisan, sumangga kita sesarengan ngaturaken puja lan puji syukur wonten ngarsanipun Gusti Ingkang Maha Agung, amargi kanthi rahmat lan hidayah-Ipun, rombongan penganten putra saged rawuh kanthi binerkahan keslametan, boten wonten alangan satunggal menika.
Ingkang kaping kalih, kula nampi salam taklimipun saking Bapak kaliyan Ibu Hardi Wibowo saking Dusun Kasongan. Kula wangsuli kanthi salam taklim ingkang sami, mugi sesambungan paseduluran ingkang sae menika saged tansah rumaket ngantos akhir jaman.
Para rawuh ingkang sinuba ing pakurmatan,
Ngenani wosing gati pasrah panjenengan, kula minangka wakil kulawarga lan minangka pamong wonten ing Dusun Kaliurang mriki, kanthi thukul ikhlasing manah, nampi kanthi asta kalih lan gumbiranipun penggalih pasrah penganten putra, inggih anak mas Bagus Purnomo.
Mulai detik menika, anak mas Bagus Purnomo sampun resmi dados perangan saking kulawarga ageng Bapak Harjo Sunarto, lan ugi sah dados warga dhusun kita wonten ing mriki.
Babagan bimbingan lan pituduh ingkang dipun-kersaken wau, sampun dados kuwajiban kita sedaya minangka tiyang sepuh lan pamong. Kita badhe sesarengan njagi, ngarahaken, lan ndedonga, mugi-mugi penganten kekalih, anak mas Bagus Purnomo lan anak roro Siti Rahayu, saged nyawiji, asah, asih, asuh, nemtokaken jangkah ingkang sae, lan saged mbangun kulawarga ingkang bagya mulya, ngantos kaken-kaken ninen-ninen.
Salajengipun, sumangga para tamu pengombyong saking Dusun Kasongan, kula aturi lenggah kanthi sekeca, kanthi mardikaning penggalih, ngrahapi dedhaharan lan pasugatan ingkang sampun dicepakaken, senadyan wontenipun namung prasaja.
Pungkasaning atur, kula minangka wakil mriki nyuwun pangapunten ingkang agung, mbok bilih wonten thithik kuciwaning aruh, lungguh, lan suguh ingkang kirang nengsemaken wonten ing manah panjenengan sedaya.
Mugi-mugi Gusti Allah tansah mberkahi adicara menika. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`]
  ];

  sheet.getRange(2, 1, dataPidato.length, 3).setValues(dataPidato);
  sheet.setColumnWidth(1, 100).setColumnWidth(2, 250).setColumnWidth(3, 700);
  try { sheet.setFrozenRows(1); } catch (e) {}

  SpreadsheetApp.getUi().alert("✅ Sheet TeksPidato dibuat & diisi 5 teks pidato.");
}

// ============================================================
// 8. ADMIN — DIAGNOSTICS
// ============================================================
/**
 * Health check semua endpoint + cek sheet. Jalankan dari editor.
 */
function diagnoseAll() {
  const lines = [];
  lines.push('=== DIAGNOSTIC ===');
  lines.push('Time: ' + new Date().toISOString());

  // 1. Config
  try {
    const ss = getSpreadsheet();
    lines.push('✅ Spreadsheet: ' + ss.getName());
    lines.push('   URL: ' + ss.getUrl());
  } catch (e) {
    lines.push('❌ Spreadsheet: ' + e.message);
    return SpreadsheetApp.getUi().alert(lines.join('\n'));
  }

  // 2. Sheets
  const ss = getSpreadsheet();
  [SHEET_SOAL, SHEET_HASIL, SHEET_PIDATO].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      lines.push('⚠️ Sheet "' + name + '" tidak ada (akan dibuat otomatis saat digunakan).');
    } else {
      lines.push('✅ Sheet "' + name + '": ' + (sh.getLastRow() - 1) + ' baris data, ' + sh.getLastColumn() + ' kolom.');
    }
  });

  // 3. Test endpoints
  try {
    const q = handleGetQuestions();
    const qData = JSON.parse(q.getContent());
    lines.push('✅ getQuestions: ' + qData.length + ' soal');
    if (qData.length > 0) {
      lines.push('   Sample: "' + String(qData[0].question).slice(0, 60) + '..."');
    }
  } catch (e) {
    lines.push('❌ getQuestions: ' + e.message);
  }

  try {
    const p = handleGetPidato();
    const pData = JSON.parse(p.getContent());
    lines.push('✅ getPidato: ' + pData.length + ' teks');
  } catch (e) {
    lines.push('❌ getPidato: ' + e.message);
  }

  try {
    const v = handleVerify('__test_nonexistent__');
    const vData = JSON.parse(v.getContent());
    lines.push('✅ verify: respons valid (' + JSON.stringify(vData) + ')');
  } catch (e) {
    lines.push('❌ verify: ' + e.message);
  }

  lines.push('=== END ===');
  SpreadsheetApp.getUi().alert(lines.join('\n'));
  console.log(lines.join('\n'));
}

/**
 * Reset HasilUjian — hapus semua baris data (header tetap). Dengan konfirmasi.
 */
function resetHasilUjian() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    'KONFIRMASI HAPUS',
    'Semua data nilai di sheet HasilUjian akan DIHAPUS PERMANEN. Header tetap ada. Lanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_HASIL);
  if (!sheet) return ui.alert('Sheet HasilUjian tidak ditemukan.');
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return ui.alert('Sheet sudah kosong (hanya header).');

  sheet.deleteRows(2, lastRow - 1);
  ensureHeaders(sheet, HEADERS_HASIL);
  ui.alert('✅ ' + (lastRow - 1) + ' baris dihapus.');
}

/**
 * Isi SubmissionId untuk baris lama yang belum punya (migrasi).
 */
function backfillSubmissionIds() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_HASIL);
  if (!sheet) return SpreadsheetApp.getUi().alert('Sheet HasilUjian tidak ada.');

  ensureHeaders(sheet, HEADERS_HASIL);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return SpreadsheetApp.getUi().alert('Tidak ada data.');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const idxId = headers.indexOf('SubmissionId');
  if (idxId === -1) return SpreadsheetApp.getUi().alert('Kolom SubmissionId tidak ada.');

  let filled = 0;
  for (let r = 2; r <= lastRow; r++) {
    const cell = sheet.getRange(r, idxId + 1);
    if (!String(cell.getValue()).trim()) {
      cell.setValue('backfill_' + r + '_' + Date.now().toString(36));
      filled++;
    }
  }
  SpreadsheetApp.getUi().alert('✅ Backfill selesai. ' + filled + ' baris diisi SubmissionId.');
}

/**
 * Bersihkan cache (setelah edit BankSoal / TeksPidato).
 */
function clearCache() {
  try {
    CacheService.getScriptCache().remove('bs_v3');
    CacheService.getScriptCache().remove('pd_v3');
    SpreadsheetApp.getUi().alert('✅ Cache dibersihkan. Perubahan akan terlihat pada request berikutnya.');
  } catch (e) {
    SpreadsheetApp.getUi().alert('⚠️ ' + e.message);
  }
}