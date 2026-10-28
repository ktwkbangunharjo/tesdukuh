// ==========================================
// app.js — FULL FIXED VERSION (v5 - Smart Type)
// ==========================================

// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
const ALL_ROUTES = ['#/dashboard', '#/kuis', '#/psikologi', '#/wawancara', '#/komputer', '#/pidato', '#/rapat'];

const State = {
    scores: JSON.parse(localStorage.getItem('dukuh_scores')) || {
        kuis: null, word: null, excel: null, presentasi: null, pidato: null, rapat: null,
        wawancara: null, psikologi: null
    },
    questions: [],
    pidatoList: [],
    quiz: {
        active: false, index: 0, score: 0, pointsPerQ: 0,
        activeQuestions: [], status: [], wrongAnswers: {},
        essayAnswers: {}, mode: 'all', endTime: 0, timer: null,
        autoAdvanceTimer: null, countdownTimer: null
    },
    office: {
        typingActive: false, typingEndTime: 0, wordTimer: null,
        excelActive: false, excelEndTime: 0, excelTimer: null,
        wordPage: 1, excelTab: 1
    },
    ppt: {
        active: false, currentSlide: 0, data: [],
        timer: null
    },
    rapatDrama: { active: false, scenario: 0, step: 0, peace: 100, timer: null, typeTimer: null, nextTimer: null, history: [] },
    wawancara: { active: false, index: 0, score: 0, pointsPerQ: 20, activeQuestions: [], isSpeaking: false },
    psikologi: { active: false, index: 0, score: 0, pointsPerQ: 0, activeQuestions: [] },
    media: {
        isRecording: false, recog: null, keywords: {},
        ttsVoices: [], ttsPlaying: false, ttsPaused: false
    }
};

let pidatoRecog = null;
let pidatoWords = [];
let pidatoMatchCount = 0;
let presRecog = null;

let syncInterval = null;
let speechStartTime = 0;
let currentHighlightIndex = -1;
let wordTimings = [];

const saveScores = () => localStorage.setItem('dukuh_scores', JSON.stringify(State.scores));

// ==========================================
// 2. UTILITIES
// ==========================================
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 400);
    }, 3800);
}

function runTimer(elementId, endTime, onEnd) {
    const update = () => {
        const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
        const el = document.getElementById(elementId);
        if (el) {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            el.innerHTML = `⏱️ Sisa Waktu: ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        if (remaining <= 0) {
            clearInterval(interval);
            const elEnd = document.getElementById(elementId);
            if (elEnd) {
                elEnd.innerHTML = "Waktu Habis!";
                elEnd.style.background = 'var(--danger)';
                elEnd.style.color = 'white';
            }
            try { onEnd(); } catch (e) { console.error("Timer onEnd error:", e); }
        }
    };
    update();
    const interval = setInterval(update, 1000);
    return interval;
}

function levenshteinDistance(a, b) {
    const m = [], rows = b.length, cols = a.length;
    for (let i = 0; i <= rows; i++) m[i] = [i];
    for (let j = 0; j <= cols; j++) m[0][j] = j;
    for (let i = 1; i <= rows; i++) {
        for (let j = 1; j <= cols; j++) {
            m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
                ? m[i - 1][j - 1]
                : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
        }
    }
    return m[rows][cols];
}

function wordSimilarity(a, b) {
    if (a === b) return 1;
    if (a.length < 3 || b.length < 3) return a === b ? 1 : 0;
    const d = levenshteinDistance(a, b);
    return 1 - d / Math.max(a.length, b.length);
}

function cleanWords(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 0);
}

function textMatchPercent(userText, refText) {
    const refWords = cleanWords(refText);
    const userWords = cleanWords(userText);
    if (refWords.length === 0 || userWords.length === 0) return 0;
    let matched = 0, ui = 0;
    for (const rw of refWords) {
        let found = false;
        while (ui < userWords.length) {
            if (wordSimilarity(userWords[ui], rw) >= 0.75) { matched++; ui++; found = true; break; }
            ui++;
        }
        if (!found && ui >= userWords.length) break;
    }
    return Math.round((matched / refWords.length) * 100);
}

// ==========================================
// 3. NAVIGATION
// ==========================================
function initNavigation() {
    const nav = document.getElementById('nav-menu');
    if (!nav) return;
    nav.innerHTML = '';
    const routeMap = {
        '#/dashboard': '📊 Dashboard', '#/kuis': '📝 Tes Tulis',
        '#/psikologi': '🧠 Tes Psikologi', '#/wawancara': '🗣️ Wawancara',
        '#/komputer': '💻 Praktik Komputer', '#/pidato': '🎤 Pidato Jawa',
        '#/rapat': '👥 Simulasi Rapat'
    };
    ALL_ROUTES.forEach(route => {
        const a = document.createElement('a');
        a.href = route;
        a.className = 'nav-link';
        a.innerHTML = routeMap[route];
        nav.appendChild(a);
    });
}

// ==========================================
// 4. DATA FETCHING (SMART TYPE)
// ==========================================
async function loadDataFromServer() {
    try {
        const [questionsData, pidatoData] = await Promise.all([apiGetQuestions(), apiGetPidato()]);
        if (!questionsData || questionsData.length === 0) throw new Error("Data soal dari Spreadsheet kosong.");
        
        // 🔥 SISTEM PINTAR: Normalisasi Tipe Soal
        State.questions = questionsData.map(q => {
            let t = String(q.tipe || 'pg').toLowerCase().trim();
            // Jika mengandung kata 'ura', 'essay', 'isian', jadikan uraian
            if (t.includes('ura') || t.includes('essay') || t.includes('isian') || t.includes('jwb')) {
                t = 'uraian';
            } else {
                // Apapun selain uraian, paksa jadi 'pg' (PG, Pilgan, Pilihan Ganda, dll)
                t = 'pg'; 
            }
            return { ...q, tipe: t };
        });
        
        State.pidatoList = pidatoData || [];
    } catch (err) {
        throw new Error("Gagal memuat data: " + err.message);
    }
}

async function initApp() {
    const loader = document.getElementById('global-loader');
    try {
        loader.classList.remove('hidden');
        await loadDataFromServer();
        loader.style.opacity = '0';
        setTimeout(() => loader.classList.add('hidden'), 500);
        const appEl = document.getElementById('app');
        appEl.classList.remove('hidden');
        setTimeout(() => appEl.classList.add('loaded'), 50);
        initNavigation();
        if (!window.location.hash) window.location.hash = '#/dashboard';
        router();
        if ('speechSynthesis' in window) populateVoices();
    } catch (err) {
        loader.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
                <h2 style="color: var(--danger); margin-bottom: 1rem;">⚠️ Koneksi Gagal</h2>
                <p style="color: var(--text-main); margin-bottom: 1.5rem;">${err.message}</p>
                <button class="btn btn-warning" onclick="location.reload()">🔄 Coba Lagi</button>
            </div>`;
    }
}

async function refreshData() {
    const isBusy = State.quiz.active || State.office.typingActive || State.office.excelActive
        || State.rapatDrama.active || State.wawancara.active || State.psikologi.active || State.ppt.active;
    if (isBusy) {
        if (!confirm("Sesi ujian sedang berjalan. Memperbarui data akan menghentikan sesi. Lanjutkan?")) return;
        location.reload();
        return;
    }
    const btn = document.getElementById('btn-refresh');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Memuat...'; btn.disabled = true;
    try {
        await loadDataFromServer();
        router();
        toast("Data berhasil diperbarui!", "success");
    } catch (err) {
        toast(`Gagal: ${err.message}`, "error");
    } finally {
        btn.innerHTML = originalText; btn.disabled = false;
    }
}

// ==========================================
// 5. ROUTER
// ==========================================
const routes = {
    '#/dashboard': renderDashboard, '#/kuis': renderKuis, '#/komputer': renderKomputer,
    '#/pidato': renderPidato, '#/rapat': renderRapat,
    '#/wawancara': renderWawancara, '#/psikologi': renderPsikologi
};

function clearOnNavigate() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    State.media.ttsPlaying = false;
    State.media.ttsPaused = false;
    if (syncInterval) { cancelAnimationFrame(syncInterval); syncInterval = null; }
    currentHighlightIndex = -1;
    wordTimings = [];

    if (pidatoRecog && State.media.isRecording) { try { pidatoRecog.stop(); } catch (e) {} State.media.isRecording = false; }
    if (presRecog && State.media.isRecording) { try { presRecog.stop(); } catch (e) {} State.media.isRecording = false; }

    if (State.quiz.timer) { clearInterval(State.quiz.timer); State.quiz.timer = null; }
    if (State.office.wordTimer) { clearInterval(State.office.wordTimer); State.office.wordTimer = null; }
    if (State.office.excelTimer) { clearInterval(State.office.excelTimer); State.office.excelTimer = null; }
    if (State.ppt.timer) { clearInterval(State.ppt.timer); State.ppt.timer = null; }
    cancelAutoAdvance();

    if (State.rapatDrama.timer) { clearInterval(State.rapatDrama.timer); State.rapatDrama.timer = null; }
    if (State.rapatDrama.typeTimer) { clearTimeout(State.rapatDrama.typeTimer); State.rapatDrama.typeTimer = null; }
    if (State.rapatDrama.nextTimer) { clearTimeout(State.rapatDrama.nextTimer); State.rapatDrama.nextTimer = null; }
}

function router() {
    clearOnNavigate();

    let hash = window.location.hash || '#/dashboard';
    const renderFn = routes[hash] || routes['#/dashboard'];

    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.getAttribute('href') === hash);
    });

    const container = document.getElementById('view-container');
    if (container) container.innerHTML = renderFn();

    if (hash === '#/dashboard') updateDashboardView();
    if (hash === '#/komputer') initKomputerMenu();
    if (hash === '#/pidato') { loadPidatoText(); populateVoices(); }
    if (hash === '#/rapat' && State.rapatDrama.active) renderDramaStep();
    if (hash === '#/wawancara' && State.wawancara.active) showWawancaraQuestion();
    if (hash === '#/psikologi' && State.psikologi.active) showPsikologiQuestion();

    if (hash === '#/kuis' && State.quiz.active) {
        if (State.quiz.endTime - Date.now() <= 0) { finishQuiz(); return; }
        State.quiz.timer = runTimer('kuis-timer', State.quiz.endTime, () => finishQuiz());
        showQuizQuestion();
    }

    if (hash === '#/komputer' && State.office.typingActive) {
        if (State.office.typingEndTime - Date.now() <= 0) { finishTypingTest(); return; }
        document.getElementById('office-intro')?.classList.add('hidden');
        document.getElementById('office-typing')?.classList.remove('hidden');
        State.office.wordTimer = runTimer('office-timer', State.office.typingEndTime, () => finishTypingTest());
        switchWordPage(State.office.wordPage);
    }

    if (hash === '#/komputer' && State.office.excelActive) {
        if (State.office.excelEndTime - Date.now() <= 0) { finishExcelTest(); return; }
        document.getElementById('excel-intro')?.classList.add('hidden');
        document.getElementById('excel-test')?.classList.remove('hidden');
        State.office.excelTimer = runTimer('excel-timer', State.office.excelEndTime, () => finishExcelTest());
        switchExcelTab(State.office.excelTab);
    }
}
window.addEventListener('hashchange', router);

// ==========================================
// 6. DASHBOARD VIEW
// ==========================================
function renderDashboard() {
    return `
        <div style="text-align: center; margin-bottom: 3rem;">
            <h2 style="font-weight: 800; font-size: 2rem; margin-bottom: 0.5rem; color: var(--text-main);">Laporan Hasil Seleksi</h2>
            <p style="color: var(--text-muted); font-size: 1.1rem;">Selesaikan seluruh modul untuk melihat hasil akhir kelulusan.</p>
        </div>
        <div class="grid" id="dash-cards"></div>
        <div class="final-box">
            <h3>Nilai Akhir Komprehensif</h3>
            <div class="final-score" id="dash-final">-</div>
            <p id="dash-status" style="font-weight: 700; font-size: 1.1rem; letter-spacing: 1px;">MENUNGGU PENYELESAIAN MODUL</p>
        </div>
        <div style="max-width: 500px; margin: 0 auto; background: var(--bg-card); padding: 1.5rem; border-radius: var(--radius-lg); border: 2px solid var(--border);">
            <h4 style="margin-bottom: 1rem; color: var(--text-main); text-align: center;">Kirim Hasil Ujian</h4>
            <input type="text" id="p-name" class="input-field" placeholder="Ketik Nama Lengkap Sesuai KTP..." required>
            <button class="btn btn-warning btn-block" style="font-size: 1.1rem; padding: 1rem;" onclick="syncToServer(this)">🚀 Kirim Nilai ke Server</button>
            <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                <button class="btn btn-success" style="flex:1;" onclick="window.print()">🖨️ Cetak PDF</button>
                <button class="btn btn-danger" style="flex:1;" onclick="if(confirm('Hapus semua nilai dan mulai ulang?')){localStorage.clear();location.reload();}">🗑️ Reset</button>
            </div>
        </div>`;
}

