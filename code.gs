/**
 * ============================================================
 * BACKEND API — SISTEM SELEKSI CALON DUKUH
 * File: code.gs (FULL v4 — With Auth)
 *
 * Endpoint GET:
 *   ?action=getQuestions   → soal kuis
 *   ?action=getPidato      → teks pidato Jawa
 *   ?action=verify&id=xxx  → verifikasi submission
 *   ?action=ping           → health check
 *
 * Endpoint POST (?action=...):
 *   register, login, logout, checkSession,
 *   listUsers, approveUser, rejectUser, deleteUser,
 *   getResults, submitScore
 * ============================================================
 */

// ============================================================
// 1. KONFIGURASI
// ============================================================
const SPREADSHEET_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID')
  || '19o52STHuFNWE9M48Y1JdZOtVR2cYROEyYwfuC14iotQ';

const SHEET_SOAL     = 'BankSoal';
const SHEET_HASIL    = 'HasilUjian';
const SHEET_PIDATO   = 'TeksPidato';
const SHEET_USERS    = 'Users';
const SHEET_SESSIONS = 'Sessions';

const USE_CACHE        = true;
const CACHE_TTL_SEC    = 60;
const VERIFY_SCAN_ROWS = 200;
const MAX_NAME_LENGTH  = 150;
const SESSION_TTL_MS   = 1000 * 60 * 60 * 24; // 24 jam

const HEADERS_SOAL     = ['No','Kategori','Pertanyaan','OpsiA','OpsiB','OpsiC','OpsiD','Kunci','Pembahasan','Tipe','Paket'];
const HEADERS_HASIL    = ['Timestamp','Nama Peserta','Kuis','Ketik Word','Tabel Excel','Presentasi PPT','Pidato Jawa','Simulasi Rapat','Wawancara','Psikologi','Paket','SubmissionId','UserID','Username'];
const HEADERS_PIDATO   = ['ID','Judul','Teks_Lengkap'];
const HEADERS_USERS    = ['ID','Username','PasswordHash','Salt','Nama','Email','Role','Status','CreatedAt','ApprovedAt','ApprovedBy','LastLogin'];
const HEADERS_SESSIONS = ['Token','UserID','Username','ExpiresAt','CreatedAt'];

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
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight("bold").setBackground("#d9d9d9");
    try { sheet.setFrozenRows(1); } catch (e) {}
  }
  return sheet;
}

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
    obj.__rowIndex = i + 1;
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

function parseAnswerKey(raw, options) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (typeof raw === 'number') {
    const n = Math.floor(raw);
    if (n >= 0 && n <= 3) return n;
  }

  const str = String(raw).trim();
  if (!str) return null;
  if (/^[0-3]$/.test(str)) return parseInt(str, 10);
  if (/^[A-D][\.\)\s]*$/i.test(str)) return ['A','B','C','D'].indexOf(str.charAt(0).toUpperCase());

  const clean = s => String(s).toUpperCase()
    .replace(/^[A-D][\.\)\s]*/, '')
    .replace(/[^A-Z0-9]/g, '');

  const cleanKey = clean(str);
  if (!cleanKey) return null;

  let idx = options.findIndex(o => clean(o) === cleanKey);
  if (idx !== -1) return idx;

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
  return jsonResponse(Object.assign({ result: 'error', error: String(msg) }, extra || {}));
}

// ============================================================
// 5. HELPER — AUTH
// ============================================================
function hashPassword(password, salt) {
  const raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password + '|' + salt,
    Utilities.Charset.UTF_8
  );
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function generateSalt()  { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function generateToken() { return Utilities.getUuid().replace(/-/g, '') + Date.now().toString(36); }

function getUsersSheet() {
  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_USERS, HEADERS_USERS);
  ensureHeaders(sheet, HEADERS_USERS);
  return sheet;
}

function getSessionsSheet() {
  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_SESSIONS, HEADERS_SESSIONS);
  ensureHeaders(sheet, HEADERS_SESSIONS);
  return sheet;
}

