// ==========================================
// api.js — FULL FIXED VERSION (v3)
// Menangani: timeout, retry, sanitasi, verify, error messaging
// Kompatibel dengan app.js v3 & code.gs (fix version)
// ==========================================

// ==========================================
// 1. KONFIGURASI
// ==========================================
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbw3zggiz-ObOT0UJwezwzBiGJESXe-LzxAxAHOLa9dFVZYRo-K0vqjFaROpIiRuJ5xe/exec';

const API_CONFIG = {
    timeoutMs:         20000,   // timeout setiap request GET
    verifyTimeoutMs:    8000,   // timeout setiap request verify
    verifyAttempts:        3,   // jumlah polling verifikasi setelah POST
    verifyBackoffMs:    1500,   // delay dasar antar verify (×attempt)
    getRetries:            2,   // retry GET saat network fail
    getBackoffMs:        800,   // delay dasar antar retry GET
    debug:             false    // set true untuk log verbose
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
        // Bukan fatal — hanya warning. User mungkin deploy di domain lain (jarang).
        console.warn("[api.js] GAS_API_URL tidak sesuai format standar. Pastikan diakhiri '/exec', bukan '/dev'.");
    }
}

// ==========================================
// 3. HELPER: FETCH + TIMEOUT
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
        // TypeError biasanya = network error (DNS, offline, CORS block)
        if (err instanceof TypeError) {
            throw new Error("Koneksi jaringan gagal. Periksa internet Anda.");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ==========================================
// 4. HELPER: FETCH JSON (dengan retry + validasi body)
// ==========================================
async function fetchJSON(url, { retries = 0, timeoutMs = API_CONFIG.timeoutMs } = {}) {
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (API_CONFIG.debug) console.log(`[api.js] GET ${attempt + 1}/${retries + 1}: ${url.slice(0, 80)}...`);

            const res = await fetchWithTimeout(url, { method: 'GET', cache: 'no-store' }, timeoutMs);

            // Baca body selalu (agar bisa tampilkan error page)
            const text = await res.text();

            if (!res.ok) {
                // Coba parse error body jika JSON
                let msg = `HTTP ${res.status}`;
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.error) msg += ` — ${parsed.error}`;
                } catch (_) {
                    // Bukan JSON; potong saja
                    if (text.trim().startsWith('<')) {
                        msg += ` — server mengembalikan HTML (bukan JSON). Kemungkinan deployment belum diotorisasi publik.`;
                    }
                }
                throw new Error(msg);
            }

            // Response 200 tapi body kosong?
            if (!text || !text.trim()) {
                throw new Error("Server mengembalikan response kosong.");
            }

            // Parse JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                // Response mungkin HTML login page
                if (text.trim().startsWith('<')) {
                    throw new Error(
                        "Server mengembalikan HTML, bukan JSON. " +
                        "Pastikan deployment Apps Script diset 'Anyone' (Anyone with the link), bukan 'Only myself'."
                    );
                }
                throw new Error("Response bukan JSON yang valid: " + text.slice(0, 200));
            }

            return data;
        } catch (err) {
            lastErr = err;
            if (API_CONFIG.debug) console.warn(`[api.js] Attempt ${attempt + 1} gagal:`, err.message);

            // Jangan retry untuk error non-transient (semantic)
            const isRetryable =
                /Timeout|Koneksi jaringan|HTTP 5\d\d|HTTP 429/.test(err.message);
            if (!isRetryable || attempt >= retries) break;

            await new Promise(r => setTimeout(r, API_CONFIG.getBackoffMs * (attempt + 1)));
        }
    }

    throw lastErr || new Error("Permintaan gagal tanpa alasan yang jelas.");
}

