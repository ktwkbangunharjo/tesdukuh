// ==========================================
// api.js — FULL FIXED VERSION (v5 — With Auth)
// Kompatibel dengan app.js v6 & code.gs v4
// ==========================================

// ==========================================
// 1. KONFIGURASI
// ==========================================
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbx4HSzvR-ytQME6HqpSX-RYuiGYmxtW6dwKBS6QUHNen8HQowQaoVAgzKCSRd6DMlE4/exec';

const API_CONFIG = {
    timeoutMs:         20000,   // timeout GET umum
    verifyTimeoutMs:    8000,   // timeout per-verify
    verifyAttempts:        3,   // polling setelah POST gagal
    verifyBackoffMs:    1500,   // delay antar verify (×attempt)
    getRetries:            2,   // retry GET saat network fail
    getBackoffMs:        800,   // delay antar retry GET
    debug:             false    // true untuk log verbose
};

// ==========================================
// 2. GUARD & VALIDASI KONFIGURASI
// ==========================================
function ensureApiConfigured() {
    if (!GAS_API_URL || typeof GAS_API_URL !== 'string') {
        throw new Error("URL API belum diatur di dalam file api.js.");
    }
    if (
        GAS_API_URL.includes('MASUKKAN_URL') ||
        GAS_API_URL.includes('URL_WEB_APP_ANDA') ||
        GAS_API_URL.includes('GANTI_DENGAN')
    ) {
        throw new Error("GAS_API_URL masih berisi placeholder. Isi dengan URL deployment Apps Script yang benar (akhiran /exec).");
    }
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(GAS_API_URL)) {
        console.warn("[api.js] GAS_API_URL tidak sesuai format standar. Pastikan diakhiri '/exec', bukan '/dev'.");
    }
}

// ==========================================
// 3. HELPER TOKEN
// ==========================================
function _getToken() {
    try { return localStorage.getItem('dukuh_token') || ''; }
    catch (e) { return ''; }
}