function findUserByUsername(username) {
  const uname = String(username).toLowerCase().trim();
  const { rows } = readSheetAsObjects(getUsersSheet());
  return rows.find(r => String(r['Username']).toLowerCase() === uname);
}

function findUserById(id) {
  const { rows } = readSheetAsObjects(getUsersSheet());
  return rows.find(r => String(r['ID']) === String(id));
}

function validateSession(token) {
  if (!token) return null;
  const { rows } = readSheetAsObjects(getSessionsSheet());
  const now = Date.now();
  const session = rows.find(r => String(r['Token']) === String(token) && Number(r['ExpiresAt']) > now);
  if (!session) return null;
  const user = findUserById(session['UserID']);
  if (!user) return null;
  if (String(user['Status']) !== 'approved') return null;
  return user;
}

function requireAuth(token) {
  const user = validateSession(token);
  if (!user) throw new Error('Sesi tidak valid atau kedaluwarsa. Silakan login ulang.');
  return user;
}

function requireAdmin(token) {
  const user = requireAuth(token);
  if (String(user['Role']) !== 'admin') throw new Error('Akses ditolak. Hanya admin.');
  return user;
}

function publicUser(u) {
  return {
    id: u['ID'], username: u['Username'], nama: u['Nama'], email: u['Email'],
    role: u['Role'], status: u['Status']
  };
}

function setUserField(userId, fieldName, value) {
  const sheet = getUsersSheet();
  const { headers, rows } = readSheetAsObjects(sheet);
  const u = rows.find(r => String(r['ID']) === String(userId));
  if (!u) return false;
  const col = headers.indexOf(fieldName);
  if (col === -1) return false;
  sheet.getRange(u.__rowIndex, col + 1).setValue(value);
  return true;
}

// ============================================================
// 6. HANDLER — AUTH
// ============================================================
function handleRegister(data) {
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  const nama = String(data.nama || '').trim();
  const email = String(data.email || '').trim();

  if (username.length < 3) throw new Error('Username minimal 3 karakter.');
  if (!/^[a-z0-9_]+$/.test(username)) throw new Error('Username hanya huruf kecil, angka, underscore.');
  if (password.length < 6) throw new Error('Password minimal 6 karakter.');
  if (!nama) throw new Error('Nama lengkap wajib diisi.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Format email tidak valid.');
  if (findUserByUsername(username)) throw new Error('Username sudah terpakai.');

  const sheet = getUsersSheet();
  const salt = generateSalt();
  const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  sheet.appendRow([
    id, username, hashPassword(password, salt), salt, nama, email,
    'user', 'pending', new Date().toISOString(), '', '', ''
  ]);

  return { success: true, message: 'Pendaftaran berhasil. Menunggu persetujuan admin.' };
}

function handleLogin(data) {
  const username = String(data.username || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!username || !password) throw new Error('Username dan password wajib diisi.');

  const user = findUserByUsername(username);
  if (!user) throw new Error('Username atau password salah.');

  const expected = hashPassword(password, user['Salt']);
  if (expected !== String(user['PasswordHash'])) throw new Error('Username atau password salah.');

  const status = String(user['Status']);
  if (status === 'pending')  throw new Error('Akun masih menunggu persetujuan admin.');
  if (status === 'rejected') throw new Error('Akun ditolak oleh admin.');
  if (status !== 'approved') throw new Error('Akun tidak aktif.');

  const token = generateToken();
  getSessionsSheet().appendRow([
    token, user['ID'], user['Username'], Date.now() + SESSION_TTL_MS, new Date().toISOString()
  ]);
  setUserField(user['ID'], 'LastLogin', new Date().toISOString());

  return { success: true, token, user: publicUser(user) };
}

function handleLogout(data) {
  const token = String(data.token || '').trim();
  if (!token) return { success: true };
  const sheet = getSessionsSheet();
  const { rows } = readSheetAsObjects(sheet);
  const s = rows.find(r => String(r['Token']) === token);
  if (s) sheet.deleteRow(s.__rowIndex);
  return { success: true };
}