// ==========================================
// 5. HELPER: SANITASI DATA
// ==========================================
function sanitizeQuestion(q, idx) {
    if (!q || typeof q !== 'object') return null;

    const question = String(q.question ?? '').trim();
    if (!question) return null;

    const tipe = String(q.tipe || 'pg').toLowerCase().trim();
    const options = Array.isArray(q.options)
        ? q.options.map(o => String(o ?? ''))
        : [];

    // PG wajib punya 2+ opsi
    if (tipe === 'pg' && options.filter(o => o.trim()).length < 2) return null;

    return {
        no:          Number.isFinite(Number(q.no)) ? Number(q.no) : (idx + 1),
        category:    String(q.category || 'Umum').trim(),
        question,
        options,
        answer:      q.answer,  // bisa number (PG) atau string (uraian)
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
// 6. PUBLIC API: GET SOAL
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

    if (API_CONFIG.debug) console.log(`[api.js] Loaded ${sanitized.length} soal (dari ${data.length} raw).`);
    return sanitized;
}

// ==========================================
// 7. PUBLIC API: GET PIDATO
// ==========================================
async function apiGetPidato() {
    ensureApiConfigured();
    const url = `${GAS_API_URL}?action=getPidato&_t=${Date.now()}`;
    const data = await fetchJSON(url, { retries: API_CONFIG.getRetries });

    // Jika error → return [] (bukan throw). UI pidato akan render fallback.
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
// 8. PUBLIC API: SUBMIT NILAI + VERIFIKASI
// ==========================================
async function apiSubmitScores(payload) {
    ensureApiConfigured();

    if (!payload || typeof payload !== 'object') {
        throw new Error("Payload nilai tidak valid.");
    }
    const nama = String(payload.nama || '').trim();
    if (!nama) throw new Error("Nama peserta kosong.");
    if (nama.length > 150) throw new Error("Nama peserta terlalu panjang (maks 150 karakter).");

    // Sanitasi payload
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
    const enriched = { ...clean, submissionId, timestamp: new Date().toISOString() };

    // --- (1) POST dengan mode no-cors ---
    try {
        await fetchWithTimeout(GAS_API_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(enriched)
        }, API_CONFIG.timeoutMs);
    } catch (postErr) {
        console.error("[api.js] POST gagal:", postErr);
        throw new Error("Koneksi ke server gagal saat mengirim. Periksa internet lalu coba lagi.");
    }

    // Mode no-cors tidak memberi kita response body.
    // Satu-satunya cara tahu sukses = poll endpoint verify.

    // --- (2) Polling verifikasi ---
    let lastErr;
    for (let attempt = 1; attempt <= API_CONFIG.verifyAttempts; attempt++) {
        await new Promise(r => setTimeout(r, API_CONFIG.verifyBackoffMs * attempt));

        try {
            const url = `${GAS_API_URL}?action=verify&id=${encodeURIComponent(submissionId)}&_t=${Date.now()}`;
            const data = await fetchJSON(url, { timeoutMs: API_CONFIG.verifyTimeoutMs, retries: 0 });

            if (data && (data.success === true || data.result === 'success')) {
                if (API_CONFIG.debug) console.log("[api.js] Submit verified:", submissionId);
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

    // Semua attempt gagal — berikan pesan actionable
    const detail = lastErr ? ` Detail: ${lastErr.message}.` : '';
    const hint = ` Server tidak mengonfirmasi penerimaan setelah ${API_CONFIG.verifyAttempts} percobaan (${Math.round(API_CONFIG.verifyBackoffMs * (1 + 2 + 3) / 1000)}s).${detail}` +
        " Kemungkinan: (a) endpoint 'verify' belum di-deploy di code.gs, " +
        "(b) spreadsheet lambat menulis (coba cek manual), " +
        "(c) deployment belum 'Anyone'. " +
        "PENTING: Periksa sheet HasilUjian terlebih dahulu sebelum submit ulang untuk menghindari duplikasi.";

    throw new Error(hint);
}

// ==========================================
// 9. PUBLIC API: PING (health check)
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

// ==========================================
// 10. PUBLIC API: VERIFY (manual check)
// ==========================================
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
// 11. (OPSIONAL) DEBUG HELPER
// ==========================================
// Aktifkan dari console browser untuk cek koneksi:
//   window.__apiDebug().then(console.log)
window.__apiDebug = async () => {
    const results = {
        url: GAS_API_URL,
        ping: await apiPing(),
        questions: null,
        pidato: null,
        errors: []
    };
    try {
        const q = await apiGetQuestions();
        results.questions = { count: q.length, sample: q[0] || null };
    } catch (e) {
        results.errors.push({ step: 'questions', error: e.message });
    }
    try {
        const p = await apiGetPidato();
        results.pidato = { count: p.length, sample: p[0] ? { id: p[0].id, judul: p[0].judul } : null };
    } catch (e) {
        results.errors.push({ step: 'pidato', error: e.message });
    }
    return results;
};