function updateDashboardView() {
    const allMods = [
        { k: 'kuis', n: 'Kuis', icon: '📝' },
        { k: 'psikologi', n: 'Psikologi', icon: '🧠' },
        { k: 'wawancara', n: 'Wawancara', icon: '🗣️' },
        { k: 'word', n: 'Ketik Word', icon: '⌨️' },
        { k: 'excel', n: 'Tabel Excel', icon: '📊' },
        { k: 'presentasi', n: 'Presentasi PPT', icon: '📽️' },
        { k: 'pidato', n: 'Pidato Jawa', icon: '🎤' },
        { k: 'rapat', n: 'Simulasi Rapat', icon: '👥' }
    ];
    let html = '', selesai = 0;
    allMods.forEach(m => {
        const val = State.scores[m.k];
        const isSet = val !== null && val !== undefined;
        if (isSet) selesai++;
        const stat = !isSet ? 'Belum' : (val >= 70 ? 'Lulus' : 'Remedial');
        const color = !isSet ? 'var(--secondary)' : (val >= 70 ? 'var(--success)' : 'var(--danger)');
        const bg = !isSet ? 'var(--bg-main)' : (val >= 70 ? 'var(--success-light)' : 'var(--danger-light)');
        html += `<div class="card"><h4>${m.icon} ${m.n}</h4><div class="card-val">${isSet ? val : '-'}</div><small style="color:${color}; background: ${bg};">${stat}</small></div>`;
    });
    const cardsEl = document.getElementById('dash-cards');
    if (cardsEl) cardsEl.innerHTML = html;

    const required = ['kuis', 'word', 'excel', 'presentasi', 'pidato', 'rapat', 'wawancara', 'psikologi'];
    const complete = required.every(k => State.scores[k] !== null && State.scores[k] !== undefined);
    const finalEl = document.getElementById('dash-final');
    const statusEl = document.getElementById('dash-status');
    if (!finalEl || !statusEl) return;

    if (complete) {
        const rataKomp = (State.scores.word + State.scores.excel + State.scores.presentasi) / 3;
        const rataSos = (State.scores.pidato + State.scores.rapat) / 2;
        const total = (State.scores.kuis * 0.3) + (State.scores.wawancara * 0.1) + (State.scores.psikologi * 0.2) + (rataKomp * 0.2) + (rataSos * 0.2);
        const rounded = Math.round(total);
        finalEl.innerText = rounded;
        if (rounded >= 70) { statusEl.innerText = "STATUS: LULUS"; statusEl.style.color = "#a7f3d0"; }
        else { statusEl.innerText = "STATUS: BELUM LULUS"; statusEl.style.color = "#fca5a5"; }
    } else {
        finalEl.innerText = "-";
        statusEl.innerText = `MENUNGGU PENYELESAIAN (${selesai}/8 Modul Selesai)`;
        statusEl.style.color = "white";
    }
}

// ==========================================
// 7. QUIZ VIEW + CONTROLLER
// ==========================================
function renderKuis() {
    if (!State.quiz.active) {
        const filtered = State.questions;
        if (filtered.length === 0) return `<div class="text-center" style="padding: 3rem 0;"><h3 style="color: var(--warning);">Tidak ada soal di BankSoal.</h3></div>`;
        const totalPg = filtered.filter(q => q.tipe === 'pg').length;
        const totalUraian = filtered.filter(q => q.tipe === 'uraian').length;
        const hasScore = State.scores.kuis !== null && State.scores.kuis !== undefined;
        const warn = hasScore ? `<div style="background: var(--warning-light); color: #92400e; padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--warning); margin-bottom: 1.5rem; font-size: 0.9rem; max-width: 500px; margin-left: auto; margin-right: auto;">⚠️ Anda sudah menyelesaikan kuis dengan skor <b>${State.scores.kuis}</b>. Mengulang akan <b>menimpa</b> skor tersebut.</div>` : '';
        return `
            <div class="text-center" style="padding: 2rem 0;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">📝</div>
                <h2 style="font-size: 2rem; font-weight: 800; margin-bottom: 1rem;">Ujian Tertulis</h2>
                <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 2rem; max-width: 600px; margin-left: auto; margin-right: auto;">
                    Ujian ini menguji pengetahuan Anda tentang Pancasila, Pemerintahan Kalurahan, Keistimewaan DIY, dan Isu Terkini.
                </p>
                ${warn}
                <div style="display: grid; gap: 1rem; max-width: 500px; margin: 0 auto;">
                    <button class="btn btn-block" style="padding: 1.25rem; font-size: 1.1rem; justify-content: space-between;" onclick="startQuiz('all')">
                        <span>📚 Semua Soal</span> <span style="background: rgba(255,255,255,0.2); padding: 0.2rem 0.8rem; border-radius: 20px;">${filtered.length} Soal</span>
                    </button>
                    ${totalPg > 0 ? `<button class="btn btn-success btn-block" style="padding: 1.25rem; font-size: 1.1rem; justify-content: space-between;" onclick="startQuiz('pg')">
                        <span>🔤 Pilihan Ganda</span> <span style="background: rgba(255,255,255,0.2); padding: 0.2rem 0.8rem; border-radius: 20px;">${totalPg} Soal</span>
                    </button>` : ''}
                    ${totalUraian > 0 ? `<button class="btn btn-warning btn-block" style="padding: 1.25rem; font-size: 1.1rem; justify-content: space-between;" onclick="startQuiz('uraian')">
                        <span>✍️ Soal Uraian</span> <span style="background: rgba(255,255,255,0.2); padding: 0.2rem 0.8rem; border-radius: 20px;">${totalUraian} Soal</span>
                    </button>` : ''}
                </div>
            </div>`;
    }
    return `
        <div class="timer-badge" id="kuis-timer">⏱️ Sisa Waktu: --:--</div>
        <div style="display: flex; justify-content: space-between; font-weight: 700; color: var(--text-muted); margin-bottom: 1rem;">
            <span>Soal <span id="q-idx" style="color: var(--primary); font-size: 1.2rem;">1</span>/${State.quiz.activeQuestions.length}</span>
            <span>Skor Sementara: <span id="q-score" style="color: var(--success); font-size: 1.2rem;">0</span></span>
        </div>
        <div class="q-nav-container" id="q-navigator"></div>
        <div class="progress-bar"><div class="progress-fill" id="q-progress"></div></div>
        <div id="q-text" style="font-size: 1.4rem; font-weight: 700; margin-bottom: 2rem; line-height: 1.5; color: var(--text-main);"></div>
        <div id="q-options"></div>
        <div class="explanation" id="q-exp"></div>
        <button class="btn btn-block" id="q-next" style="margin-top: 2rem; padding: 1rem; font-size: 1.1rem;" onclick="nextQuizQuestion()" disabled>Lanjut Soal Berikutnya ➔</button>`;
}

function resolveCorrectIndex(q) {
    const raw = q.answer;
    if (typeof raw === 'number' && raw >= 0 && raw <= 3) return raw;
    const str = String(raw || '').trim();
    if (/^[0-3]$/.test(str)) return parseInt(str);
    if (/^[A-D][\.\s]*$/i.test(str)) return ['A','B','C','D'].indexOf(str.charAt(0).toUpperCase());
    const clean = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const cleanKey = clean(str);
    let idx = q.options.findIndex(o => clean(o) === cleanKey);
    if (idx === -1) idx = q.options.findIndex(o => clean(o).includes(cleanKey) || cleanKey.includes(clean(o)));
    return idx;
}

function cancelAutoAdvance() {
    if (State.quiz.autoAdvanceTimer) { clearTimeout(State.quiz.autoAdvanceTimer); State.quiz.autoAdvanceTimer = null; }
    if (State.quiz.countdownTimer) { clearInterval(State.quiz.countdownTimer); State.quiz.countdownTimer = null; }
}

function startAutoAdvance(seconds) {
    cancelAutoAdvance();
    const answeredIndex = State.quiz.index;
    const nextBtn = document.getElementById('q-next');
    if (!nextBtn) return;

    let remaining = seconds;
    const renderBtnText = () => {
        nextBtn.innerText = `⏳ Lanjut otomatis dalam ${remaining}s — klik untuk langsung`;
    };
    renderBtnText();
    nextBtn.disabled = false;

    State.quiz.countdownTimer = setInterval(() => {
        remaining--;
        if (remaining > 0) renderBtnText();
    }, 1000);

    State.quiz.autoAdvanceTimer = setTimeout(() => {
        cancelAutoAdvance();
        if (State.quiz.active && State.quiz.index === answeredIndex) {
            autoAdvanceFrom(answeredIndex);
        }
    }, seconds * 1000);
}

function autoAdvanceFrom(currentIdx) {
    if (!State.quiz.active) return;
    for (let i = currentIdx + 1; i < State.quiz.activeQuestions.length; i++) {
        if (State.quiz.status[i] === 'unanswered') {
            State.quiz.index = i;
            showQuizQuestion();
            return;
        }
    }
    const skipped = State.quiz.status.findIndex(s => s === 'unanswered');
    if (skipped !== -1) {
        State.quiz.index = skipped;
        showQuizQuestion();
        return;
    }
    finishQuiz();
}

function startQuiz(mode) {
    let filtered = State.questions;
    if (mode === 'pg') filtered = filtered.filter(q => q.tipe === 'pg');
    if (mode === 'uraian') filtered = filtered.filter(q => q.tipe === 'uraian');
    if (filtered.length === 0) return toast("Tidak ada soal untuk kategori ini.", "warning");

    if (State.scores.kuis !== null && State.scores.kuis !== undefined) {
        if (!confirm(`Skor kuis Anda (${State.scores.kuis}) akan ditimpa jika Anda menyelesaikan ulang. Lanjutkan?`)) return;
    }

    cancelAutoAdvance();
    if (State.quiz.timer) { clearInterval(State.quiz.timer); State.quiz.timer = null; }

    State.quiz = {
        active: true, index: 0, score: 0, pointsPerQ: 100 / filtered.length,
        activeQuestions: filtered, status: new Array(filtered.length).fill('unanswered'),
        wrongAnswers: {}, essayAnswers: {}, mode, endTime: 0, timer: null,
        autoAdvanceTimer: null, countdownTimer: null
    };
    
    const timeLimit = Math.max(7200, filtered.length * 60);
    State.quiz.endTime = Date.now() + timeLimit * 1000;

    router();
    State.quiz.timer = runTimer('kuis-timer', State.quiz.endTime, () => finishQuiz());
    showQuizQuestion();
}

function renderNavigator() {
    const nav = document.getElementById('q-navigator');
    if (!nav) return;
    nav.innerHTML = '';
    State.quiz.activeQuestions.forEach((q, i) => {
        const box = document.createElement('div');
        box.className = 'q-nav-box';
        if (i === State.quiz.index) box.classList.add('active');
        const st = State.quiz.status[i];
        if (st === 'correct') box.classList.add('correct');
        else if (st === 'wrong') box.classList.add('wrong');
        else if (st === 'answered') box.classList.add('answered');
        box.innerText = i + 1;
        box.onclick = () => jumpToQuestion(i);
        nav.appendChild(box);
    });
}

function jumpToQuestion(i) {
    cancelAutoAdvance();
    State.quiz.index = i;
    showQuizQuestion();
}

function showQuizQuestion() {
    const q = State.quiz.activeQuestions[State.quiz.index];
    document.getElementById('q-idx').innerText = State.quiz.index + 1;
    document.getElementById('q-text').innerText = q.question;
    const currentStatus = State.quiz.status[State.quiz.index];
    const isLast = State.quiz.index === State.quiz.activeQuestions.length - 1;

    if (q.tipe === 'uraian') {
        document.getElementById('q-options').innerHTML = `<textarea id="q-essay-input" class="input-field" style="height: 180px; font-family: inherit; font-size: 1.1rem; resize: vertical; line-height: 1.6;" placeholder="Ketik jawaban uraian Anda di sini (minimal 30 karakter)..."></textarea>`;
        const ta = document.getElementById('q-essay-input');
        ta.value = State.quiz.essayAnswers[State.quiz.index] || '';
        ta.addEventListener('input', (e) => { State.quiz.essayAnswers[State.quiz.index] = e.target.value; });
        if (currentStatus !== 'unanswered') ta.disabled = true;
        document.getElementById('q-exp').style.display = 'none';
        document.getElementById('q-next').disabled = false;
        document.getElementById('q-next').innerText = isLast ? "Selesai & Simpan" : "Lanjut Soal Berikutnya ➔";
    } else {
        const correctIdx = resolveCorrectIndex(q);
        const wrongIdx = State.quiz.wrongAnswers[State.quiz.index];
        const optsHtml = q.options.map((opt, i) => {
            let cls = 'option';
            if (currentStatus !== 'unanswered') {
                if (i === correctIdx) cls += ' correct';
                else if (currentStatus === 'wrong' && i === wrongIdx) cls += ' wrong';
            }
            return `<div class="${cls}" onclick="answerQuiz(${i}, this)" style="${currentStatus !== 'unanswered' ? 'pointer-events:none;' : ''}">
                <div class="option-letter">${String.fromCharCode(65 + i)}</div>
                <div>${opt}</div>
            </div>`;
        }).join('');
        document.getElementById('q-options').innerHTML = optsHtml;

        if (currentStatus !== 'unanswered') {
            document.getElementById('q-exp').innerHTML = `<b>💡 Pembahasan:</b> ${q.explanation || 'Tidak ada pembahasan.'}`;
            document.getElementById('q-exp').style.display = 'block';
            document.getElementById('q-next').disabled = false;
        } else {
            document.getElementById('q-exp').style.display = 'none';
            document.getElementById('q-next').disabled = true;
        }
        document.getElementById('q-next').innerText = isLast ? "Selesai & Simpan" : "Lanjut Soal Berikutnya ➔";
    }
    document.getElementById('q-progress').style.width = `${((State.quiz.index + 1) / State.quiz.activeQuestions.length) * 100}%`;
    renderNavigator();
}

function answerQuiz(idx, el) {
    const q = State.quiz.activeQuestions[State.quiz.index];
    const opts = document.getElementById('q-options').children;
    for (let o of opts) o.style.pointerEvents = 'none';
    const correctIdx = resolveCorrectIndex(q);
    const isCorrect = idx === correctIdx;
    if (isCorrect) {
        el.classList.add('correct');
        State.quiz.score += State.quiz.pointsPerQ;
        State.quiz.status[State.quiz.index] = 'correct';
    } else {
        el.classList.add('wrong');
        if (correctIdx >= 0 && correctIdx < opts.length) opts[correctIdx].classList.add('correct');
        State.quiz.status[State.quiz.index] = 'wrong';
        State.quiz.wrongAnswers[State.quiz.index] = idx;
    }
    document.getElementById('q-score').innerText = Math.round(State.quiz.score);
    document.getElementById('q-exp').innerHTML = `<b>💡 Pembahasan:</b> ${q.explanation || 'Tidak ada pembahasan.'}`;
    document.getElementById('q-exp').style.display = 'block';
    renderNavigator();
    startAutoAdvance(2);
}