function handleCheckSession(token) {
  const user = validateSession(token);
  if (!user) return { success: false, valid: false };
  return { success: true, valid: true, user: publicUser(user) };
}

// ============================================================
// 7. HANDLER — ADMIN
// ============================================================
function handleListUsers(token) {
  requireAdmin(token);
  const { rows } = readSheetAsObjects(getUsersSheet());
  return {
    success: true,
    users: rows.map(r => ({
      id: r['ID'], username: r['Username'], nama: r['Nama'], email: r['Email'],
      role: r['Role'], status: r['Status'],
      createdAt: r['CreatedAt'], approvedAt: r['ApprovedAt'],
      approvedBy: r['ApprovedBy'], lastLogin: r['LastLogin']
    }))
  };
}

function handleApproveUser(token, userId) {
  const admin = requireAdmin(token);
  if (!userId) throw new Error('User ID wajib.');
  if (!findUserById(userId)) throw new Error('User tidak ditemukan.');
  setUserField(userId, 'Status', 'approved');
  setUserField(userId, 'ApprovedAt', new Date().toISOString());
  setUserField(userId, 'ApprovedBy', admin['Username']);
  return { success: true, message: 'User disetujui.' };
}

function handleRejectUser(token, userId) {
  requireAdmin(token);
  if (!userId) throw new Error('User ID wajib.');
  if (!findUserById(userId)) throw new Error('User tidak ditemukan.');
  setUserField(userId, 'Status', 'rejected');
  return { success: true, message: 'User ditolak.' };
}

function handleDeleteUser(token, userId) {
  const admin = requireAdmin(token);
  if (String(admin['ID']) === String(userId)) throw new Error('Tidak bisa menghapus akun sendiri.');

  const sheet = getUsersSheet();
  const { rows } = readSheetAsObjects(sheet);
  const u = rows.find(r => String(r['ID']) === String(userId));
  if (!u) throw new Error('User tidak ditemukan.');
  sheet.deleteRow(u.__rowIndex);

  // Hapus sesi terkait
  const sSheet = getSessionsSheet();
  const { rows: sRows } = readSheetAsObjects(sSheet);
  sRows.filter(s => String(s['UserID']) === String(userId))
    .sort((a, b) => b.__rowIndex - a.__rowIndex)
    .forEach(s => sSheet.deleteRow(s.__rowIndex));

  return { success: true };
}

function handleGetResults(token) {
  requireAdmin(token);
  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_HASIL, HEADERS_HASIL);
  ensureHeaders(sheet, HEADERS_HASIL);
  const { rows } = readSheetAsObjects(sheet);
  return {
    success: true,
    results: rows.map(r => ({
      timestamp: r['Timestamp'], nama: r['Nama Peserta'],
      kuis: r['Kuis'], word: r['Ketik Word'], excel: r['Tabel Excel'],
      presentasi: r['Presentasi PPT'], pidato: r['Pidato Jawa'],
      rapat: r['Simulasi Rapat'], wawancara: r['Wawancara'], psikologi: r['Psikologi'],
      submissionId: r['SubmissionId'], userId: r['UserID'], username: r['Username']
    }))
  };
}

