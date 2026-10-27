// ==========================================
// KONFIGURASI API GOOGLE APPS SCRIPT
// ==========================================
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyh0bYqvCdjKG_3kzKkLYTm4ggYb-DajSdK2UpiymPvYCCazljBOtghvDv1edYszK8w/exec'; // <-- GANTI DENGAN URL DEPLOYMENT ANDA

/**
 * Mengambil data soal kuis dari Google Sheets
 */
async function apiGetQuestions() {
    if (GAS_API_URL.includes("URL_WEB_APP_ANDA")) {
        throw new Error("URL API belum diatur di dalam file api.js.");
    }

    try {
        const response = await fetch(`${GAS_API_URL}?action=getQuestions`);
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);
        return data;
    } catch (error) {
        console.error("Gagal mengambil soal:", error);
        throw error;
    }
}

/**
 * Mengambil teks pidato dari Google Sheets (Fungsi Baru)
 */
async function apiGetPidato() {
    if (GAS_API_URL.includes("URL_WEB_APP_ANDA")) {
        throw new Error("URL API belum diatur di dalam file api.js.");
    }

    try {
        const response = await fetch(`${GAS_API_URL}?action=getPidato`);
        const data = await response.json();
        
        if (data.error) throw new Error(data.error);
        return data;
    } catch (error) {
        console.error("Gagal mengambil teks pidato:", error);
        throw error;
    }
}

/**
 * Mengirim data nilai peserta ke Google Sheets
 */
async function apiSubmitScores(payload) {
    if (GAS_API_URL.includes("URL_WEB_APP_ANDA")) {
        throw new Error("URL API belum diatur di dalam file api.js.");
    }

    try {
        await fetch(GAS_API_URL, {
            method: 'POST',
            mode: 'no-cors', // Wajib untuk Google Apps Script
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify(payload)
        });
        
        // Mode no-cors tidak mengembalikan response body, asumsikan sukses jika tidak error
        return true; 
    } catch (error) {
        console.error("Gagal mengirim nilai:", error);
        throw error;
    }
}