function evaluateEssay(userAnswer, correctAnswerText) {
    if (!correctAnswerText || typeof correctAnswerText !== 'string') return true;
    const clean = s => s.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const cleanUser = clean(userAnswer);
    const cleanRef = clean(correctAnswerText);
    const refKeywords = cleanRef.split(/\s+/).filter(w => w.length > 3);
    if (refKeywords.length === 0) return true;
    let match = 0;
    refKeywords.forEach(k => { if (cleanUser.includes(k)) match++; });
    return ((match / refKeywords.length) * 100) >= 40;
}

function nextQuizQuestion() {
    cancelAutoAdvance();
    const q = State.quiz.activeQuestions[State.quiz.index];

    if (q.tipe === 'uraian' && State.quiz.status[State.quiz.index] === 'unanswered') {
        const ta = document.getElementById('q-essay-input');
        const userText = ((ta && ta.value) || State.quiz.essayAnswers[State.quiz.index] || '').trim();
        if (userText.length < 30) return toast("Jawaban terlalu pendek. Minimal 30 karakter.", "warning");
        if (evaluateEssay(userText, q.answer)) {
            State.quiz.score += State.quiz.pointsPerQ;
            document.getElementById('q-score').innerText = Math.round(State.quiz.score);
            toast("Jawaban sesuai kunci. Poin ditambahkan.", "success");
        } else {
            toast("Jawaban kurang lengkap/kurang tepat.", "warning");
        }
        State.quiz.status[State.quiz.index] = 'answered';
        renderNavigator();
    }

    autoAdvanceFrom(State.quiz.index);
}

function finishQuiz() {
    if (!State.quiz.active) return;
    cancelAutoAdvance();
    if (State.quiz.timer) { clearInterval(State.quiz.timer); State.quiz.timer = null; }
    State.scores.kuis = Math.round(State.quiz.score);
    saveScores();
    State.quiz.active = false;
    window.location.hash = '#/dashboard';
    toast(`Ujian Selesai! Skor Anda: ${State.scores.kuis}`, "success");
}

// ==========================================
// 8. PSIKOLOGI
// ==========================================
const PsikoData = [
    { q: "Semua Dukuh adalah pemimpin. Sebagian pemimpin adalah pendengar yang baik. Maka...", opts: ["Semua Dukuh pendengar yang baik.", "Sebagian Dukuh adalah pendengar yang baik.", "Tidak ada Dukuh yang pendengar baik.", "Semua pendengar baik adalah Dukuh."], ans: 1 },
    { q: "Jika hujan turun, jalan menjadi basah. Jalan tidak basah. Kesimpulannya...", opts: ["Hujan turun.", "Hujan tidak turun.", "Jalan tetap kering.", "Tidak bisa disimpulkan."], ans: 1 },
    { q: "Analogi: Dokter : Rumah Sakit = Petani : ...", opts: ["Cangkul", "Sawah", "Padi", "Traktor"], ans: 1 },
    { q: "Analogi: Kepala Dukuh : Padukuhan = Lurah : ...", opts: ["Kecamatan", "Kalurahan", "Kabupaten", "Provinsi"], ans: 1 },
    { q: "Semua A adalah B. Semua B adalah C. Maka...", opts: ["Semua C adalah A.", "Semua A adalah C.", "Sebagian C adalah A.", "Tidak ada kesimpulan."], ans: 1 },
    { q: "Andi lebih tua dari Budi. Budi lebih tua dari Cici. Siapa yang paling muda?", opts: ["Andi", "Budi", "Cici", "Tidak tahu"], ans: 2 },
    { q: "Jika 3 ekor sapi memakan rumput 3 lapangan dalam 3 hari. Berapa lapangan yang dimakan 6 sapi dalam 6 hari?", opts: ["6 lapangan", "9 lapangan", "12 lapangan", "18 lapangan"], ans: 2 },
    { q: "Buku A lebih tebal dari Buku B. Buku C lebih tipis dari Buku A. Buku B lebih tebal dari Buku C. Siapa yang paling tebal?", opts: ["Buku A", "Buku B", "Buku C", "Buku D"], ans: 0 },
    { q: "Analogi: Uang : Dompet = Air : ...", opts: ["Gelas", "Minum", "Haus", "Hujan"], ans: 0 },
    { q: "Anda melihat 5 burung di pohon. Anda menembak 1. Berapa sisa burung di pohon?", opts: ["4", "1", "0", "5"], ans: 2 },
    { q: "Sebuah jam dinding berdentang 6 kali dalam 5 detik. Berapa waktu yang dibutuhkan untuk berdentang 12 kali?", opts: ["10 detik", "11 detik", "12 detik", "15 detik"], ans: 1 },
    { q: "Analogi: Rumah : Atap = Tubuh : ...", opts: ["Kaki", "Tangan", "Kepala", "Rambut"], ans: 2 },
    { q: "Jika Anda berjalan 10 meter ke utara, lalu 10 meter ke selatan. Di mana posisi Anda?", opts: ["10 meter dari awal", "Di tempat awal", "20 meter dari awal", "Tidak tahu"], ans: 1 },
    { q: "Semua bunga mawar berwarna merah. Sebagian bunga di taman adalah mawar. Maka...", opts: ["Semua bunga di taman merah.", "Sebagian bunga di taman merah.", "Tidak ada bunga merah.", "Semua merah adalah mawar."], ans: 1 },
    { q: "Mana yang tidak sekelompok?", opts: ["Apel", "Jeruk", "Mangga", "Wortel"], ans: 3 },
    { q: "Mana yang tidak sekelompok?", opts: ["Dukuh", "Lurah", "Bupati", "Guru"], ans: 3 },
    { q: "Kebalikan dari 'Abadi' adalah...", opts: ["Kekal", "Fana", "Lestari", "Awet"], ans: 1 },
    { q: "Kebalikan dari 'Sederhana' adalah...", opts: ["Mewah", "Kaya", "Boros", "Hemat"], ans: 0 },
    { q: "Analogi: Buku : Halaman = Tangga : ...", opts: ["Kayu", "Anak Tangga", "Rumah", "Bangunan"], ans: 1 },
    { q: "Jika P > Q dan Q > R, maka...", opts: ["P < R", "P > R", "P = R", "R > P"], ans: 1 },
    { q: "Anda mendapati dua warga bersitegang masalah batas tanah. Warga A membawa parang. Apa tindakan pertama Anda?", opts: ["Membiarkan mereka.", "Mendekati Warga A dengan tenang, meminta parangnya diturunkan, lalu memisahkan mereka.", "Memarahi keduanya."], ans: 1 },
    { q: "Ada tawaran proyek dari pihak swasta. Mereka menawarkan 'uang pelicin'. Sebagai Dukuh, Anda...", opts: ["Menerima uang untuk kas padukuhan.", "Menolak tegas dan menjelaskan bahwa semua harus sesuai prosedur.", "Menerima uangnya diam-diam."], ans: 1 },
    { q: "Anda memiliki 3 agenda mendesak: 1) Rapat di Kapanewon, 2) Warga sakit, 3) Tamu Dinas. Prioritas Anda?", opts: ["Mendelegasikan urusan warga, pergi ke rapat.", "Membatalkan semua agenda dan menangani warga sakit.", "Menugaskan staf mengurus warga sakit, lalu minta izin telat rapat."], ans: 1 },
    { q: "Proyek jembatan gagal karena kontraktor kabur. Warga sangat marah. Anda...", opts: ["Menyalahkan kontraktor.", "Meminta maaf, menjelaskan kronologinya, dan berjanji mencari solusi.", "Menghindari warga."], ans: 1 },
    { q: "Warga kaya meminta izin memotong jalan lingkungan demi memperluas rumah. Warga lain resah. Anda...", opts: ["Mengizinkan karena dia menyumbang.", "Menolak tegas karena jalan umum tidak boleh diprivatisasi.", "Mengizinkan tapi minta uang kompensasi."], ans: 1 },
    { q: "Pemuda di padukuhan sering mabuk-mabukan. Anda...", opts: ["Melaporkan ke polisi.", "Mendekati secara personal dan menawarkan wadah Karang Taruna.", "Membiarkan saja."], ans: 1 },
    { q: "Warga RT 01 dan RT 02 berselisih soal jadwal ronda. Anda...", opts: ["Memarahi RT 02.", "Mempertemukan kedua ketua RT dan menyusun ulang jadwal adil.", "Membiarkan saja."], ans: 1 },
    { q: "Ada laporan staf Anda melakukan pungli (pungutan liar).", opts: ["Langsung memecat staf.", "Memanggil staf, klarifikasi internal, dan mencari bukti.", "Mengabaikan laporan."], ans: 1 },
    { q: "Musim kemarau menyebabkan sumur warga kering. Dana terbatas. Anda...", opts: ["Meminta warga menampung air hujan.", "Bersama warga gotong royong mencari sumber mata air.", "Menyalahkan cuaca."], ans: 1 },
    { q: "Tokoh masyarakat sering mengkritik kebijakan Anda di depan umum.", opts: ["Mengucilkan tokoh tersebut.", "Mengajaknya berdiskusi secara pribadi (empat mata).", "Membalas kritikannya."], ans: 1 },
    { q: "Anda melihat warga membuang sampah ke sungai. Tindakan Anda?", opts: ["Membiarkan karena itu hak warga.", "Menegur dengan sopan dan mengingatkan tentang banjir.", "Melaporkan langsung ke polisi."], ans: 1 },
    { q: "Warga meminta bantuan dana untuk hajatan, namun kas padukuhan kosong. Anda...", opts: ["Memberikan janji palsu.", "Menjelaskan kondisi kas secara transparan dan menawarkan bantuan tenaga.", "Memarahi warga karena meminta terus."], ans: 1 },
    { q: "Saat rapat, ada warga yang terus memotong pembicaraan Anda. Anda...", opts: ["Membentaknya.", "Mempersilakannya bicara dulu, lalu menanggapi dengan tenang.", "Mengabaikannya."], ans: 1 },
    { q: "Anda dihadapkan pada dua warga yang berebut bantuan sosial. Anda...", opts: ["Membaginya dua secara paksa.", "Mengecek data TKSK siapa yang lebih berhak.", "Mengembalikan uang ke pemerintah."], ans: 1 },
    { q: "Seorang warga meminta Anda memalsukan surat keterangan miskin. Anda...", opts: ["Menuruti karena kasihan.", "Menolak tegas karena melanggar hukum.", "Meminta uang imbalan."], ans: 1 },
    { q: "Pemuda padukuhan ingin membuat kegiatan yang berisiko (balap liar). Anda...", opts: ["Mengizinkan.", "Mengarahkan mereka ke kegiatan positif/olahraga resmi.", "Melarang tanpa penjelasan."], ans: 1 },
    { q: "Warga lansia mengeluh kesulitan mengambil bantuan. Anda...", opts: ["Menyuruhnya mengambil sendiri.", "Mengantarkan bantuan langsung ke rumahnya.", "Meminta RT yang mengurus."], ans: 1 },
    { q: "Ada tawaran menjadi pengurus partai politik tertentu. Sebagai Dukuh, Anda...", opts: ["Menerima untuk mencari kekuatan.", "Menolak karena Dukuh harus netral.", "Menerima diam-diam."], ans: 1 },
    { q: "Warga Anda ada yang meninggal tapi tidak ada ahli waris. Anda...", opts: ["Membiarkan jenazah terbengkalai.", "Mengkoordinasi pemakaman secara kekeluargaan dan adat.", "Melaporkan ke media sosial."], ans: 1 },
    { q: "Anda salah mengeluarkan kebijakan yang membuat warga rugi. Anda...", opts: ["Menyalahkan staf.", "Meminta maaf secara terbuka dan segera memperbaiki kesalahan.", "Pura-pura tidak tahu."], ans: 1 },
    { q: "Saat Anda berbicara di forum, ada warga yang menertawakan Anda. Anda...", opts: ["Marah dan meninggalkan forum.", "Tetap tenang dan melanjutkan pembicaraan.", "Membalas dengan ejekan."], ans: 1 },
    { q: "Bantuan sembako dari pemerintah datang terlambat. Warga marah. Anda...", opts: ["Menyalahkan pemerintah pusat.", "Menjelaskan proses pengiriman dan meredakan emosi warga.", "Bersembunyi di rumah."], ans: 1 },
    { q: "Staf Anda bekerja lambat. Anda...", opts: ["Memarahinya di depan umum.", "Menegurnya secara pribadi dan mencari tahu kendalanya.", "Menggantikannya."], ans: 1 },
    { q: "Warga ingin menjual tanah warisan untuk berfoya-foya. Anda...", opts: ["Membiarkan.", "Mengingatkan agar uang digunakan untuk hal produktif.", "Meminta bagian."], ans: 1 },
    { q: "Ada warga baru yang belum melapor ke RT. Anda...", opts: ["Mengusirnya.", "Mendatangi dan meminta melengkapi administrasi dengan ramah.", "Mengabaikannya."], ans: 1 },
    { q: "Anda diminta memimpin doa di acara lintas agama. Anda...", opts: ["Menolak.", "Memberikan kesempatan pemuka agama untuk memimpin doa.", "Memaksa doa sesuai agama Anda."], ans: 1 },
    { q: "Anggota keluarga Anda ingin diprioritaskan dalam proyek padukuhan. Anda...", opts: ["Memprioritaskannya.", "Menolak dan tetap profesional sesuai aturan.", "Memberi jatah kecil."], ans: 1 },
    { q: "Warga mengeluh jalan rusak. Anda belum punya dana. Anda...", opts: ["Berdiam diri.", "Mengajak gotong royong sementara dan mengusulkan dana ke Kalurahan.", "Menyalahkan cuaca."], ans: 1 },
    { q: "Seorang warga meminta Anda menjadi juru damai masalah keluarga, tapi Anda tidak sanggup. Anda...", opts: ["Memaksakan diri.", "Merujuk ke pihak yang lebih ahli (psikolog/tokoh agama).", "Mengabaikannya."], ans: 1 },
    { q: "Sebagai Dukuh, Anda menerima laporan bahwa ada warga yang mencuri listrik. Sikap Anda?", opts: ["Diamkan.", "Tegur, edukasi bahayanya, dan bantu proses pemasangan resmi.", "Umumkan ke seluruh warga."], ans: 1 },
    { q: "Ada warga yang menolak vaksinasi anak karena alasan pribadi. Anda...", opts: ["Memaksa.", "Memberi edukasi bersama tenaga kesehatan.", "Membiarkan sepenuhnya."], ans: 1 }
];