// ============================================================
// 8. HANDLER — DATA (GET)
// ============================================================
function handleGetQuestions() {
  const cache = (USE_CACHE && typeof CacheService !== 'undefined')
    ? CacheService.getScriptCache()
    : null;
  const cacheKey = 'bs_v4';

  if (cache) {
    try {
      const cached = cache.get(cacheKey);
      if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
    } catch (e) {}
  }

  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_SOAL, HEADERS_SOAL);
  ensureHeaders(sheet, HEADERS_SOAL);

  const { headers, rows } = readSheetAsObjects(sheet);
  if (rows.length === 0) throw new Error("Sheet 'BankSoal' kosong (tidak ada data).");

  const idx = h => headers.indexOf(h);
  const iTipe = idx('Tipe'), iKunci = idx('Kunci'), iPemb = idx('Pembahasan'),
        iPaket = idx('Paket'), iNo = idx('No'), iKat = idx('Kategori');

  const questions = [];
  let skipped = 0;

  rows.forEach((row, ri) => {
    const pertanyaan = safeString(row['Pertanyaan']).trim();
    if (!pertanyaan) { skipped++; return; }

    const tipe = (iTipe !== -1 ? safeString(row['Tipe']) : 'pg').trim().toLowerCase() || 'pg';
    const options = [
      safeString(row['OpsiA']), safeString(row['OpsiB']),
      safeString(row['OpsiC']), safeString(row['OpsiD'])
    ];
    const rawKey = iKunci !== -1 ? row['Kunci'] : '';

    let answer;
    if (tipe === 'uraian') {
      answer = safeString(rawKey).trim();
    } else {
      if (options.filter(o => o.trim()).length < 2) { skipped++; return; }
      const parsed = parseAnswerKey(rawKey, options);
      if (parsed === null) { skipped++; return; }
      answer = parsed;
    }

    questions.push({
      no: iNo !== -1 && row['No'] !== '' ? row['No'] : (ri + 1),
      category: iKat !== -1 ? safeString(row['Kategori']).trim() || 'Umum' : 'Umum',
      question: pertanyaan, options, answer,
      explanation: iPemb !== -1 ? safeString(row['Pembahasan']).trim() : '',
      tipe,
      paket: iPaket !== -1 ? safeString(row['Paket']).trim() : ''
    });
  });

  if (questions.length === 0) {
    throw new Error(`Tidak ada soal valid di 'BankSoal' (${skipped} baris di-skip).`);
  }

  const payload = JSON.stringify(questions);
  if (cache) { try { cache.put(cacheKey, payload, CACHE_TTL_SEC); } catch (e) {} }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

function handleGetPidato() {
  const cache = (USE_CACHE && typeof CacheService !== 'undefined')
    ? CacheService.getScriptCache()
    : null;
  const cacheKey = 'pd_v4';

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
  if (idxId === -1) return jsonResponse({ success: false, error: 'Kolom SubmissionId tidak ditemukan.' });

  const scanFrom = Math.max(2, lastRow - (VERIFY_SCAN_ROWS - 1));
  const numRows  = lastRow - scanFrom + 1;
  if (numRows <= 0) return jsonResponse({ success: false, reason: 'no_rows' });

  const data = sheet.getRange(scanFrom, 1, numRows, lastCol).getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    if (safeString(data[i][idxId]).trim() === id) {
      return jsonResponse({ success: true, row: scanFrom + i });
    }
  }
  return jsonResponse({ success: false, reason: 'not_found' });
}

function handlePing() {
  return jsonResponse({ success: true, ts: Date.now(), iso: new Date().toISOString() });
}

// ============================================================
// 9. HANDLER — SUBMIT SCORE
// ============================================================
function handleSubmitScore(data) {
  const token = safeString(data.token).trim();
  const user = validateSession(token);
  if (!user) {
    return jsonResponse({ result: 'error', error: 'Sesi tidak valid. Silakan login ulang.' });
  }

  const nama = safeString(data.nama).trim() || safeString(user['Nama']).trim();
  if (!nama) return jsonResponse({ result: 'error', error: 'Nama peserta kosong.' });
  if (nama.length > MAX_NAME_LENGTH) {
    return jsonResponse({ result: 'error', error: 'Nama terlalu panjang (maks ' + MAX_NAME_LENGTH + ').' });
  }

  const submissionId = safeString(data.submissionId).trim() ||
    ('srv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));

  const ss = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_HASIL, HEADERS_HASIL);
  ensureHeaders(sheet, HEADERS_HASIL);

  // Idempotency check
  const dupCheck = handleVerify(submissionId);
  const dupObj = JSON.parse(dupCheck.getContent());
  if (dupObj && dupObj.success) {
    return jsonResponse({ result: 'success', duplicated: true, submissionId });
  }

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
    'SubmissionId':   submissionId,
    'UserID':         user['ID'],
    'Username':       user['Username']
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
}