// ==========================================
// 4. HELPER: FETCH + TIMEOUT
// ==========================================
async function fetchWithTimeout(url, options = {}, timeoutMs = API_CONFIG.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Timeout ${timeoutMs}ms — server tidak merespons. Periksa koneksi.`);
        }
        if (err instanceof TypeError) {
            throw new Error("Koneksi jaringan gagal. Periksa internet Anda.");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ==========================================
// 5. HELPER: FETCH JSON (GET dengan retry)
// ==========================================
async function fetchJSON(url, { retries = 0, timeoutMs = API_CONFIG.timeoutMs } = {}) {
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (API_CONFIG.debug) console.log(`[api.js] GET ${attempt + 1}/${retries + 1}: ${url.slice(0, 100)}`);

            const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, timeoutMs);
            const text = await res.text();

            if (!res.ok) {
                let msg = `HTTP ${res.status}`;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.error) msg += ` — ${parsed.error}`;
                } catch (_) {
                    if (text.trim().startsWith('<')) {
                        msg += ` — server mengembalikan HTML (deployment belum otorisasi publik).`;
                    }
                }
                throw new Error(msg);
            }

            if (!text || !text.trim()) {
                throw new Error("Server mengembalikan response kosong.");
            }

            try {
                return JSON.parse(text);
            } catch (parseErr) {
                if (text.trim().startsWith('<')) {
                    throw new Error(
                        "Server mengembalikan HTML, bukan JSON. " +
                        "Pastikan deployment Apps Script diset 'Anyone', bukan 'Only myself'."
                    );
                }
                throw new Error("Response bukan JSON valid: " + text.slice(0, 200));
            }
        } catch (err) {
            lastErr = err;
            if (API_CONFIG.debug) console.warn(`[api.js] Attempt ${attempt + 1} gagal:`, err.message);

            const isRetryable = /Timeout|Koneksi jaringan|HTTP 5\d\d|HTTP 429/.test(err.message);
            if (!isRetryable || attempt >= retries) break;

            await new Promise(r => setTimeout(r, API_CONFIG.getBackoffMs * (attempt + 1)));
        }
    }

    throw lastErr || new Error("Permintaan gagal tanpa alasan jelas.");
}

// ==========================================
// 6. HELPER: POST dengan action
// Content-Type text/plain menghindari preflight CORS.
// GAS "Anyone" merespons dengan JSON yang bisa dibaca.
// ==========================================
async function apiPost(action, bodyObj, timeoutMs = API_CONFIG.timeoutMs) {
    ensureApiConfigured();
    const url = `${GAS_API_URL}?action=${encodeURIComponent(action)}&_t=${Date.now()}`;

    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(bodyObj || {})
    }, timeoutMs);

    const text = await res.text();
    if (!text || !text.trim()) throw new Error('Response kosong dari server.');

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        if (text.trim().startsWith('<')) {
            throw new Error('Server mengembalikan HTML — deployment belum publik. Set akses "Anyone".');
        }
        throw new Error('Response bukan JSON: ' + text.slice(0, 200));
    }

    // Error detection
    if (data && data.error) throw new Error(String(data.error));
    if (data && data.result === 'error') {
        throw new Error(String(data.error || 'Permintaan ditolak server.'));
    }

    if (API_CONFIG.debug) console.log(`[api.js] POST ${action} →`, data);
    return data;
}

// ==========================================
// 7. AUTH API
// ==========================================
async function apiRegister(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Payload registrasi tidak valid.');
    return apiPost('register', {
        username: String(payload.username || '').trim().toLowerCase(),
        password: String(payload.password || ''),
        nama:     String(payload.nama || '').trim(),
        email:    String(payload.email || '').trim()
    });
}

async function apiLogin(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Payload login tidak valid.');
    const username = String(payload.username || '').trim().toLowerCase();
    const password = String(payload.password || '');
    if (!username || !password) throw new Error('Username dan password wajib diisi.');
    return apiPost('login', { username, password });
}

async function apiLogout() {
    const token = _getToken();
    if (!token) return { success: true };
    try { return await apiPost('logout', { token }); }
    catch (e) {
        if (API_CONFIG.debug) console.warn('[api.js] logout:', e.message);
        return { success: false, error: e.message };
    }
}

async function apiCheckSession() {
    const token = _getToken();
    if (!token) return { success: false, valid: false };
    try {
        const res = await apiPost('checkSession', { token });
        if (!res || typeof res !== 'object') return { success: false, valid: false };
        return res;
    } catch (e) {
        // Jangan throw di startup — beri tanda agar app.js tahu
        return { success: false, valid: false, error: e.message, networkError: true };
    }
}

// ==========================================
// 8. ADMIN API
// ==========================================
function _requireToken() {
    const token = _getToken();
    if (!token) throw new Error('Harus login sebagai admin.');
    return token;
}

async function apiListUsers() {
    return apiPost('listUsers', { token: _requireToken() });
}

async function apiApproveUser(userId) {
    if (!userId) throw new Error('userId wajib.');
    return apiPost('approveUser', { token: _requireToken(), userId });
}

async function apiRejectUser(userId) {
    if (!userId) throw new Error('userId wajib.');
    return apiPost('rejectUser', { token: _requireToken(), userId });
}

async function apiDeleteUser(userId) {
    if (!userId) throw new Error('userId wajib.');
    return apiPost('deleteUser', { token: _requireToken(), userId });
}

async function apiGetResults() {
    return apiPost('getResults', { token: _requireToken() });
}

// ==========================================
// 9. SANITASI DATA
// ==========================================
function sanitizeQuestion(q, idx) {
    if (!q || typeof q !== 'object') return null;

    const question = String(q.question ?? '').trim();
    if (!question) return null;

    const tipe = String(q.tipe || 'pg').toLowerCase().trim();
    const options = Array.isArray(q.options)
        ? q.options.map(o => String(o ?? ''))
        : [];

    if (tipe === 'pg' && options.filter(o => o.trim()).length < 2) return null;

    return {
        no:          Number.isFinite(Number(q.no)) ? Number(q.no) : (idx + 1),
        category:    String(q.category || 'Umum').trim(),
        question,
        options,
        answer:      q.answer,
        explanation: String(q.explanation || '').trim(),
        tipe,
        paket:       String(q.paket || '').trim()
    };
}

function sanitizePidato(p) {
    if (!p || typeof p !== 'object') return null;
    const id   = String(p.id ?? '').trim();
    const teks = String(p.teks ?? '');
    if (!id || !teks.trim()) return null;
    const judul = String(p.judul ?? '').trim();
    return { id, judul: judul || `Pidato ${id}`, teks };
}

function sanitizeScore(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

// ==========================================
// 10. DATA API
// ==========================================
async function apiGetQuestions() {
    ensureApiConfigured();
    const url = `${GAS_API_URL}?action=getQuestions&_t=${Date.now()}`;
    const data = await fetchJSON(url, { retries: API_CONFIG.getRetries });

    if (data && data.error) throw new Error(String(data.error));
    if (!Array.isArray(data)) throw new Error("Format data soal tidak valid (server mengembalikan non-array).");

    const sanitized = data.map((q, i) => sanitizeQuestion(q, i)).filter(Boolean);
    if (sanitized.length === 0) {
        throw new Error("Semua soal di Spreadsheet kosong atau formatnya rusak. Periksa sheet 'BankSoal'.");
    }

    if (API_CONFIG.debug) console.log(`[api.js] Loaded ${sanitized.length} soal.`);
    return sanitized;
}

async function apiGetPidato() {
    ensureApiConfigured();
    const url = `${GAS_API_URL}?action=getPidato&_t=${Date.now()}`;
    const data = await fetchJSON(url, { retries: API_CONFIG.getRetries });

    if (data && data.error) {
        console.warn("[api.js] getPidato error:", data.error);
        return [];
    }
    if (!Array.isArray(data)) {
        console.warn("[api.js] getPidato bukan array, dianggap kosong.");
        return [];
    }

    const result = data.map(sanitizePidato).filter(Boolean);
    if (API_CONFIG.debug) console.log(`[api.js] Loaded ${result.length} teks pidato.`);
    return result;
}

// ==========================================
// 11. SUBMIT SCORES (dengan token + fallback verify)
// ==========================================
async function apiSubmitScores(payload) {
    ensureApiConfigured();

    if (!payload || typeof payload !== 'object') {
        throw new Error("Payload nilai tidak valid.");
    }

    const nama = String(payload.nama || '').trim();
    if (!nama) throw new Error("Nama peserta kosong.");
    if (nama.length > 150) throw new Error("Nama peserta terlalu panjang (maks 150 karakter).");

    const token = _getToken();
    if (!token) throw new Error("Sesi login tidak ditemukan. Silakan login ulang.");

    const clean = {
        nama,
        paket:      String(payload.paket || '').trim(),
        kuis:       sanitizeScore(payload.kuis),
        word:       sanitizeScore(payload.word),
        excel:      sanitizeScore(payload.excel),
        presentasi: sanitizeScore(payload.presentasi),
        pidato:     sanitizeScore(payload.pidato),
        rapat:      sanitizeScore(payload.rapat),
        wawancara:  sanitizeScore(payload.wawancara),
        psikologi:  sanitizeScore(payload.psikologi)
    };

    const submissionId = 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const enriched = { ...clean, submissionId, token, timestamp: new Date().toISOString() };

    // --- (1) POST proper (response bisa dibaca) ---
    try {
        const data = await apiPost('submitScore', enriched, API_CONFIG.timeoutMs);

        if (data && (data.result === 'success' || data.success === true)) {
            if (API_CONFIG.debug) console.log('[api.js] Submit OK:', submissionId);
            return { success: true, submissionId, duplicated: !!data.duplicated };
        }

        throw new Error('Response tidak dikenali dari server: ' + JSON.stringify(data).slice(0, 200));
    } catch (postErr) {
        // Error semantik (sesi/nama/akses) → lempar langsung, jangan poll
        const isSemantic = /Sesi|login|Akses|Nama|Session|terlalu panjang|kosong/i.test(postErr.message);
        if (isSemantic) {
            throw postErr;
        }

        // Network/timeout → fallback: polling verify
        if (API_CONFIG.debug) console.warn('[api.js] POST gagal, polling verify:', postErr.message);

        let lastErr = postErr;
        for (let attempt = 1; attempt <= API_CONFIG.verifyAttempts; attempt++) {
            await new Promise(r => setTimeout(r, API_CONFIG.verifyBackoffMs * attempt));

            try {
                const url = `${GAS_API_URL}?action=verify&id=${encodeURIComponent(submissionId)}&_t=${Date.now()}`;
                const data = await fetchJSON(url, { timeoutMs: API_CONFIG.verifyTimeoutMs, retries: 0 });

                if (data && (data.success === true || data.result === 'success')) {
                    if (API_CONFIG.debug) console.log('[api.js] Verified via poll:', submissionId);
                    return { success: true, submissionId };
                }
                if (data && data.error) {
                    lastErr = new Error(String(data.error));
                }
            } catch (verifyErr) {
                lastErr = verifyErr;
                if (API_CONFIG.debug) console.warn(`[api.js] Verify attempt ${attempt} gagal:`, verifyErr.message);
            }
        }

        const detail = lastErr ? ` Detail: ${lastErr.message}.` : '';
        throw new Error(
            `Server tidak mengonfirmasi penerimaan setelah ${API_CONFIG.verifyAttempts} percobaan.${detail}` +
            " Periksa sheet HasilUjian dulu sebelum submit ulang."
        );
    }
}

// ==========================================
// 12. UTIL API (ping, verify, debug)
// ==========================================
async function apiPing() {
    ensureApiConfigured();
    const url = `${GAS_API_URL}?action=ping&_t=${Date.now()}`;
    try {
        const data = await fetchJSON(url, { timeoutMs: 8000 });
        return { ok: !!(data && data.success), raw: data };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function apiVerify(id) {
    ensureApiConfigured();
    if (!id) throw new Error("id wajib diisi.");
    const url = `${GAS_API_URL}?action=verify&id=${encodeURIComponent(id)}&_t=${Date.now()}`;
    const data = await fetchJSON(url, { timeoutMs: API_CONFIG.verifyTimeoutMs });
    return {
        found: !!(data && (data.success === true || data.result === 'success')),
        raw: data
    };
}

// ==========================================
// 13. DEBUG HELPER (aktif via console)
// ==========================================
// Usage di console browser:
//   __apiDebug().then(console.log)
window.__apiDebug = async () => {
    const out = {
        url: GAS_API_URL,
        token: _getToken() ? '✓ present' : '✗ missing',
        ping: null,
        session: null,
        questions: null,
        pidato: null,
        errors: []
    };

    try {
        out.ping = await apiPing();
    } catch (e) {
        out.errors.push({ step: 'ping', error: e.message });
    }

    try {
        out.session = await apiCheckSession();
    } catch (e) {
        out.errors.push({ step: 'session', error: e.message });
    }

    try {
        const q = await apiGetQuestions();
        out.questions = { count: q.length, sample: q[0] ? { no: q[0].no, tipe: q[0].tipe } : null };
    } catch (e) {
        out.errors.push({ step: 'questions', error: e.message });
    }

    try {
        const p = await apiGetPidato();
        out.pidato = { count: p.length, sample: p[0] ? { id: p[0].id, judul: p[0].judul } : null };
    } catch (e) {
        out.errors.push({ step: 'pidato', error: e.message });
    }

    return out;
};