function renderPsikologi() {
    if (!State.psikologi.active) {
        return `
            <div class="text-center" style="padding: 2rem 0;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">🧠</div>
                <h2 style="font-size: 2rem; font-weight: 800; margin-bottom: 1rem;">Tes Psikologi (SJT)</h2>
                <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 2.5rem; max-width: 600px; margin-left: auto; margin-right: auto;">
                    Tes Situational Judgment mengukur integritas, ketangguhan mental, dan pengambilan keputusan etis.
                </p>
                <button class="btn btn-block" style="font-size: 1.2rem; padding: 1.25rem; max-width: 400px; margin: 0 auto;" onclick="startPsikologi()">Mulai Tes Psikologi</button>
            </div>`;
    }
    return `
        <div class="progress-bar"><div class="progress-fill" id="p-progress"></div></div>
        <div style="text-align: center; font-weight: 700; color: var(--text-muted); margin-bottom: 2rem;">
            Situasi <span id="p-idx" style="color: var(--primary);">1</span> dari ${State.psikologi.activeQuestions.length}
        </div>
        <div style="background: var(--primary-light); padding: 2rem; border-radius: var(--radius-lg); border: 2px solid var(--primary); margin-bottom: 2rem; box-shadow: var(--shadow-sm);">
            <span style="color: var(--primary); font-weight: 800; font-size: 0.9rem; display: block; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 1px;">Situasi yang Anda Hadapi:</span>
            <p style="font-size: 1.3rem; font-weight: 700; line-height: 1.6; color: var(--text-main);" id="p-text-situation"></p>
        </div>
        <div id="p-options" style="display: flex; flex-direction: column; gap: 1rem;"></div>`;
}

function startPsikologi() {
    State.psikologi = {
        active: true, index: 0, score: 0,
        pointsPerQ: 100 / PsikoData.length,
        activeQuestions: PsikoData
    };
    router();
    showPsikologiQuestion();
}

function showPsikologiQuestion() {
    const q = State.psikologi.activeQuestions[State.psikologi.index];
    document.getElementById('p-idx').innerText = State.psikologi.index + 1;
    document.getElementById('p-text-situation').innerText = q.q;
    const optsHtml = q.opts.map((opt, i) =>
        `<div class="option" style="border-color: var(--primary);" onclick="answerPsikologi(${i}, this)">
            <div class="option-letter" style="background: var(--primary-light); color: var(--primary);">${String.fromCharCode(65 + i)}</div>
            <div>${opt}</div>
        </div>`).join('');
    document.getElementById('p-options').innerHTML = optsHtml;
    document.getElementById('p-progress').style.width = `${((State.psikologi.index + 1) / State.psikologi.activeQuestions.length) * 100}%`;
}

function answerPsikologi(idx, btn) {
    const q = State.psikologi.activeQuestions[State.psikologi.index];
    const opts = document.getElementById('p-options').children;
    for (let o of opts) o.style.pointerEvents = 'none';
    if (idx === q.ans) {
        btn.classList.add('correct');
        State.psikologi.score += State.psikologi.pointsPerQ;
    } else {
        btn.classList.add('wrong');
        if (opts[q.ans]) opts[q.ans].classList.add('correct');
    }
    setTimeout(() => {
        if (window.location.hash !== '#/psikologi' || !State.psikologi.active) return;
        State.psikologi.index++;
        if (State.psikologi.index < State.psikologi.activeQuestions.length) showPsikologiQuestion();
        else finishPsikologi();
    }, 1500);
}

function finishPsikologi() {
    State.scores.psikologi = Math.round(State.psikologi.score);
    saveScores();
    State.psikologi.active = false;
    window.location.hash = '#/dashboard';
    toast(`Tes Psikologi Selesai! Skor Anda: ${State.scores.psikologi}`, "success");
}

// ==========================================
// 9. WAWANCARA
// ==========================================
const InterviewData = [
    { q: "Menurut Anda, apa VISI dan MISI utama yang harus dibawa untuk memajukan Padukuhan ini 5 tahun ke depan?", opts: ["Fokus pada pembangunan fisik jalan dan jembatan saja.", "Pemberdayaan SDM (Pemuda & UMKM) serta digitalisasi layanan padukuhan.", "Mengikuti semua program pemerintah tanpa inovasi."], ans: 1 },
    { q: "Apa alasan utama dan motivasi terbesar Anda mencalonkan diri sebagai Pamong Dukuh (Dukuh)?", opts: ["Ingin memiliki kekuasaan dan mempermudah urusan pribadi.", "Ingin mengabdi dan membantu menyelesaikan permasalahan warga secara langsung.", "Karena diminta oleh teman dan tidak ada pekerjaan lain."], ans: 1 },
    { q: "Sebutkan kelebihan (hard skill & soft skill) yang Anda miliki yang membuat Anda layak dipilih sebagai Dukuh!", opts: ["Kaya raya dan bisa membiayai kegiatan sendiri.", "Mampu berkomunikasi baik, berjiwa pemimpin, dan paham administrasi pemerintahan.", "Punya banyak massa pendukung."], ans: 1 },
    { q: "Bagaimana tanggapan Anda jika ada warga yang menolak program kerja Anda di forum rapat?", opts: ["Tetap melaksanakan program karena saya yang berkuasa.", "Mendengarkan alasannya, berdiskusi mencari titik temu, dan transparan terkait tujuan program.", "Mengeluarkan warga tersebut dari forum."], ans: 1 },
    { q: "Apabila Anda terpilih menjadi Dukuh, langkah konkret pertama apa yang akan Anda lakukan di bulan pertama?", opts: ["Merombak semua staf dan perangkat desa.", "Melakukan pendataan ulang warga, evaluasi program lama, dan silaturahmi ke RT/RW.", "Menaikkan iuran bulanan warga."], ans: 1 }
];

function renderWawancara() {
    if (!State.wawancara.active) {
        return `
            <div class="text-center" style="padding: 2rem 0;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">🗣️</div>
                <h2 style="font-size: 2rem; font-weight: 800; margin-bottom: 1rem;">Simulasi Tes Wawancara</h2>
                <p style="color: var(--text-muted); font-size: 1.1rem; margin-bottom: 2.5rem; max-width: 600px; margin-left: auto; margin-right: auto;">
                    Uji kepribadian, integritas, dan pemahaman Tupoksi Anda sebagai Calon Dukuh di hadapan Penguji.
                </p>
                <button class="btn btn-block" style="font-size: 1.2rem; padding: 1.25rem; max-width: 400px; margin: 0 auto;" onclick="startWawancara()">Mulai Wawancara</button>
            </div>`;
    }
    return `
        <div class="progress-bar"><div class="progress-fill" id="w-progress"></div></div>
        <div style="text-align: center; font-weight: 700; color: var(--text-muted); margin-bottom: 2rem;">
            Pertanyaan <span id="w-idx" style="color: var(--primary);">1</span> dari ${State.wawancara.activeQuestions.length}
        </div>
        <div style="background: var(--bg-card); padding: 2rem; border-radius: var(--radius-lg); border-left: 6px solid var(--primary); margin-bottom: 2rem; position: relative; box-shadow: var(--shadow-md);">
            <div style="display: flex; gap: 1.5rem; align-items: flex-start;">
                <div style="width: 70px; height: 70px; border-radius: 50%; background: #1e293b; display: flex; align-items: center; justify-content: center; font-size: 40px; flex-shrink: 0; border: 3px solid var(--primary); box-shadow: var(--shadow-sm);">👨‍🏫</div>
                <div style="flex: 1;">
                    <span style="color: var(--primary); font-weight: 800; font-size: 1rem; display: block; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 1px;">Pewawancara:</span>
                    <p style="font-size: 1.3rem; font-weight: 600; line-height: 1.6; font-family: 'Lora', serif; font-style: italic;">"<span id="w-text"></span>"</p>
                </div>
            </div>
            <button class="btn btn-secondary" style="position: absolute; top: 1.5rem; right: 1.5rem; padding: 0.6rem; border-radius: 50%;" onclick="playWawancaraVoice()" title="Dengarkan Suara Penguji">🔊</button>
        </div>
        <div id="w-options" style="display: flex; flex-direction: column; gap: 1rem;"></div>`;
}

function startWawancara() {
    State.wawancara = {
        active: true, index: 0, score: 0,
        pointsPerQ: 100 / InterviewData.length,
        activeQuestions: InterviewData, isSpeaking: false
    };
    router();
    showWawancaraQuestion();
}

function speakWawancaraText(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    const voices = State.media.ttsVoices;
    let v = voices.find(x => x.name.toLowerCase().includes('male') || x.name.toLowerCase().includes('ardi'));
    if (v) u.voice = v;
    u.pitch = 0.9; u.rate = 0.95;
    setTimeout(() => window.speechSynthesis.speak(u), 250);
}

function playWawancaraVoice() {
    const el = document.getElementById('w-text');
    if (el && el.innerText) speakWawancaraText(el.innerText);
}

function showWawancaraQuestion() {
    const q = State.wawancara.activeQuestions[State.wawancara.index];
    document.getElementById('w-idx').innerText = State.wawancara.index + 1;
    document.getElementById('w-text').innerText = q.q;
    speakWawancaraText(q.q);
    const optsHtml = q.opts.map((opt, i) =>
        `<div class="option" onclick="answerWawancara(${i}, this)">
            <div class="option-letter">${String.fromCharCode(65 + i)}</div>
            <div>${opt}</div>
        </div>`).join('');
    document.getElementById('w-options').innerHTML = optsHtml;
    document.getElementById('w-progress').style.width = `${((State.wawancara.index + 1) / State.wawancara.activeQuestions.length) * 100}%`;
}

function answerWawancara(idx, btn) {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const q = State.wawancara.activeQuestions[State.wawancara.index];
    const opts = document.getElementById('w-options').children;
    for (let o of opts) o.style.pointerEvents = 'none';
    if (idx === q.ans) {
        btn.classList.add('correct');
        State.wawancara.score += State.wawancara.pointsPerQ;
    } else {
        btn.classList.add('wrong');
        if (opts[q.ans]) opts[q.ans].classList.add('correct');
    }
    setTimeout(() => {
        if (window.location.hash !== '#/wawancara' || !State.wawancara.active) return;
        State.wawancara.index++;
        if (State.wawancara.index < State.wawancara.activeQuestions.length) showWawancaraQuestion();
        else finishWawancara();
    }, 2000);
}

function finishWawancara() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    State.scores.wawancara = Math.round(State.wawancara.score);
    saveScores();
    State.wawancara.active = false;
    window.location.hash = '#/dashboard';
    toast(`Sesi Wawancara Selesai! Skor Anda: ${State.scores.wawancara}`, "success");
}