// ============================================================
// 10. DO GET
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

// ============================================================
// 11. DO POST
// ============================================================
function doPost(e) {
  try {
    if (!e) return errorResponse('Request kosong.');

    const action = (e.parameter && e.parameter.action)
      ? String(e.parameter.action).trim()
      : '';

    if (!e.postData || !e.postData.contents) {
      return errorResponse('Body kosong.');
    }

    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return errorResponse('Body bukan JSON valid.');
    }

    if (!data || typeof data !== 'object') {
      return errorResponse('Payload tidak valid.');
    }

    // Score submission (default / explicit)
    if (!action || action === 'submitScore') {
      return handleSubmitScore(data);
    }

    // Auth
    if (action === 'register')     return jsonResponse(handleRegister(data));
    if (action === 'login')        return jsonResponse(handleLogin(data));
    if (action === 'logout')       return jsonResponse(handleLogout(data));
    if (action === 'checkSession') return jsonResponse(handleCheckSession(data.token));

    // Admin
    if (action === 'listUsers')    return jsonResponse(handleListUsers(data.token));
    if (action === 'approveUser')  return jsonResponse(handleApproveUser(data.token, data.userId));
    if (action === 'rejectUser')   return jsonResponse(handleRejectUser(data.token, data.userId));
    if (action === 'deleteUser')   return jsonResponse(handleDeleteUser(data.token, data.userId));
    if (action === 'getResults')   return jsonResponse(handleGetResults(data.token));

    return errorResponse('Action tidak dikenali: ' + action);

  } catch (err) {
    console.error('[doPost] Error:', err);
    return errorResponse(err.message || String(err));
  }
}

// ============================================================
// 12. SETUP — JALANKAN SEKALI DARI EDITOR
// ============================================================
/**
 * Inisialisasi semua sheet + header. Jalankan sekali setelah Spreadsheet dibuat.
 */
function setupSpreadsheet() {
  const ss = getSpreadsheet();

  getOrCreateSheet(ss, SHEET_SOAL,     HEADERS_SOAL);
  getOrCreateSheet(ss, SHEET_HASIL,    HEADERS_HASIL);
  getOrCreateSheet(ss, SHEET_PIDATO,   HEADERS_PIDATO);
  getOrCreateSheet(ss, SHEET_USERS,    HEADERS_USERS);
  getOrCreateSheet(ss, SHEET_SESSIONS, HEADERS_SESSIONS);

  const map = {
    [SHEET_SOAL]: HEADERS_SOAL,
    [SHEET_HASIL]: HEADERS_HASIL,
    [SHEET_PIDATO]: HEADERS_PIDATO,
    [SHEET_USERS]: HEADERS_USERS,
    [SHEET_SESSIONS]: HEADERS_SESSIONS
  };
  Object.keys(map).forEach(name => {
    ensureHeaders(ss.getSheetByName(name), map[name]);
  });

  SpreadsheetApp.getUi().alert("✅ Setup selesai. Semua sheet & header siap.");
}

/**
 * Buat akun admin pertama. Jalankan sekali dari editor.
 */