// ==========================================
// 10. KOMPUTER (Word/Excel/PPT)
// ==========================================
function renderKomputer() {
    return `
        <div class="text-center" style="margin-bottom: 2rem;">
            <h2 style="font-weight: 800; font-size: 2rem; margin-bottom: 0.5rem;">Praktik Komputer</h2>
            <p style="color: var(--text-muted);">Uji kemampuan administrasi perkantoran Anda.</p>
        </div>
        <div class="sub-tabs">
            <div class="sub-tab active" onclick="showKomputerTab('tab-office')">1. Mengetik Word</div>
            <div class="sub-tab" onclick="showKomputerTab('tab-excel')">2. Tabel Excel</div>
            <div class="sub-tab" onclick="showKomputerTab('tab-ppt')">3. Presentasi PPT</div>
        </div>
        <div id="tab-office">
            <div id="office-intro" class="text-center" style="padding: 3rem 0;">
                <h3 style="margin-bottom: 1rem; font-size: 1.5rem;">Simulasi Mengetik Surat</h3>
                <p style="color: var(--text-muted); margin-bottom: 2rem;">Ketik ulang surat undangan resmi dan lampirannya. (Waktu: 5 Menit)</p>
                <button class="btn" style="padding: 1rem 3rem; font-size: 1.1rem;" onclick="startTypingTest()">Mulai Mengetik</button>
            </div>
            <div id="office-typing" class="hidden">
                <div class="timer-badge" id="office-timer">⏱️ Sisa Waktu: 05:00</div>
                <div class="doc-tabs" style="display: flex; gap: 0.5rem; margin-bottom: 1rem;">
                    <div class="btn btn-secondary active" id="doc-tab-1" onclick="switchWordPage(1)" style="padding: 0.5rem 1rem; font-size: 0.85rem;">Halaman 1 (Surat)</div>
                    <div class="btn btn-secondary" id="doc-tab-2" onclick="switchWordPage(2)" style="padding: 0.5rem 1rem; font-size: 0.85rem;">Halaman 2 (Lampiran)</div>
                </div>
                <div id="word-page-1" class="doc-container">
                    <div style="text-align:center; font-weight:bold; font-family:'Plus Jakarta Sans'; margin-bottom: 2rem;">
                        PEMERINTAH KABUPATEN BANTUL<br>KALURAHAN BANGUNHARJO<br><hr style="margin: 1rem 0; border-top: 2px solid #000;">
                    </div>
                    <p><b>SURAT UNDANGAN</b><br>Nomor: 002/23/X/2026</p>
                    <p>Yth. Bapak/Ibu Ketua RT 01-04<br>Di Tempat</p>
                    <p>Dengan hormat,<br>Sehubungan dengan akan dilaksanakannya Musyawarah Padukuhan terkait pembangunan lapangan olahraga dan penanganan sampah liar, kami mengharap kehadiran Bapak/Ibu pada:</p>
                    <p style="margin-left: 2rem; background: #f8fafc; padding: 1rem; border-left: 4px solid var(--primary);">
                        Hari/Tanggal: Senin, 1 September 2026<br>
                        Waktu: 08.00 WIB - Selesai<br>
                        Tempat: Pendopo Kalurahan Bangunharjo<br>
                        Acara: Musyawarah Padukuhan
                    </p>
                    <p>Mengingat pentingnya acara tersebut, kami mohon Bapak/Ibu dapat hadir tepat waktu. Demikian undangan ini kami sampaikan, atas perhatian dan kerja samanya kami ucapkan terima kasih.</p>
                    <textarea id="office-input-1" class="typing-area" placeholder="Ketik ulang teks di atas pada kolom ini..."></textarea>
                </div>
                <div id="word-page-2" class="doc-container hidden">
                    <div style="text-align:center; font-weight:bold; font-family:'Plus Jakarta Sans'; margin-bottom: 2rem;">LAMPIRAN SURAT<br>Nomor: 002/23/X/2026</div>
                    <p style="font-weight:600; margin-top:1rem;">Rincian Agenda Rapat:</p>
                    <ol style="font-family:'Lora'; font-size:1.1rem; line-height:1.8; margin-left: 1.5rem;">
                        <li>Pembukaan dan Sambutan Kepala Dukuh.</li>
                        <li>Pemaparan Rencana Anggaran Biaya Pembangunan Lapangan.</li>
                        <li>Diskusi dan Penyerapan Aspirasi Warga (Sesi Tanya Jawab).</li>
                        <li>Penetapan Kesepakatan dan Penandatanganan Berita Acara.</li>
                        <li>Doa dan Penutup.</li>
                    </ol>
                    <textarea id="office-input-2" class="typing-area" placeholder="Ketik ulang teks di atas pada kolom ini..."></textarea>
                </div>
                <button class="btn btn-success btn-block" style="padding: 1rem; font-size: 1.1rem;" onclick="finishTypingTest()">Selesai & Simpan Skor Word</button>
            </div>
        </div>
        <div id="tab-excel" class="hidden">
            <div id="excel-intro" class="text-center" style="padding: 3rem 0;">
                <h3 style="margin-bottom: 1rem; font-size: 1.5rem;">Simulasi Pengolahan Data</h3>
                <p style="color: var(--text-muted); margin-bottom: 2rem;">Lengkapi perhitungan total pada Sheet Anggaran dan Data Warga. (Waktu: 3 Menit)</p>
                <button class="btn" style="padding: 1rem 3rem; font-size: 1.1rem;" onclick="startExcelTest()">Mulai Simulasi Excel</button>
            </div>
            <div id="excel-test" class="hidden">
                <div class="timer-badge" id="excel-timer">⏱️ Sisa Waktu: 03:00</div>
                <div class="excel-container">
                    <div class="excel-tabs">
                        <div class="excel-tab active" id="excel-tab-1" onclick="switchExcelTab(1)">Sheet1: Anggaran</div>
                        <div class="excel-tab" id="excel-tab-2" onclick="switchExcelTab(2)">Sheet2: Data Warga</div>
                    </div>
                    <table class="excel" id="excel-sheet-1">
                        <tr><th>No</th><th>Uraian Kegiatan</th><th>Anggaran (Rp)</th></tr>
                        <tr><td>1</td><td>Konsumsi Rapat</td><td>1.500.000</td></tr>
                        <tr><td>2</td><td>Pengadaan Bak Sampah</td><td>2.000.000</td></tr>
                        <tr><td>3</td><td>Pembangunan Lapangan Voli</td><td>5.000.000</td></tr>
                        <tr><td>4</td><td>Honor Narasumber</td><td>1.000.000</td></tr>
                        <tr><td>5</td><td>Sewa Tenda & Kursi</td><td>1.500.000</td></tr>
                        <tr style="background:var(--primary-light); font-weight:bold;">
                            <td colspan="2" style="text-align:right; color: var(--primary);">TOTAL ANGGARAN</td>
                            <td><input type="text" id="input-excel-1" placeholder="Isi Total..." style="color:var(--primary); font-size: 1.1rem;"></td>
                        </tr>
                    </table>
                    <table class="excel hidden" id="excel-sheet-2">
                        <tr><th>RT</th><th>Jumlah KK</th><th>Keterangan</th></tr>
                        <tr><td>RT 01</td><td>50</td><td>Warga Tetap</td></tr>
                        <tr><td>RT 02</td><td>60</td><td>Warga Tetap</td></tr>
                        <tr><td>RT 03</td><td>70</td><td>Warga Tetap</td></tr>
                        <tr style="background:var(--primary-light); font-weight:bold;">
                            <td style="text-align:right; color: var(--primary);">TOTAL KK</td>
                            <td><input type="text" id="input-excel-2" placeholder="Isi Total..." style="color:var(--primary); font-size: 1.1rem;"></td>
                            <td></td>
                        </tr>
                    </table>
                </div>
                <button class="btn btn-success btn-block" style="padding: 1rem; font-size: 1.1rem;" onclick="finishExcelTest()">Cek Jawaban Excel</button>
            </div>
        </div>
        <div id="tab-ppt" class="hidden">
            <div id="ppt-editor">
                <div class="text-center" style="margin-bottom: 1.5rem;">
                    <h3 style="font-size: 1.5rem; margin-bottom: 0.5rem;">Simulasi Presentasi</h3>
                    <p style="color: var(--text-muted);">Lengkapi teks untuk 4 slide rapat di bawah ini.</p>
                </div>
                <div style="background:var(--bg-card); padding:2rem; border-radius:var(--radius-lg); border: 2px solid var(--border); margin-bottom:1.5rem; max-height:400px; overflow-y:auto;">
                    <label style="font-weight:700; font-size:0.95rem; margin-bottom:0.5rem; display:block;">Slide 1 (Judul):</label>
                    <input type="text" id="ppt-s1-title" class="input-field" value="Rencana Pembangunan Padukuhan">
                    <label style="font-weight:700; font-size:0.95rem; margin-bottom:0.5rem; display:block; margin-top:1.5rem;">Slide 2 (Latar Belakang):</label>
                    <textarea id="ppt-s2-body" class="input-field" style="height:80px; font-family:inherit; resize:vertical;">- Kebutuhan fasilitas olahraga pemuda.
- Penanganan sampah liar yang mendesak.</textarea>
                    <label style="font-weight:700; font-size:0.95rem; margin-bottom:0.5rem; display:block; margin-top:1.5rem;">Slide 3 (Anggaran & Solusi):</label>
                    <textarea id="ppt-s3-body" class="input-field" style="height:80px; font-family:inherit; resize:vertical;">- Anggaran: Dana Stimulan Rp 11.000.000.
- Solusi: Pembagian porsi anggaran & Kerja Bakti Massal.</textarea>
                    <label style="font-weight:700; font-size:0.95rem; margin-bottom:0.5rem; display:block; margin-top:1.5rem;">Slide 4 (Jadwal Pelaksanaan):</label>
                    <textarea id="ppt-s4-body" class="input-field" style="height:80px; font-family:inherit; resize:vertical;">- Agustus: Sosialisasi & Persiapan
- September: Pelaksanaan Pembangunan
- Oktober: Evaluasi & Pelaporan</textarea>
                </div>
                <button class="btn btn-block" style="padding: 1rem; font-size: 1.1rem;" onclick="startPptPresentation()">Mulai Presentasi 4 Slide</button>
            </div>
            <div id="ppt-present" class="hidden">
                <div class="timer-badge" id="ppt-timer">⏱️ Sisa Waktu: 03:00</div>
                <div class="ppt-container">
                    <div class="slide" id="slide-display"></div>
                    <div class="slide-nav">
                        <button onclick="prevSlide()" id="btn-prev-slide">◀ Prev</button>
                        <span style="color:white; align-self:center; font-weight:700; font-size: 1.1rem; margin: 0 1rem;" id="slide-indicator">1 / 4</span>
                        <button onclick="nextSlide()" id="btn-next-slide">Next ▶</button>
                    </div>
                </div>
                <div class="recording-box" id="pres-rec"><div class="dot"></div> Mendengarkan suara Anda...</div>
                <button class="btn btn-warning btn-block" id="pres-btn" style="padding: 1rem; font-size: 1.1rem;" onclick="togglePres()">🎤 Mulai Bicara (Rekam Nilai)</button>
                <div style="background:var(--bg-card); padding:1.5rem; margin-top:1.5rem; border-radius:var(--radius-md); font-size:0.95rem; border: 2px solid var(--border);" id="pres-log">
                    <b>Instruksi:</b> Jelaskan isi slide. Sistem AI akan mendeteksi kata kunci:
                    <span style="color: var(--primary); font-weight: 700;">"Latar Belakang"</span>,
                    <span style="color: var(--primary); font-weight: 700;">"Anggaran"</span>,
                    <span style="color: var(--primary); font-weight: 700;">"Solusi"</span>, dan
                    <span style="color: var(--primary); font-weight: 700;">"Jadwal"</span>.
                </div>
            </div>
        </div>`;
}