function createDefaultAdmin() {
  const ui = SpreadsheetApp.getUi();
  const uPrompt = ui.prompt('Buat Admin', 'Username admin (lowercase, min 3):', ui.ButtonSet.OK_CANCEL);
  if (uPrompt.getSelectedButton() !== ui.Button.OK) return;

  const pPrompt = ui.prompt('Buat Admin', 'Password admin (min 6 karakter):', ui.ButtonSet.OK_CANCEL);
  if (pPrompt.getSelectedButton() !== ui.Button.OK) return;

  const username = uPrompt.getResponseText().trim().toLowerCase();
  const password = pPrompt.getResponseText();

  if (username.length < 3 || password.length < 6) {
    return ui.alert('❌ Username/password tidak valid.');
  }
  if (findUserByUsername(username)) {
    return ui.alert('❌ Username sudah ada.');
  }

  const salt = generateSalt();
  const id = 'u_' + Date.now().toString(36) + '_admin';
  getUsersSheet().appendRow([
    id, username, hashPassword(password, salt), salt,
    'Administrator', '', 'admin', 'approved',
    new Date().toISOString(), new Date().toISOString(), 'system', ''
  ]);

  ui.alert('✅ Admin dibuat.\nUsername: ' + username + '\nLogin di web untuk mulai.');
}