function showKomputerTab(tabId) {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sub-tab').forEach(t => { if (t.getAttribute('onclick')?.includes(tabId)) t.classList.add('active'); });
    ['tab-office', 'tab-excel', 'tab-ppt'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
    document.getElementById(tabId)?.classList.remove('hidden');
}
function initKomputerMenu() { showKomputerTab('tab-office'); }

function startTypingTest() {
    State.office.typingActive = true;
    State.office.typingEndTime = Date.now() + 300 * 1000;
    document.getElementById('office-intro')?.classList.add('hidden');
    document.getElementById('office-typing')?.classList.remove('hidden');
    switchWordPage(1);
    if (State.office.wordTimer) clearInterval(State.office.wordTimer);
    State.office.wordTimer = runTimer('office-timer', State.office.typingEndTime, () => finishTypingTest());
}

function switchWordPage(page) {
    State.office.wordPage = page;
    document.getElementById('word-page-1')?.classList.add('hidden');
    document.getElementById('word-page-2')?.classList.add('hidden');
    document.getElementById('doc-tab-1')?.classList.remove('active');
    document.getElementById('doc-tab-2')?.classList.remove('active');
    document.getElementById('word-page-' + page)?.classList.remove('hidden');
    document.getElementById('doc-tab-' + page)?.classList.add('active');
}

function getWordReferenceText(pageNum) {
    const el = document.getElementById('word-page-' + pageNum);
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('textarea').forEach(t => t.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
}

function finishTypingTest() {
    if (State.office.wordTimer) { clearInterval(State.office.wordTimer); State.office.wordTimer = null; }
    State.office.typingActive = false;

    const user1 = (document.getElementById('office-input-1')?.value || '').trim();
    const user2 = (document.getElementById('office-input-2')?.value || '').trim();
    const ref1 = getWordReferenceText(1);
    const ref2 = getWordReferenceText(2);

    const match1 = textMatchPercent(user1, ref1);
    const match2 = textMatchPercent(user2, ref2);
    const score = Math.round((match1 + match2) / 2);

    State.scores.word = score;
    saveScores();

    const el = document.getElementById('office-typing');
    if (el) el.innerHTML = `
        <div class="text-center" style="padding: 3rem 0;">
            <h3 style="color: var(--success); font-size: 2rem; margin-bottom: 1rem;">Skor Ketik Word: ${score}</h3>
            <p style="color: var(--text-muted); margin-bottom: 0.5rem;">Akurasi Halaman 1: ${match1}% | Halaman 2: ${match2}%</p>
            <button class="btn btn-block" onclick="showKomputerTab('tab-excel')">Lanjut ke Excel</button>
        </div>`;
}

function startExcelTest() {
    State.office.excelActive = true;
    State.office.excelEndTime = Date.now() + 180 * 1000;
    document.getElementById('excel-intro')?.classList.add('hidden');
    document.getElementById('excel-test')?.classList.remove('hidden');
    switchExcelTab(1);
    if (State.office.excelTimer) clearInterval(State.office.excelTimer);
    State.office.excelTimer = runTimer('excel-timer', State.office.excelEndTime, () => finishExcelTest());
}

function switchExcelTab(tab) {
    State.office.excelTab = tab;
    document.getElementById('excel-sheet-1')?.classList.add('hidden');
    document.getElementById('excel-sheet-2')?.classList.add('hidden');
    document.getElementById('excel-tab-1')?.classList.remove('active');
    document.getElementById('excel-tab-2')?.classList.remove('active');
    document.getElementById('excel-sheet-' + tab)?.classList.remove('hidden');
    document.getElementById('excel-tab-' + tab)?.classList.add('active');
}

function finishExcelTest() {
    if (State.office.excelTimer) { clearInterval(State.office.excelTimer); State.office.excelTimer = null; }
    State.office.excelActive = false;
    const in1 = document.getElementById('input-excel-1');
    const in2 = document.getElementById('input-excel-2');
    if (!in1 || !in2) return;
    const a1 = in1.value.replace(/[.,\s]/g, '');
    const a2 = in2.value.replace(/[.,\s]/g, '');
    let score = 0;
    if (a1 === '11000000') score += 50;
    if (a2 === '180') score += 50;
    State.scores.excel = score;
    saveScores();
    const el = document.getElementById('excel-test');
    if (el) el.innerHTML = `
        <div class="text-center" style="padding: 3rem 0;">
            <h3 style="color: var(--success); font-size: 2rem; margin-bottom: 1rem;">Skor Excel: ${score} / 100</h3>
            <p style="color: var(--text-muted); margin-bottom: 0.5rem;">Anggaran: ${a1 === '11000000' ? '✔️ Benar' : '✖️ Salah'} | Data Warga: ${a2 === '180' ? '✔️ Benar' : '✖️ Salah'}</p>
            <button class="btn btn-block" onclick="showKomputerTab('tab-ppt')">Lanjut ke PPT</button>
        </div>`;
}

function startPptPresentation() {
    const t1 = document.getElementById('ppt-s1-title').value;
    const b2 = document.getElementById('ppt-s2-body').value.replace(/\n/g, '<br>');
    const b3 = document.getElementById('ppt-s3-body').value.replace(/\n/g, '<br>');
    const b4 = document.getElementById('ppt-s4-body').value.replace(/\n/g, '<br>');
    State.ppt.data = [
        { title: t1, content: `<p style="text-align:center; font-size:1.5rem; margin-top: 2rem;">Musyawarah Padukuhan Bangunharjo</p>` },
        { title: "Latar Belakang", content: `<ul><li>${b2.replace(/- /g, '')}</li></ul>` },
        { title: "Anggaran & Solusi", content: `<ul><li>${b3.replace(/- /g, '')}</li></ul>` },
        { title: "Jadwal Pelaksanaan", content: `<ul><li>${b4.replace(/- /g, '')}</li></ul>` }
    ];
    State.ppt.currentSlide = 0;
    State.ppt.active = true;
    document.getElementById('ppt-editor')?.classList.add('hidden');
    document.getElementById('ppt-present')?.classList.remove('hidden');
    renderSlide();
}

function renderSlide() {
    const slide = State.ppt.data[State.ppt.currentSlide];
    const container = document.getElementById('slide-display');
    if (!container) return;
    container.innerHTML = `<h1>${slide.title}</h1><div>${slide.content}</div>`;
    const ind = document.getElementById('slide-indicator');
    if (ind) ind.innerText = `${State.ppt.currentSlide + 1} / ${State.ppt.data.length}`;
    const prev = document.getElementById('btn-prev-slide');
    const next = document.getElementById('btn-next-slide');
    if (prev) { prev.style.opacity = State.ppt.currentSlide === 0 ? "0.3" : "1"; prev.style.pointerEvents = State.ppt.currentSlide === 0 ? "none" : "auto"; }
    if (next) { next.style.opacity = State.ppt.currentSlide === State.ppt.data.length - 1 ? "0.3" : "1"; next.style.pointerEvents = State.ppt.currentSlide === State.ppt.data.length - 1 ? "none" : "auto"; }
}
function prevSlide() { if (State.ppt.currentSlide > 0) { State.ppt.currentSlide--; renderSlide(); } }
function nextSlide() { if (State.ppt.currentSlide < State.ppt.data.length - 1) { State.ppt.currentSlide++; renderSlide(); } }

if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    presRecog = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    presRecog.lang = 'id-ID'; presRecog.continuous = true;
    presRecog.onresult = (e) => {
        const text = e.results[e.results.length - 1][0].transcript.toLowerCase();
        const logEl = document.getElementById('pres-log');
        if (logEl) logEl.innerHTML = `<b>🎤 Anda:</b> "${text}"`;
        if (text.includes('latar belakang')) State.media.keywords['latar belakang'] = true;
        if (text.includes('anggaran') || text.includes('dana')) State.media.keywords['anggaran'] = true;
        if (text.includes('solusi') || text.includes('kerja bakti')) State.media.keywords['solusi'] = true;
        if (text.includes('jadwal') || text.includes('pelaksanaan')) State.media.keywords['jadwal'] = true;
    };
    presRecog.onerror = (event) => {
        if (event.error === 'not-allowed') {
            toast("Akses mikrofon ditolak.", "error");
            if (State.media.isRecording) togglePres();
        }
    };
}

function togglePres() {
    if (!presRecog) return toast("Browser tidak mendukung mikrofon.", "error");
    const btn = document.getElementById('pres-btn');
    if (State.media.isRecording) {
        presRecog.stop();
        State.media.isRecording = false;
        if (State.ppt.timer) { clearInterval(State.ppt.timer); State.ppt.timer = null; }
        if (btn) { btn.innerText = "🎤 Mulai Bicara (Rekam Nilai)"; btn.classList.replace('btn-danger', 'btn-warning'); }
        document.getElementById('pres-rec')?.classList.remove('active');
        const count = Object.values(State.media.keywords).filter(v => v).length;
        State.scores.presentasi = Math.round((count / 4) * 100);
        State.ppt.active = false;
        saveScores();
        toast(`Presentasi Selesai! Kata kunci: ${count}/4. Skor: ${State.scores.presentasi}`, "success");
        window.location.hash = '#/dashboard';
    } else {
        State.media.keywords = {};
        State.media.isRecording = true;
        if (btn) { btn.innerText = "⏹️ Hentikan Presentasi"; btn.classList.replace('btn-warning', 'btn-danger'); }
        document.getElementById('pres-rec')?.classList.add('active');
        presRecog.start();
        let time = 180;
        const timerEl = document.getElementById('ppt-timer');
        if (State.ppt.timer) clearInterval(State.ppt.timer);
        State.ppt.timer = setInterval(() => {
            time--;
            const m = Math.floor(time / 60);
            const s = time % 60;
            if (timerEl) timerEl.innerText = `⏱️ Sisa Waktu: ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (time <= 0 || !State.media.isRecording) {
                clearInterval(State.ppt.timer);
                State.ppt.timer = null;
                if (State.media.isRecording) togglePres();
            }
        }, 1000);
    }
}

// ==========================================
// 11. PIDATO
// ==========================================
function renderPidato() {
    if (!State.pidatoList || State.pidatoList.length === 0) {
        return `
            <div class="text-center" style="padding: 3rem 0;">
                <div style="font-size: 4rem; margin-bottom: 1rem;">🎤</div>
                <h2 style="font-size: 1.5rem; font-weight: 800; margin-bottom: 1rem; color: var(--warning);">Belum Ada Teks Pidato</h2>
                <p style="color: var(--text-muted);">Sheet <code>TeksPidato</code> di Spreadsheet masih kosong. Hubungi admin.</p>
            </div>`;
    }
    const optionsHtml = State.pidatoList.map(p => `<option value="${p.id}">${p.judul}</option>`).join('');
    return `
        <div class="text-center" style="margin-bottom: 2rem;">
            <h2 style="font-weight: 800; font-size: 2rem; margin-bottom: 0.5rem;">Praktik Pidato Bahasa Jawa</h2>
            <p style="color: var(--text-muted);">Uji kemampuan public speaking Anda menggunakan Bahasa Jawa yang baik dan benar.</p>
        </div>
        <div style="display: grid; grid-template-columns: 1fr; gap: 1rem; margin-bottom: 1.5rem;">
            <div>
                <label style="font-weight:700; font-size:0.9rem; margin-bottom:0.5rem; display:block;">Pilih Teks Pidato:</label>
                <select id="p-select" class="input-field" onchange="loadPidatoText()" style="margin-bottom:0;">${optionsHtml}</select>
            </div>
            <div>
                <label style="font-weight:700; font-size:0.9rem; margin-bottom:0.5rem; display:block;">Pilih Suara TTS:</label>
                <select id="tts-voice-select" class="input-field" style="margin-bottom:0;">
                    <option value="default">Default (Sistem)</option>
                    <option value="female">Perempuan (Female)</option>
                    <option value="male">Laki-laki (Male)</option>
                </select>
            </div>
        </div>
        <div style="display:flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
            <button class="btn btn-success" style="flex:1; padding: 1rem; min-width: 150px;" id="pid-tts-btn" onclick="playPidatoTTS()">🔊 Dengarkan Teks</button>
            <button class="btn btn-danger hidden" style="flex:1; padding: 1rem; min-width: 100px;" id="pid-stop-btn" onclick="stopPidatoTTS()">⏹️ Stop TTS</button>
            <button class="btn" style="flex:1; padding: 1rem; min-width: 150px;" id="pid-btn" onclick="togglePidato()">🎤 Mulai Baca</button>
        </div>
        <div class="recording-box" id="pid-rec"><div class="dot"></div> Mendengarkan suara Anda...</div>
        <div id="p-text" class="pidato-box"></div>
        <div id="p-score" class="text-center" style="font-weight:800; font-size:1.5rem; margin-top:1.5rem; color:var(--primary);"></div>`;
}

function populateVoices() {
    if (!('speechSynthesis' in window)) return;
    const load = () => { State.media.ttsVoices = window.speechSynthesis.getVoices().filter(v => v.lang.toLowerCase().includes('id')); };
    load();
    window.speechSynthesis.onvoiceschanged = load;
}

function getPhonetic(word) {
    const cleanWord = word.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()'’]/g, "");
    const dict = { "inna": "inna", "rojiun": "rojingun", "rajiun": "rojingun", "sambekala": "sambekolo", "kawasa": "kuwoso", "sedaya": "sedoyo", "berkah": "berkah", "menika": "meniko", "jenazah": "jenazah", "wa": "wa", "allah": "alloh", "warrahmatullah": "warrahmatulloh", "takziyah": "takziyah", "tanaga": "tenogo", "mbok": "bok", "wabarakatuh": "wabarokatuh" };
    if (dict[cleanWord]) {
        let result = dict[cleanWord];
        if (word[0] === word[0].toUpperCase()) result = result.charAt(0).toUpperCase() + result.slice(1);
        const p = word.match(/[.,\/#!$%\^&\*;:{}=\-_`~()'’]$/);
        return result + (p ? p[0] : "");
    }
    let w = cleanWord;
    w = w.replace(/dh/g, 'd').replace(/th/g, 't');
    if (w.endsWith('ah')) w = w.slice(0, -2) + 'oh';
    else if (w.endsWith('a')) w = w.slice(0, -1) + 'o';
    if (word[0] === word[0].toUpperCase()) w = w.charAt(0).toUpperCase() + w.slice(1);
    const p = word.match(/[.,\/#!$%\^&\*;:{}=\-_`~()'’]$/);
    return w + (p ? p[0] : "");
}

function loadPidatoText() {
    const selectEl = document.getElementById('p-select');
    if (!selectEl) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const val = selectEl.value;
    const selected = State.pidatoList.find(p => String(p.id) === String(val));
    if (!selected) return;

    const rawTxt = String(selected.teks || '');
    const paragraphs = rawTxt.split('\n');
    let html = '';
    pidatoWords = [];
    let idx = 0;
    paragraphs.forEach(p => {
        if (!p.trim()) return;
        html += "<p>";
        const words = p.split(/(\s+)/);
        words.forEach(w => {
            if (w.trim() === '') html += w;
            else { html += `<span class="word" id="pw-${idx}">${w}</span>`; pidatoWords.push(w); idx++; }
        });
        html += "</p>";
    });
    const pTextEl = document.getElementById('p-text');
    if (pTextEl) pTextEl.innerHTML = html;
    pidatoMatchCount = 0;
    const scoreEl = document.getElementById('p-score');
    if (scoreEl) scoreEl.innerText = '';
    const ttsBtn = document.getElementById('pid-tts-btn');
    if (ttsBtn) { ttsBtn.innerText = "🔊 Dengarkan Teks"; ttsBtn.disabled = false; }
    document.getElementById('pid-stop-btn')?.classList.add('hidden');
}

function playPidatoTTS() {
    if (!('speechSynthesis' in window)) return toast("Browser tidak mendukung suara.", "error");
    const ttsBtn = document.getElementById('pid-tts-btn');
    const stopBtn = document.getElementById('pid-stop-btn');
    if (!ttsBtn || !stopBtn) return;

    if (State.media.ttsPaused) {
        window.speechSynthesis.resume();
        State.media.ttsPaused = false;
        ttsBtn.innerHTML = "⏸️ Jeda (Pause)";
        if (currentHighlightIndex !== -1 && wordTimings[currentHighlightIndex]) {
            speechStartTime = performance.now() - wordTimings[currentHighlightIndex].start;
        }
        syncInterval = requestAnimationFrame(syncHighlightLoop);
        return;
    }
    if (State.media.ttsPlaying && window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        State.media.ttsPaused = true;
        ttsBtn.innerHTML = "▶️ Lanjutkan (Resume)";
        if (syncInterval) { cancelAnimationFrame(syncInterval); syncInterval = null; }
        return;
    }

    const selectEl = document.getElementById('p-select');
    const val = selectEl?.value;
    const selected = State.pidatoList.find(p => String(p.id) === String(val));
    if (!selected) return toast("Pilih teks pidato terlebih dahulu.", "warning");

    window.speechSynthesis.cancel();
    if (State.media.isRecording) togglePidato();

    const rawTxt = String(selected.teks || '');
    let phoneticText = " ";
    const wordIndices = [];
    let globalIdx = 0;
    rawTxt.split('\n').forEach(p => {
        if (!p.trim()) { phoneticText += " \n "; return; }
        const words = p.split(/(\s+)/);
        words.forEach(w => {
            if (w.trim() === '') phoneticText += w;
            else {
                const phon = getPhonetic(w);
                const start = phoneticText.length;
                phoneticText += phon;
                wordIndices.push({ originalIndex: globalIdx, start, end: phoneticText.length });
                globalIdx++;
            }
        });
        phoneticText += " \n ";
    });

    const u = new SpeechSynthesisUtterance(phoneticText);
    const voiceMode = document.getElementById('tts-voice-select').value;
    if (State.media.ttsVoices.length > 0) {
        let v = null;
        if (voiceMode === 'male') {
            v = State.media.ttsVoices.find(x => { const n = x.name.toLowerCase(); return n.includes('male') || n.includes('pria') || n.includes('laki') || n.includes('andika') || n.includes('ardi'); });
            u.pitch = v ? 0.9 : 0.5; u.rate = 0.9;
        } else if (voiceMode === 'female') {
            v = State.media.ttsVoices.find(x => { const n = x.name.toLowerCase(); return n.includes('female') || n.includes('wanita') || n.includes('gadis') || n.includes('damayanti'); });
            u.pitch = 1.2;
        }
        if (v) u.voice = v;
    } else {
        if (voiceMode === 'male') u.pitch = 0.5;
        if (voiceMode === 'female') u.pitch = 1.2;
    }
    u.lang = 'id-ID'; u.rate = 0.85;

    ttsBtn.innerHTML = "⏸️ Jeda (Pause)";
    stopBtn.classList.remove('hidden');
    State.media.ttsPlaying = true;
    State.media.ttsPaused = false;
    document.querySelectorAll('#p-text .word').forEach(el => el.classList.remove('tts-active'));

    wordTimings = [];
    let cumulative = 0;
    const rateFactor = 1 / (u.rate || 0.85);
    pidatoWords.forEach(word => {
        let duration = (250 + (word.length * 60)) * rateFactor;
        if (word.match(/[.,;:]/)) duration += (300 * rateFactor);
        if (word.match(/[.!?]/)) duration += (600 * rateFactor);
        wordTimings.push({ start: cumulative, end: cumulative + duration });
        cumulative += duration;
    });
    currentHighlightIndex = -1;

    function syncHighlightLoop() {
        if (!State.media.ttsPlaying || State.media.ttsPaused) return;
        const elapsed = performance.now() - speechStartTime;
        let newIdx = -1;
        for (let i = 0; i < wordTimings.length; i++) {
            if (elapsed >= wordTimings[i].start) newIdx = i; else break;
        }
        if (newIdx !== -1 && newIdx !== currentHighlightIndex) {
            document.querySelectorAll('#p-text .word').forEach(el => el.classList.remove('tts-active'));
            const span = document.getElementById(`pw-${newIdx}`);
            if (span) {
                span.classList.add('tts-active');
                const container = document.getElementById('p-text');
                if (container) container.scrollTo({ top: span.offsetTop - container.offsetTop - 50, behavior: 'smooth' });
            }
            currentHighlightIndex = newIdx;
        }
        syncInterval = requestAnimationFrame(syncHighlightLoop);
    }

    u.onstart = () => {
        setTimeout(() => {
            speechStartTime = performance.now();
            syncInterval = requestAnimationFrame(syncHighlightLoop);
        }, 300);
    };

    u.onboundary = (event) => {
        if (event.name === 'word') {
            const charIdx = event.charIndex;
            const found = wordIndices.find(w => charIdx >= w.start && charIdx < w.end);
            if (found) {
                speechStartTime = performance.now() - wordTimings[found.originalIndex].start;
                currentHighlightIndex = found.originalIndex;
                document.querySelectorAll('#p-text .word').forEach(el => el.classList.remove('tts-active'));
                const span = document.getElementById(`pw-${found.originalIndex}`);
                if (span) {
                    span.classList.add('tts-active');
                    const container = document.getElementById('p-text');
                    if (container) container.scrollTo({ top: span.offsetTop - container.offsetTop - 50, behavior: 'smooth' });
                }
            }
        }
    };

    u.onend = () => {
        ttsBtn.innerHTML = "🔊 Dengarkan Teks";
        ttsBtn.disabled = false;
        stopBtn.classList.add('hidden');
        State.media.ttsPlaying = false;
        State.media.ttsPaused = false;
        if (syncInterval) { cancelAnimationFrame(syncInterval); syncInterval = null; }
        document.querySelectorAll('#p-text .word').forEach(el => el.classList.remove('tts-active'));
    };

    setTimeout(() => window.speechSynthesis.speak(u), 150);
}

function stopPidatoTTS() {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        State.media.ttsPlaying = false;
        State.media.ttsPaused = false;
        if (syncInterval) { cancelAnimationFrame(syncInterval); syncInterval = null; }
        const ttsBtn = document.getElementById('pid-tts-btn');
        const stopBtn = document.getElementById('pid-stop-btn');
        if (ttsBtn) ttsBtn.innerHTML = "🔊 Dengarkan Teks";
        if (stopBtn) stopBtn.classList.add('hidden');
        document.querySelectorAll('#p-text .word').forEach(el => el.classList.remove('tts-active'));
    }
}

function evaluatePidato(trans) {
    const spoken = trans.toLowerCase().replace(/[.,\/#!$%^&\*;:{}=\-_`~()]/g, "").split(/\s+/).filter(w => w.length > 0);
    pidatoWords.forEach((rw, i) => {
        const clean = rw.toLowerCase().replace(/[.,\/#!$%^&\*;:{}=\-_`~()]/g, "");
        if (clean.length < 3) return;
        const matched = spoken.some(sw => {
            if (sw.length < 3) return false;
            if (sw.includes(clean) || clean.includes(sw)) return true;
            return wordSimilarity(sw, clean) >= 0.6;
        });
        if (matched) {
            const el = document.getElementById(`pw-${i}`);
            if (el && !el.classList.contains('correct')) {
                el.classList.add('correct');
                pidatoMatchCount++;
            }
        }
    });
}

if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    pidatoRecog = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    pidatoRecog.lang = 'id-ID'; pidatoRecog.continuous = true;
    pidatoRecog.onresult = (e) => {
        let finalTrans = '';
        for (let i = e.resultIndex; i < e.results.length; ++i) {
            if (e.results[i].isFinal) finalTrans += e.results[i][0].transcript + ' ';
        }
        if (finalTrans) evaluatePidato(finalTrans);
    };
    pidatoRecog.onerror = (event) => {
        if (event.error === 'not-allowed') {
            toast("Akses mikrofon ditolak.", "error");
            if (State.media.isRecording) togglePidato();
        }
    };
}

function togglePidato() {
    if (!pidatoRecog) return toast("Browser tidak mendukung mikrofon.", "error");
    const btn = document.getElementById('pid-btn');
    if (State.media.isRecording) {
        pidatoRecog.stop();
        State.media.isRecording = false;
        if (btn) { btn.innerText = "🎤 Mulai Baca"; btn.classList.replace('btn-danger', 'btn-primary'); }
        document.getElementById('pid-rec')?.classList.remove('active');
        const total = pidatoWords.length;
        const acc = total > 0 ? Math.round((pidatoMatchCount / total) * 100) : 0;
        State.scores.pidato = Math.min(100, acc);
        saveScores();
        const scoreEl = document.getElementById('p-score');
        if (scoreEl) scoreEl.innerText = `Akurasi Pengucapan: ${State.scores.pidato}%`;
    } else {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        stopPidatoTTS();
        State.media.isRecording = true;
        if (btn) { btn.innerText = "⏹️ Hentikan"; btn.classList.replace('btn-primary', 'btn-danger'); }
        document.getElementById('pid-rec')?.classList.add('active');
        pidatoRecog.start();
    }
}

// ==========================================
// 12. RAPAT (DRAMA)
// ==========================================
const AllDramaScripts = [
    [
        { speaker: "Sistem", text: "Warga sudah berkumpul. Suasana gaduh karena saling berdebat.", choices: [{ text: "Membentak warga.", effect: -30, feedback: "Warga tersinggung." }, { text: "Mengucap salam dan meminta perhatian dengan tenang.", effect: 10, feedback: "Warga menghargai sikap Anda." }] },
        { speaker: "Pak RT 01", text: "Pak Dukuh, pemuda kami butuh lapangan voli!", choices: [{ text: "Memihak RT 01.", effect: -20, feedback: "RT 02 protes." }, { text: "Menenangkan: 'Kita tampung semua usulan.'", effect: 15, feedback: "Kedua pihak mereda." }] },
        { speaker: "Pak RT 02", text: "Tapi lokasi lapangan dekat rumah lansia! Sampah lebih darurat!", choices: [{ text: "Mengabaikan lansia.", effect: -30, feedback: "Warga lansia marah." }, { text: "Berjanji buat aturan jam malam.", effect: 20, feedback: "RT 02 bisa menerima." }] },
        { speaker: "Warga Vokal", text: "Pokoknya RT kami tidak boleh dianaktirikan!", choices: [{ text: "Ikut emosi: 'Keluar kalau tidak puas!'", effect: -40, feedback: "Keributan besar." }, { text: "Tenang: 'Saya jamin adil, mari cari solusi.'", effect: 25, feedback: "Warga vokal terdiam." }] },
        { speaker: "Sistem", text: "Waktunya mengambil keputusan akhir.", choices: [{ text: "Menunda rapat.", effect: -10, feedback: "Warga kecewa." }, { text: "Win-Win: 70% voli, 30% sampah, sisanya kerja bakti.", effect: 30, feedback: "Semua setuju!" }] }
    ],
    [
        { speaker: "Sistem", text: "Rapat penyaluran Bansos. Warga sudah memegang data masing-masing.", choices: [{ text: "Menunda rapat karena data belum siap.", effect: -20, feedback: "Warga marah karena sudah jauh-jauh datang." }, { text: "Membuka rapat dengan menjelaskan sumber dana dan kuota.", effect: 10, feedback: "Warga mulai memahami kondisi." }] },
        { speaker: "Warga Mampu", text: "Pak Dukuh, saya juga butuh Bansos. Masa saya tidak dapat?", choices: [{ text: "Memberikan jatah agar tidak ribut.", effect: -30, feedback: "Warga miskin yang berhak jadi marah." }, { text: "Menolak halus dengan menunjukkan data TKSK.", effect: 20, feedback: "Warga mampu akhirnya mengerti." }] },
        { speaker: "Warga Miskin", text: "Pak, tetangga saya dapat, tapi saya yang lebih susah malah tidak masuk data!", choices: [{ text: "Menyalahkan pendataan RT.", effect: -20, feedback: "Ketua RT tersinggung dan membela diri." }, { text: "Mencatat dan berjanji akan mengusulkan di tahap 2.", effect: 25, feedback: "Warga miskin legowo dan berterima kasih." }] },
        { speaker: "Sistem", text: "Anda harus menutup rapat dengan kesimpulan yang transparan.", choices: [{ text: "Menutup rapat secara tertutup.", effect: -10, feedback: "Warga curiga ada permainan." }, { text: "Membacakan daftar penerima secara terbuka dan membuka sesi sanggahan.", effect: 30, feedback: "Warga puas dengan transparansi." }] }
    ],
    [
        { speaker: "Sistem", text: "Rapat Siskamling. Iuran keamanan naik, beberapa warga baru menolak.", choices: [{ text: "Memaksa semua warga membayar.", effect: -30, feedback: "Warga baru ngotot tidak mau bayar." }, { text: "Menjelaskan pentingnya ronda untuk keamanan bersama.", effect: 15, feedback: "Warga mulai mempertimbangkan." }] },
        { speaker: "Warga Baru", text: "Saya bayar keamanan perumahan saya sendiri, kenapa harus iuran lagi di sini?", choices: [{ text: "Bilang: 'Kalau tidak bayar, jangan minta bantuan RT!'", effect: -40, feedback: "Warga baru marah besar." }, { text: "Bernegosiasi: 'Bagaimana jika iuran diringankan, tapi tetap ikut ronda sebulan sekali?'", effect: 25, feedback: "Warga baru setuju dengan kompromi ini." }] },
        { speaker: "Warga Lama", text: "Kok warga baru diringankan? Kami dari dulu bayar penuh!", choices: [{ text: "Membiarkan saja (diam).", effect: -20, feedback: "Warga lama merasa dianaktirikan." }, { text: "Menjelaskan bahwa ini masa adaptasi warga baru.", effect: 15, feedback: "Warga lama bisa menerima alasan." }] },
        { speaker: "Sistem", text: "Ambil keputusan akhir terkait iuran dan ronda.", choices: [{ text: "Keputusan ditunda setahun.", effect: -10, feedback: "Poskamling terbengkalai." }, { text: "Iuran disesuaikan (berkeadilan), jadwal ronda digilir sistem, dibuat Perkal-nya.", effect: 30, feedback: "Semua warga sepakat dan siap menjalankan." }] }
    ],
    [
        { speaker: "Sistem", text: "Rapat Darurat Sengketa Tanah. Suasana sangat tegang.", choices: [{ text: "Membiarkan mereka berdebat dulu.", effect: -20, feedback: "Suasana memanas, hampir terjadi bentrok fisik." }, { text: "Membuka rapat dengan menegaskan bahwa ini forum musyawarah yang aman.", effect: 10, feedback: "Warga sedikit mereda dan duduk." }] },
        { speaker: "Warga A", text: "Pak Dukuh, ini tanah warisan saya dari kakek! Saya butuh uang, saya mau jual ke pengembang!", choices: [{ text: "Bilang: 'Silakan jual, itu hak Anda.'", effect: -30, feedback: "Warga lain histeris karena tanah Kasultanan akan hilang." }, { text: "Menjelaskan: 'Saya cek dulu status tanahnya, jika itu Duluwung, tidak bisa dijual sembarangan.'", effect: 20, feedback: "Warga A kaget tapi mulai tenang menunggu penjelasan." }] },
        { speaker: "Warga B", text: "Itu tanah Duluwung (Kasultanan)! Tidak boleh dijual! Jangan sampai diambil alih pengembang!", choices: [{ text: "Memihak Warga B dengan emosi.", effect: -10, feedback: "Warga A merasa diserang dan bersiap melawan." }, { text: "Menjadi penengah: 'Tenang, mari kita lihat bukti sertifikat atau letter C-nya dulu.'", effect: 25, feedback: "Kedua pihak setuju untuk menunjukkan bukti kepemilikan." }] },
        { speaker: "Sistem", text: "Anda menemukan bahwa tanah tersebut memang berstatus Tanah Kasultanan (Duluwung) yang tidak memiliki hak milik perorangan.", choices: [{ text: "Membiarkan warga menjualnya diam-diam.", effect: -50, feedback: "Anda melanggar hukum dan bisa dipidana. Rapat bubar." }, { text: "Mengedukasi warga tentang Hukum Pertanahan DIY dan melaporkannya ke Panewu.", effect: 30, feedback: "Warga A akhirnya mengerti dan membatalkan niatnya. Rapat kondusif." }] }
    ]
];

function renderRapat() {
    if (!State.rapatDrama.active) {
        return `
            <div class="text-center" style="margin-bottom: 2rem;">
                <h2 style="font-weight: 800; font-size: 2rem; margin-bottom: 0.5rem;">Simulasi Memimpin Rapat</h2>
                <p style="color: var(--text-muted);">Uji naluri kepemimpinan Anda dalam menyelesaikan konflik warga.</p>
            </div>
            <div style="display: grid; gap: 1rem; max-width: 600px; margin: 0 auto;">
                <div class="card" style="text-align:left; cursor:pointer; padding: 1.5rem; border-left: 4px solid var(--primary);" onclick="startRapatDrama(0)">
                    <h3 style="color: var(--primary); margin-bottom: 0.5rem; font-size: 1.2rem;">1. Pembangunan vs Sampah</h3>
                    <p style="color: var(--text-muted); font-size: 0.95rem;">Warga RT 01 menuntut lapangan voli, RT 02 menuntut penanganan sampah. Dana terbatas.</p>
                </div>
                <div class="card" style="text-align:left; cursor:pointer; padding: 1.5rem; border-left: 4px solid var(--warning);" onclick="startRapatDrama(1)">
                    <h3 style="color: var(--warning); margin-bottom: 0.5rem; font-size: 1.2rem;">2. Musyawarah Bantuan Sosial</h3>
                    <p style="color: var(--text-muted); font-size: 0.95rem;">Data penerima Bansos menjadi sorotan. Warga mampu minta jatah, warga miskin belum terdata.</p>
                </div>
                <div class="card" style="text-align:left; cursor:pointer; padding: 1.5rem; border-left: 4px solid var(--success);" onclick="startRapatDrama(2)">
                    <h3 style="color: var(--success); margin-bottom: 0.5rem; font-size: 1.2rem;">3. Iuran Keamanan & Ronda</h3>
                    <p style="color: var(--text-muted); font-size: 0.95rem;">Warga baru menolak iuran karena merasa aman, warga lama protes karena merasa tidak adil.</p>
                </div>
                <div class="card" style="text-align:left; cursor:pointer; padding: 1.5rem; border-left: 4px solid var(--danger);" onclick="startRapatDrama(3)">
                    <h3 style="color: var(--danger); margin-bottom: 0.5rem; font-size: 1.2rem;">4. Sengketa Tanah Kasultanan</h3>
                    <p style="color: var(--text-muted); font-size: 0.95rem;">Warga mengklaim tanah miliknya dan ingin menjualnya, padahal status tanah adalah Kasultanan/Duluwung.</p>
                </div>
            </div>`;
    }
    return `
        <div class="peace-container">
            <div style="font-weight: 800; font-size: 1rem; color: var(--text-main); white-space: nowrap;">❤️ KETENANGAN: <span id="peace-val" style="color: var(--success); font-size: 1.2rem;">${State.rapatDrama.peace}</span>%</div>
            <div class="peace-bar-bg"><div class="peace-bar-fill" id="peace-bar" style="width:${State.rapatDrama.peace}%; background:${State.rapatDrama.peace > 50 ? 'var(--success)' : 'var(--danger)'};"></div></div>
            <div class="peace-timer">⏱️ <span id="drama-timer">45</span>s</div>
        </div>
        <div class="drama-layout">
            <div id="drama-dialogue" class="dialogue-text"></div>
            <div id="drama-choices" style="margin-top: 2rem; display: flex; flex-direction: column; gap: 1rem;"></div>
        </div>`;
}

function startRapatDrama(i) {
    State.rapatDrama = { active: true, scenario: i, step: 0, peace: 100, timer: null, typeTimer: null, nextTimer: null, history: [] };
    router();
}

function getAvatar(speaker) {
    const a = { "Sistem": "🤖", "Pak RT 01": "👨‍💼", "Pak RT 02": "👨‍🌾", "Warga Vokal": "😡", "Warga Mampu": "🕴️", "Warga Miskin": "🧑‍🦱", "Warga Baru": "🧑‍💼", "Warga Lama": "👴", "Warga A": "👨‍🦳", "Warga B": "👵" };
    return a[speaker] || "👤";
}

function speakDramaLine(text, speaker) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    const voices = State.media.ttsVoices;
    let v = null;
    if (voices.length > 0) {
        if (speaker.includes("Warga") || speaker.includes("Ibu")) { v = voices.find(x => x.name.toLowerCase().includes('female') || x.name.toLowerCase().includes('gadis')); u.pitch = 1.2; u.rate = 1.1; }
        else if (speaker.includes("Pak RT") || speaker.includes("Lurah") || speaker.includes("Dukuh")) { v = voices.find(x => x.name.toLowerCase().includes('male') || x.name.toLowerCase().includes('ardi')); u.pitch = 0.8; u.rate = 0.95; }
        else { v = voices.find(x => x.name.toLowerCase().includes('female') || x.name.toLowerCase().includes('gadis')); u.pitch = 1.0; u.rate = 0.9; }
    }
    if (v) u.voice = v;
    u.text = `${speaker} berkata: ${text}`;
    setTimeout(() => window.speechSynthesis.speak(u), 250);
}

function renderDramaStep() {
    if (State.rapatDrama.timer) clearInterval(State.rapatDrama.timer);
    if (State.rapatDrama.typeTimer) clearTimeout(State.rapatDrama.typeTimer);
    if (State.rapatDrama.nextTimer) clearTimeout(State.rapatDrama.nextTimer);

    if (State.rapatDrama.peace <= 0) { endRapatDrama(false, "Bar Ketenangan habis (0%). Warga ricuh dan rapat dibubarkan paksa."); return; }
    const script = AllDramaScripts[State.rapatDrama.scenario];
    if (State.rapatDrama.step >= script.length) { endRapatDrama(true, "Rapat berjalan lancar. Anda berhasil memimpin dengan bijaksana!"); return; }

    const scene = script[State.rapatDrama.step];
    const dialogueEl = document.getElementById('drama-dialogue');
    const choicesEl = document.getElementById('drama-choices');
    if (!dialogueEl || !choicesEl) return;

    speakDramaLine(scene.text, scene.speaker);
    dialogueEl.innerHTML = `<div style="display: flex; gap: 20px; align-items: flex-start;">
        <div style="width: 70px; height: 70px; border-radius: 50%; background: #334155; display: flex; align-items: center; justify-content: center; font-size: 40px; flex-shrink: 0; border: 3px solid var(--primary); box-shadow: 0 4px 10px rgba(0,0,0,0.3);">${getAvatar(scene.speaker)}</div>
        <div style="flex: 1;"><span class="speaker-name">${scene.speaker}</span><span id="typing-text" style="line-height: 1.7; display: block; margin-top: 10px;"></span></div>
    </div>`;
    choicesEl.innerHTML = '';

    let i = 0;
    const textToType = `"${scene.text}"`;
    function typeWriter() {
        if (!State.rapatDrama.active) return;
        const el = document.getElementById('typing-text');
        if (!el) return;
        if (i < textToType.length) { el.innerHTML += textToType.charAt(i); i++; State.rapatDrama.typeTimer = setTimeout(typeWriter, 20); }
        else showDramaChoices(scene);
    }
    typeWriter();
}

function showDramaChoices(scene) {
    const container = document.getElementById('drama-choices');
    if (!container) return;
    container.innerHTML = scene.choices.map((c, i) =>
        `<button class="btn btn-block" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); text-align:left; justify-content:flex-start; padding:1.25rem; transition: var(--transition);" onmouseover="this.style.background='rgba(255,255,255,0.15)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'" onclick="makeChoice(${i})">
            <span style="color:var(--primary); font-weight:800; margin-right:15px;">PILIHAN ${i + 1}</span> ${c.text}
        </button>`).join('');
    let timeLeft = 45;
    const timerEl = document.getElementById('drama-timer');
    if (timerEl) timerEl.innerText = timeLeft;
    State.rapatDrama.timer = setInterval(() => {
        if (!State.rapatDrama.active) { clearInterval(State.rapatDrama.timer); return; }
        timeLeft--;
        if (timerEl) { timerEl.innerText = timeLeft; timerEl.style.color = timeLeft <= 10 ? 'var(--danger)' : 'white'; }
        if (timeLeft <= 0) { clearInterval(State.rapatDrama.timer); makeChoice(-1); }
    }, 1000);
}

function makeChoice(index) {
    if (!State.rapatDrama.active) return;
    if (State.rapatDrama.timer) clearInterval(State.rapatDrama.timer);
    if (State.rapatDrama.typeTimer) clearTimeout(State.rapatDrama.typeTimer);
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    const scene = AllDramaScripts[State.rapatDrama.scenario][State.rapatDrama.step];
    const container = document.getElementById('drama-choices');
    if (container) container.innerHTML = '';

    const choice = index === -1
        ? { text: "(Waktu habis. Anda terdiam.)", effect: -20, feedback: "Warga menganggap Anda tidak becus memimpin rapat." }
        : scene.choices[index];

    State.rapatDrama.peace = Math.min(100, State.rapatDrama.peace + choice.effect);
    const bar = document.getElementById('peace-bar');
    const val = document.getElementById('peace-val');
    if (val) val.innerText = State.rapatDrama.peace;
    if (bar) {
        bar.style.width = `${State.rapatDrama.peace}%`;
        bar.style.background = State.rapatDrama.peace > 50 ? 'var(--success)' : 'var(--danger)';
    }

    const dialogueEl = document.getElementById('drama-dialogue');
    if (dialogueEl) {
        const color = choice.effect > 0 ? 'var(--success)' : 'var(--danger)';
        dialogueEl.innerHTML += `<div style="display: flex; gap: 15px; align-items: flex-start; margin-top: 30px; animation: fadeIn 0.5s;">
            <div style="width: 50px; height: 50px; border-radius: 50%; background: #334155; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; border: 2px solid ${color}; box-shadow: 0 0 10px ${color};">📝</div>
            <div class="chat-bubble" style="border-left-color: ${color}; margin-top: 0; padding: 1.25rem;"><em style="font-size: 1.1rem;">${choice.feedback}</em></div>
        </div>`;
    }

    if (State.rapatDrama.peace <= 0) {
        State.rapatDrama.nextTimer = setTimeout(() => endRapatDrama(false, "Bar Ketenangan habis (0%). Warga ricuh dan rapat dibubarkan paksa."), 2500);
    } else {
        State.rapatDrama.nextTimer = setTimeout(() => { State.rapatDrama.step++; renderDramaStep(); }, 2500);
    }
}

function endRapatDrama(isWin, message) {
    State.rapatDrama.active = false;
    if (State.rapatDrama.timer) clearInterval(State.rapatDrama.timer);
    if (State.rapatDrama.typeTimer) clearTimeout(State.rapatDrama.typeTimer);
    if (State.rapatDrama.nextTimer) clearTimeout(State.rapatDrama.nextTimer);
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    State.scores.rapat = isWin ? Math.max(State.rapatDrama.peace, 70) : State.rapatDrama.peace;
    saveScores();

    const container = document.getElementById('view-container');
    if (!container) return;
    container.innerHTML = `
        <div class="text-center" style="padding: 4rem 0; animation: fadeIn 0.5s;">
            <h1 style="color: ${isWin ? 'var(--success)' : 'var(--danger)'}; font-size: 3rem; font-weight: 800; margin-bottom: 1rem;">${isWin ? 'RAPAT SUKSES!' : 'RAPAT GAGAL!'}</h1>
            <div style="font-size: 5rem; margin-bottom: 1.5rem;">${isWin ? '🏆' : '🔥'}</div>
            <h3 style="font-size: 1.25rem; font-weight: 500; color: var(--text-main); margin-bottom: 1rem;">${message}</h3>
            <h2 style="font-size: 2rem; font-weight: 700; color: var(--primary); margin-bottom: 2rem;">Skor Akhir Ketenangan: ${State.scores.rapat}%</h2>
            <div style="max-width: 400px; margin: 0 auto;">
                <button class="btn btn-block" onclick="window.location.hash='#/rapat'">Coba Skenario Lain</button>
                <button class="btn btn-block btn-warning" onclick="window.location.hash='#/dashboard'">Ke Dashboard</button>
            </div>
        </div>`;
}

// ==========================================
// 13. SYNC
// ==========================================
async function syncToServer(btn) {
    const nameEl = document.getElementById('p-name');
    if (!nameEl) return;
    const name = nameEl.value.trim();
    if (!name) return toast("Masukkan nama Anda terlebih dahulu.", "warning");

    const original = btn.innerText;
    btn.innerText = "⏳ Mengirim & Verifikasi..."; btn.disabled = true;

    const payload = {
        nama: name,
        kuis: State.scores.kuis || 0,
        word: State.scores.word || 0,
        excel: State.scores.excel || 0,
        presentasi: State.scores.presentasi || 0,
        pidato: State.scores.pidato || 0,
        rapat: State.scores.rapat || 0,
        wawancara: State.scores.wawancara || 0,
        psikologi: State.scores.psikologi || 0
    };

    try {
        await apiSubmitScores(payload);
        toast("Data berhasil dikirim dan terverifikasi di server!", "success");
    } catch (e) {
        toast(`Gagal: ${e.message}`, "error");
    } finally {
        btn.innerText = original;
        btn.disabled = false;
    }
}

window.onload = () => { initApp(); };