// ============================================================
// 13. ADMIN — CONTENT SETUP
// ============================================================
/**
 * Bagi soal ke 5 paket seimbang per kategori.
 * Jalankan manual dari editor setelah BankSoal terisi.
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
      list.forEach((rowIdx, j) => { assign[rowIdx] = (j % JUMLAH_PAKET) + 1; });
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
 * Setup sheet TeksPidato dengan 5 teks pidato Bahasa Jawa standar.
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
Kula minangka sesulih utawi wakilipun kulawarga ageng ahli waris, kanthi raos sedhih lan pasrah, keparenga matur wonten ngarsa panjenengan sedaya.
Para rawuh ingkang kinurmatan, Gusti Allah Ingkang Maha Kuwaos sampun ngresersaken, bilih sederek kita, sepuh kita, sampun tinimbalan sowan wonten ngarsanipun Gusti Ingkang Maha Kawasa.
Kula minangka pangarsaning dhusun, ngaturaken matur nuwun ingkang tanpa upami dhumateng panjenengan sedaya, para tangga teparo, lan para takziyah ingkang sampun kersa rawuh.
Mugi-mugi sedaya amal kesaenan panjenengan dipunwales dening Gusti Allah kanthi berkah ingkang tikel matikel.
Kula minangka wakilipun ahli waris, kanthi andhap asoring manah nyuwun agunging samudrasih pangaksama saking panjenengan sedaya. Mbok bilih ing wekdal gesangipun almarhum kagadhah kalepatan, mugi kersa paring pangapunten ingkang tulus lan ikhlas.
Pungkasaning atur saking kula, mbok bilih wonten kiranging aruh, lungguh, lan suguh ingkang boten mranani penggalih panjenengan sedaya, kula nyuwun agunging pangapunten.
Mugi Gusti Allah tansah njangkung lampah kita sedaya. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`],

    ["budaling", "Budaling Lelayon (Takziah)",
`Ass. Wr. Wb.
Bismillahirohmanirrohim.
Alhamdulillahi robbil alamin wassolatu wa salamu alla asyrofil anbiya i wal mursalin, wa alla alihi wa sohbihi aj main. Amma ba'du.
Nyuwun panjenenganipun poro sepuh pini sepuh ingkang kinabekten, linangkung bapak Lurah, bapak RT, tokoh masyarakat, Simbah kaum Rois lan sagung poro takziah kakung soho putri ingkang tansah kulo hormati.
Pinongko purwakaning atur, sumawi kulo derekaken manengku pujo wonten ngarso dalem allah ta'alla. Ingkang tansah soho taseh paring rahmat, hidayah soho inayahipun.
Rahmat soho salam mugi karentahno dumateng junjungan kito nabi agung muhammad SAW sak garwo putro soho penderekipun ingkang tansah kito antu2 syafaatipun wonten ing yaumul qiyamah sak mangke.
Sak lajengipun, sedoyo ahli waris, hangaturaken pambagyo kawilujengan sugeng rawuh soho ngaturaken sanget agunging panuwun ingkang tanpo pepindan, Dene panjengan sami sampun kepareng hangentengaken saliro, mijiaken wekdal rawuh inggih kejawi nglaeraken raos sungkowo, ugi paring pakurmatan ingkang pungkasan dumateng almarhum.
Pinongko pungkasaning atur, nyuwun dumateng panjenengan kerso derekaken lampahing jenazah ingkang sak mangke dipun sareaken ing makam suci.
Poro takziah kakung soho putri mekaten aturipun ahli waris almarhum lumantar kulo, mbok bilih anggenipun kulo matur pinanggih lepat ing mriki kulo nyuwun agunging pangapunten.
Akhiruk kalam Assalammu alaikum wr.wb.`],

    ["pasrah", "Atur Pasrah Penganten (Pawiwahan)",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Alhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal morsalin, wa 'ala alihi wa shahbihi ajma'in. Amma ba'du.
Dhumateng para sesepuh, pinisepuh ingkang tansah dahat kinabekten.
Dhumateng kulawarga ageng ingkang satuhu kinurmatan.
Kula, minangka sesulih utawi wakilipun Bapak kaliyan Ibu, keparenga matur wonten ngarsa panjenengan sedaya.
Ingkang kapisan, sumangga kita tansah ngaturaken raos syukur dhumateng Gusti Allah SWT, ingkang sampun paring kesarasan lan kalodhangan, saengga kita saged kempal manunggal wonten ing adicara pawiwahan menika kanthi wilujeng.
Wosing gati utawi tujuwan sowan kula sakanca ing mriki, inggih menika nindakaken amanah pasrah penganten. Kula pasrahaken dhumateng kulawarga mriki, bilih anak mas penganten putra ingkang sampun nindakaken akad nikah, kanthi tulus ikhlasing manah kersaa dipunwengku lan dipuntampi dados kulawarga ageng.
Minangka mudha-mudhi ingkang nembe ngancik dunya bebrayan, anak mas taksih kirang pengalamanipun, taksih kathah kekiranganipun, lan taksih mbetahaken bimbingan. Mligi kagem Bapak Dukuh lan para sesepuh, kula titip anak kula menika supados dipun-didik, dipun-arahaken, saengga saged dados warga dusun ingkang sae.
Ingkang pungkasan, kula sakulawarga nyuwun agunging samudrasih pangaksama, mbok bilih wonten tindak-tanduk, muna-muni, utawi tata krami sowan kula sakanca ingkang kirang mranani penggalih panjenengan sedaya.
Mugi Gusti Allah SWT tansah njangkung lan ngijabahi niat sae kita sedaya. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`],

    ["tampi", "Atur Nampi Penganten (Pawiwahan)",
`Assalamu'alaikum Warahmatullahi Wabarakatuh.
Bismillah walhamdulillah, washalahtu wasalamu 'ala rasulillah, sayyidina Muhammadin wa 'ala alihi wa sahbihi ajma'in. Amma ba'du.
Dhumateng para sesepuh, pinisepuh ingkang satuhu pantes sinudarsana.
Dhumateng Bapak Dukuh dalah para pengombyong penganten putra ingkang agung kasatriyanipun.
Serta kulawarga ageng ingkang bagya mulya.
Kula minangka sesulih utawi wakil saking kulawarga ageng, ugi minangka pangarsaning dhusun, keparenga amangsuli atur pasrah ingkang sampun dipun-andharaken kanthi cetha wela-wela dhumateng kita sedaya.
Ingkang kapisan, sumangga kita sesarengan ngaturaken puja lan puji syukur wonten ngarsanipun Gusti Ingkang Maha Agung, amargi kanthi rahmat lan hidayah-Ipun, rombongan penganten putra saged rawuh kanthi binerkahan keslametan.
Para rawuh ingkang sinuba ing pakurmatan, ngenani wosing gati pasrah panjenengan, kula minangka wakil kulawarga lan minangka pamong wonten ing dhusun mriki, kanthi thukul ikhlasing manah, nampi kanthi asta kalih lan gumbiranipun penggalih pasrah penganten putra.
Mulai detik menika, anak mas penganten putra sampun resmi dados perangan saking kulawarga ageng mriki, lan ugi sah dados warga dhusun kita.
Babagan bimbingan lan pituduh ingkang dipun-kersaken wau, sampun dados kuwajiban kita sedaya minangka tiyang sepuh lan pamong. Kita badhe sesarengan njagi, ngarahaken, lan ndedonga, mugi-mugi penganten kekalih saged nyawiji, asah, asih, asuh, lan saged mbangun kulawarga ingkang bagya mulya, ngantos kaken-kaken ninen-ninen.
Pungkasaning atur, kula nyuwun pangapunten ingkang agung, mbok bilih wonten thithik kuciwaning aruh, lungguh, lan suguh ingkang kirang nengsemaken.
Mugi-mugi Gusti Allah tansah mberkahi adicara menika. Amin.
Wassalamu'alaikum Warahmatullahi Wabarakatuh.`]
  ];

  sheet.getRange(2, 1, dataPidato.length, 3).setValues(dataPidato);
  sheet.setColumnWidth(1, 100).setColumnWidth(2, 250).setColumnWidth(3, 700);
  try { sheet.setFrozenRows(1); } catch (e) {}

  SpreadsheetApp.getUi().alert("✅ Sheet TeksPidato dibuat & diisi 5 teks pidato.");
}

// ============================================================
// 14. ADMIN — DIAGNOSTICS & MAINTENANCE
// ============================================================
function diagnoseAll() {
  const lines = ['=== DIAGNOSTIC ===', 'Time: ' + new Date().toISOString()];

  try {
    const ss = getSpreadsheet();
    lines.push('✅ Spreadsheet: ' + ss.getName());
    lines.push('   URL: ' + ss.getUrl());
  } catch (e) {
    lines.push('❌ Spreadsheet: ' + e.message);
    return SpreadsheetApp.getUi().alert(lines.join('\n'));
  }

  const ss = getSpreadsheet();
  [SHEET_SOAL, SHEET_HASIL, SHEET_PIDATO, SHEET_USERS, SHEET_SESSIONS].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) {
      lines.push('⚠️ Sheet "' + name + '" tidak ada (akan dibuat otomatis).');
    } else {
      lines.push('✅ Sheet "' + name + '": ' + Math.max(0, sh.getLastRow() - 1) + ' baris, ' + sh.getLastColumn() + ' kolom.');
    }
  });

  try {
    const q = JSON.parse(handleGetQuestions().getContent());
    lines.push('✅ getQuestions: ' + q.length + ' soal');
  } catch (e) { lines.push('❌ getQuestions: ' + e.message); }

  try {
    const p = JSON.parse(handleGetPidato().getContent());
    lines.push('✅ getPidato: ' + p.length + ' teks');
  } catch (e) { lines.push('❌ getPidato: ' + e.message); }

  try {
    const u = readSheetAsObjects(getUsersSheet());
    const approved = u.rows.filter(r => String(r['Status']) === 'approved').length;
    const pending  = u.rows.filter(r => String(r['Status']) === 'pending').length;
    lines.push('✅ Users: ' + u.rows.length + ' total (' + approved + ' approved, ' + pending + ' pending)');
  } catch (e) { lines.push('❌ Users: ' + e.message); }

  try {
    const v = handleVerify('__test_nonexistent__');
    const vData = JSON.parse(v.getContent());
    lines.push('✅ verify: respons valid (' + JSON.stringify(vData) + ')');
  } catch (e) { lines.push('❌ verify: ' + e.message); }

  lines.push('=== END ===');
  SpreadsheetApp.getUi().alert(lines.join('\n'));
  console.log(lines.join('\n'));
}

function clearCache() {
  try {
    const c = CacheService.getScriptCache();
    c.remove('bs_v4');
    c.remove('pd_v4');
    SpreadsheetApp.getUi().alert('✅ Cache dibersihkan. Perubahan terlihat pada request berikutnya.');
  } catch (e) {
    SpreadsheetApp.getUi().alert('⚠️ ' + e.message);
  }
}

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