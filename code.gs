/**
 * ============================================================
 * BACKEND API - SISTEM SELEKSI CALON DUKUH
 * File: code.gs (Full Fix Final - Anti-Crash, Auto-Migrate, Sanitasi Kunci)
 * ============================================================
 */

// ============================================================
// 1. KONFIGURASI
// ============================================================
const SPREADSHEET_ID = '19o52STHuFNWE9M48Y1JdZOtVR2cYROEyYwfuC14iotQ'; // GANTI DENGAN ID SPREADSHEET ANDA
const SHEET_SOAL     = 'BankSoal';
const SHEET_HASIL    = 'HasilUjian';
const SHEET_PIDATO   = 'TeksPidato';

// Schema header resmi (untuk auto-migrasi jika kolom belum ada)
const HEADERS_SOAL   = ['No','Kategori','Pertanyaan','OpsiA','OpsiB','OpsiC','OpsiD','Kunci','Pembahasan','Tipe','Paket'];
const HEADERS_HASIL  = ['Timestamp','Nama Peserta','Kuis','Ketik Word','Tabel Excel','Presentasi PPT','Pidato Jawa','Simulasi Rapat','Wawancara','Psikologi','Paket'];
const HEADERS_PIDATO = ['ID','Judul','Teks_Lengkap'];

// ============================================================
// 2. FUNGSI BANTUAN (HELPERS)
// ============================================================
function getSpreadsheet() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'MASUKKAN_ID_SPREADSHEET_ANDA_DI_SINI') {
    throw new Error("ID_SPREADSHEET belum diisi di dalam code.gs!");
  }
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (e) {
    throw new Error("Gagal membuka Spreadsheet. Pastikan ID benar dan akun punya akses. Detail: " + e.message);
  }
}

function getOrCreateSheet(ss, sheetName, headers) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9d9d9");
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9d9d9");
  }
  return sheet;
}

/**
 * Pastikan sheet memiliki semua header yang diharapkan.
 * Tambah kolom baru tanpa hapus data lama (Auto-Migrasi).
 */
function ensureHeaders(sheet, expectedHeaders) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]).setFontWeight("bold").setBackground("#d9d9d9");
    return;
  }
  const currentHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  let nextCol = lastCol + 1;
  expectedHeaders.forEach(h => {
    if (currentHeaders.indexOf(h) === -1) {
      sheet.getRange(1, nextCol).setValue(h).setFontWeight("bold").setBackground("#d9d9d9");
      nextCol++;
    }
  });
}

// ============================================================
// 3. API ENDPOINTS (GET)
// ============================================================
function doGet(e) {
  if (!e || !e.parameter) {
    return ContentService.createTextOutput(JSON.stringify({ status: "API Aktif" })).setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const ss = getSpreadsheet();

    // --- ENDPOINT 1: AMBIL SOAL KUIS ---
    if (e.parameter.action === 'getQuestions') {
      const sheet = getOrCreateSheet(ss, SHEET_SOAL, HEADERS_SOAL);
      ensureHeaders(sheet, HEADERS_SOAL);

      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) throw new Error("Data soal di Spreadsheet masih kosong.");

      const headers = data[0].map(h => String(h).trim());
      const idxPaket      = headers.indexOf('Paket');
      const idxTipe       = headers.indexOf('Tipe');
      const idxKunci      = headers.indexOf('Kunci');
      const idxPembahasan = headers.indexOf('Pembahasan');

      const questions = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[0] === '' || row[2] === '') continue;

        const tipe = (idxTipe !== -1 ? row[idxTipe] : row[9] || 'pg').toString().trim().toLowerCase();
        const rawKey = String(idxKunci !== -1 ? row[idxKunci] : row[7] || '').trim();
        const options = [String(row[3] || ''), String(row[4] || ''), String(row[5] || ''), String(row[6] || '')];
        
        // ========================================================
        // SANITASI KUNCI JAWABAN SUPER CERDAS (ANTI-BUG SKOR 0)
        // ========================================================
        let finalAnswer = -1;
        if (tipe === 'pg') {
          const upperKey = rawKey.toUpperCase().trim();
          const firstChar = upperKey.charAt(0);
          
          // 1. Cek jika formatnya murni huruf A, B, C, D (contoh: "A", "B.", "C ")
          if (['A','B','C','D'].includes(firstChar) && upperKey.length <= 3) {
            finalAnswer = ['A','B','C','D'].indexOf(firstChar);
          } else {
            // 2. Cek jika formatnya teks panjang (contoh: "MPR", "Pasal 33 ayat 3")
            // Bersihkan teks dari tanda baca/spasi lalu cocokkan dengan opsi
            const cleanKey = upperKey.replace(/[^A-Z0-9]/g, '');
            
            let foundIdx = options.findIndex(opt => {
              const cleanOpt = opt.replace(/^[A-D]\.\s*/i, '').replace(/[^A-Z0-9]/g, '').toUpperCase();
              return cleanOpt === cleanKey;
            });

            // 3. Fallback: Cari teks yang mengandung kata kunci
            if (foundIdx === -1) {
              foundIdx = options.findIndex(opt => opt.trim().toUpperCase().includes(upperKey));
            }

            finalAnswer = foundIdx !== -1 ? foundIdx : 0; // Default A jika benar-benar tidak ketemu
          }
        } else {
          finalAnswer = rawKey; // Untuk soal uraian, kunci berupa teks bebas
        }

        questions.push({
          no: row[0],
          category: row[1] || 'Umum',
          question: row[2],
          options: options,
          answer: finalAnswer,
          explanation: idxPembahasan !== -1 ? (row[idxPembahasan] || '') : (row[8] || ''),
          tipe: tipe,
          paket: idxPaket !== -1 ? String(row[idxPaket] || '').trim() : ''
        });
      }

      return ContentService.createTextOutput(JSON.stringify(questions)).setMimeType(ContentService.MimeType.JSON);
    }

    // --- ENDPOINT 2: AMBIL TEKS PIDATO ---
    if (e.parameter.action === 'getPidato') {
      const sheet = getOrCreateSheet(ss, SHEET_PIDATO, HEADERS_PIDATO);
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) throw new Error("Data Teks Pidato di Spreadsheet masih kosong.");

      const pidatoList = [];
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[0] !== '' && row[2] !== '') {
          pidatoList.push({ id: row[0], judul: row[1], teks: row[2] });
        }
      }
      return ContentService.createTextOutput(JSON.stringify(pidatoList)).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ error: "Action tidak dikenali." })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ error: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// 4. API ENDPOINT (POST) — SIMPAN NILAI
// ============================================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("Tidak ada data yang diterima.");

    const data = JSON.parse(e.postData.contents);
    const ss = getSpreadsheet();
    const sheet = getOrCreateSheet(ss, SHEET_HASIL, HEADERS_HASIL);
    ensureHeaders(sheet, HEADERS_HASIL);

    // Simpan 11 kolom lengkap (Timestamp, Nama, 8 Nilai, Paket)
    sheet.appendRow([
      new Date(),                    
      data.nama || 'Anonim',         
      Number(data.kuis)        || 0, 
      Number(data.word)        || 0, 
      Number(data.excel)       || 0, 
      Number(data.presentasi)  || 0, 
      Number(data.pidato)      || 0, 
      Number(data.rapat)       || 0, 
      Number(data.wawancara)   || 0, 
      Number(data.psikologi)   || 0, 
      data.paket || ''               
    ]);

    return ContentService.createTextOutput(JSON.stringify({ result: 'success', message: 'Data berhasil disimpan' })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', error: error.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// 5. FUNGSI SETUP & INJEKSI DATA (JALANKAN MANUAL)
// ============================================================

/**
 * Bagi SEMUA soal ke 5 paket secara seimbang tanpa batas (Round-Robin per Kategori).
 */
function bagiSoalKe5Paket() {
  const JUMLAH_PAKET = 5;
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_SOAL);
  if (!sheet) return SpreadsheetApp.getUi().alert("Sheet BankSoal tidak ditemukan.");

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return SpreadsheetApp.getUi().alert("Bank soal kosong.");

  ensureHeaders(sheet, HEADERS_SOAL);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const idxPaket    = headers.indexOf('Paket');
  const idxTipe     = headers.indexOf('Tipe');
  const idxKategori = headers.indexOf('Kategori');

  if (idxPaket === -1 || idxTipe === -1) return SpreadsheetApp.getUi().alert("Header 'Tipe' atau 'Paket' tidak ditemukan.");

  const pgIdx = [], urIdx = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    const tipe = (data[i][idxTipe] || 'pg').toString().trim().toLowerCase();
    if (tipe === 'uraian') urIdx.push(i);
    else pgIdx.push(i);
  }

  function bagiPerKategori(indices) {
    const perCat = {};
    indices.forEach(i => {
      const cat = (data[i][idxKategori] || 'Umum').toString().trim();
      if (!perCat[cat]) perCat[cat] = [];
      perCat[cat].push(i);
    });
    const assign = {};
    Object.values(perCat).forEach(list => {
      list.forEach((rowIdx, j) => {
        assign[rowIdx] = (j % JUMLAH_PAKET) + 1;
      });
    });
    return assign;
  }

  const assignPG = bagiPerKategori(pgIdx);
  const assignUR = bagiPerKategori(urIdx);
  const paketCol = idxPaket + 1;

  for (let i = 1; i < data.length; i++) {
    let paket = '';
    if (assignPG[i] !== undefined) paket = assignPG[i];
    else if (assignUR[i] !== undefined) paket = assignUR[i];
    sheet.getRange(i + 1, paketCol).setValue(paket);
  }

  SpreadsheetApp.getUi().alert(`✅ Pembagian selesai. Semua soal telah dibagi ke 5 paket secara seimbang.`);
}

/**
 * Setup sheet TeksPidato dengan 5 teks pidato Bahasa Jawa.
 */
function setupTeksPidatoOtomatis() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_PIDATO);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(SHEET_PIDATO);
  sheet.getRange(1, 1, 1, 3).setValues([HEADERS_PIDATO]).setFontWeight("bold").setBackground("#d9d9d9");

  const dataPidato = [
    ["sambutan_rapat", "Pidato Sambutan Rapat Warga", `Assalamu'alaikum Warahmatullahi Wabarakatuh.\nAlhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal mursalin. Amma ba'du.\nDhumateng Bapak Lurah, para Pamong Kalurahan, Ketua RT/RW, lan sedoyo warga ingkang kinurmatan.\nSumangga kita sedaya tansah ngunjukaken raos puji syukur dhumateng Gusti Allah SWT, amargi ing dinten menika kita saged kempal wonten ing Musyawarah Padukuhan menika kanthi wilujeng.\nWosing gati rapat menika inggih menika mrembag babagan rencana pembangunan lingkungan lan penertiban keamanan warga. Kula minangka Dukuh ngaturaken agunging panuwun dhumateng panjenengan sedaya ingkang sampun kersa rawuh.\nMugi-mugi sedaya ingkang kita rembag ing dinten menika saged paring manfaat lan keberkahan dhumateng kita sedaya. Amin.\nWassalamu'alaikum Warahmatullahi Wabarakatuh.`],
    ["ahli_waris", "Atur Wakil Ahli Waris (Takziah)", `Assalamu'alaikum Warahmatullahi Wabarakatuh.\nInnalillahi wa inna ilaihi raji'un.\nAlhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal mursalin, wa 'ala alihi wa shahbihi ajma'in. Amma ba'du.\nDhumateng para sesepuh, pinisepuh ingkang tansah dahat kinabekten.\nDhumateng para takziyah, para tangga teparo, dalah para rawuh sedaya ingkang winantu ing pakurmatan.\nKula minangka sesulih utawi wakilipun kulawarga ageng ahli waris saking almarhum Bapak Harjo Sunarto, kanthi raos sedhih lan pasrah, keparenga matur wonten ngarsa panjenengan sedaya.\nIngkang kapisan, minangka titah sawantah, sumangga kita tansah ngunjukaken raos puji syukur wonten ngarsanipun Gusti Allah SWT. Dene ing kalodhangan menika kita saged kempal manunggal wonten ing dalem duka Dusun Kaliurang mriki, nindakaken kuwajiban sesarengan nguntapaken jenazah, kanthi wilujeng nir ing sambekala.\nPara rawuh ingkang kinurmatan,\nGusti Allah Ingkang Maha Kuwaos sampun ngresersaken, bilih ing dinten Kaping Pisan (Minggu) kepengkur, pinanggal 25 Oktober 2026, wanci jam 19.30 WIB, sederek kita, sepuh kita, inggih almarhum Bapak Harjo Sunarto sampun tinimbalan sowan wonten ngarsanipun Gusti Ingkang Maha Kawasa, kanthi tentrem ing yuswa 76 taun.\nKula minangka pangarsaning dhusun utawi Dukuh wonten ing mriki, ngaturaken matur nuwun ingkang tanpa upami dhumateng panjenengan sedaya, para tangga teparo, lan para takziyah ingkang sampun kersa rawuh. Matur nuwun sanget awit saking pambiyantu panjenengan sedaya, arupi wragad, tanaga, penggalihan, menapa dene donga pamuji ingkang sampun dipun-paringaken kagem almarhum lan ahli waris. Mugi-mugi sedaya amal kesaenan panjenengan dipunwales dening Gusti Allah kanthi berkah ingkang tikel matikel.\nIngkang kaping kalih, kula minangka wakilipun ahli waris, kanthi andhap asoring manah nyuwun agunging samudrasih pangaksama saking panjenengan sedaya. Mbok bilih ing wekdal gesangipun almarhum Bapak Harjo Sunarto kagadhah kalepatan, tindak-tanduk ingkang kirang mranani, utawi muna-muni ingkang nglarani penggalih panjenengan sedaya, mugi kersa paring pangapunten ingkang tulus lan ikhlas.\nUgi babagan dunya, bilih almarhum taksih kagadhah urusan utang-piutang menapa dene jaminan kaliyan panjenengan sedaya, kasuwun panjenengan kersa sesambungan kaliyan ahli waris sasampunipun adicara menika, supados sedaya urusan saged dipun-rampungaken kanthi sae lan almarhum saged bidhal kanthi entheng.\nPara rawuh ingkang sinuba ing pakurmatan,\nSekedhap malih, jenazah almarhum badhe dipun-angkat lan dipun-makamaken wonten ing Makam Sasanalaya Dusun Kaliurang. Pramila, kula nyuwun donga pamuji saking panjenengan sedaya, mugi-mugi almarhum dipun-tampi sedaya amal kesaenanipun, dipun-apunten sedaya dosanipun, dipun-paringi papan ingkang padhang lan jembar, sarta husnul khatimah. Kagem kulawarga ingkang dipun-tinggal, mugi dipun-paringi ketabahan, kesabaran, lan keikhlasan.\nPungkasaning atur saking kula minangka wakil ahli waris, mbok bilih wonten kiranging aruh, lungguh, lan suguh ingkang boten mranani penggalih panjenengan sedaya, kula nyuwun agunging pangapunten.\nMugi Gusti Allah tansah njangkung lampah kita sedaya. Amin.\nWassalamu'alaikum Warahmatullahi Wabarakatuh.`],
    ["budaling", "Budaling Lelayon (Takziah)", `Ass. Wr. Wb\nBismillahirohmanirrohim\nAlhamdulillahi robbil alamin wassolatu wa salamu alla asyrofil anbiya i wal mursalin, wa alla alihi wa sohbihi aj main. Amma ba'du\nNyuwun panjenenganipun poro sepuh pini sepuh ingkang kinabekten, linangkung bapak Lurah Bangunharjo, Bapak Nur Hidayat Sag Msi ingkang tansah kinurmatan, ibu RT 1, bapak RT 02, bapak RT 08&9 jotawang, tokoh masyarakat, Simbah kaum Rois lan sagung poro takziah kakung soho putri ingkang tansah kulo hormati.\nPinongko purwakaning atur, sumawi kulo derekaken manengku pujo wonten ngarso dalem allah ta'alla. Ingkang tansah soho taseh paring rahmat, hidayah soho inayahipun\nRahmat soho salam mugi karentahno dumateng junjungan kito nabi agung muhammad SAW sak garwo putro soho penderekipun ingkang tansah kito antu2 syafaatipun wonten ing yaumul qiyamah sak mangke.\nSak lajengipun, sedoyo ahli waris, hangaturaken pambagyo kawilujengan sugeng rawuh soho ngaturaken sanget agunging panuwun ingkang tanpo pepindan, Dene panjengan sami sampun kepareng hangentengaken saliro, mijiaken wekdal rawuh inggih kejawi nglaeraken raos sungkowo, ugi paring pakurmatan ingkang pungkasan dumateng almarhum bapak Herlan Setiabudi\nSagung poro takziah ingkang minulyo, atur uningo bilih ing dinten Jumat pon, suryo kaping 18 wulan september warso 2026 kirang langkung tabuh 04.15 enjing, panjenganipun almarhum bapak Herlan Setiabudi tinimbalan sowan wonten ngarsa dalem Allah ta'ala.\nSedanipun almarhum pinaringan ganjaran yuswo kirang langkung 62 th. (Kanti nilar garwo 1, Putro putrinipun 3,) Pramilo kanti puniko nyuwun panjurung dongo dumateng poro takziah kakung soho putri amrih sowanipun almarhum bapak Herlan Setiabudi wonten ngarsanipun gusti Allah dipun tampi sedoyo amal kesaenanipun, dipun apunten sedoyo doso kalepatanipun pinaringan padang jembar kuburipun lan ugi sedanipun kalebetno sedo ingkang husnul khotimah Aamiin 3x YRA.\n(Pramilo kanti meniko mbok bilih rikolo sugengipun almarhum anggenipun sesrawungan dumateng panjenengan pinanggih bab2 ingkang dereng karampungaken, sae puniko sambet sinambet soho hak2 adami, panjenengan saget irembakan kaliyan sedoyo ahli warisipun.\nEwo semanten mbok bilih sampun kaikhlasaken lajeng karelaken sedoyo ahli waris namung saget ngaturaken sanget agunging panuwun.)\nSagung poro takziah ingkang minulyo, wonten ing kalodangan puniko mboten kesupen, sedoyo ahli waris ugi ngaturaken sanget agunging panuwun dumateng tonggo tepalih, sanak kadang, pamong mitro, ingkang sampun kepareng paring pambiantu ingkang awujud nopo kemawon.\nPinongko pungkasaning atur, nyuwun dumateng panjenengan kerso derekaken lampahing jenazah ingkang sak mangke dipun sareaken ing makam suci Salakan jotawang, Bangunharjo Sewon bantul..\nEwo semanten, ingkang gadahi sesanggeman sanes, lajeng enggal2 bade ngersa'aken kondur sedoyo ahli waris ngaturaken sugeng kondur mugi tansah rahayu ingkang pinanggih.\nSoho anggenipun nampi karawuhan panjenengan sami bilih wonten kirangipun karono kawontenan ahli waris nyuwun agunging Samudro pangaksami.\nPoro takziah kakung soho putri mekaten aturipun ahli waris almarhum lumantar kulo, mbok bilih anggenipun kulo matur pinanggih lepat ing mriki kulo nyuwun agunging pangapunten.\nAkhiruk kalam Assalammu alaikum wr.wb`],
    ["pasrah", "Atur Pasrah Penganten (Pawiwahan)", `Assalamu'alaikum Warahmatullahi Wabarakatuh.\nAlhamdulillahirabbil 'alamin, washalatu wasalamu 'ala asyrafil ambiya'i wal morsalin, wa 'ala alihi wa shahbihi ajma'in. Amma ba'du.\nDhumateng para sesepuh, pinisepuh ingkang tansah dahat kinabekten.\nDhumateng kulawarga ageng Bapak Harjo Sunarto ingkang satuhu kinurmatan. Mligi dhumateng Bapak Dukuh Mangunsuwito saking Dusun Kaliurang ingkang sinudarsana.\nKula, minangka sesulih utawi wakilipun Bapak kaliyan Ibu Hardi Wibowo saking Dusun Kasongan, Kasihan, Bantul, keparenga matur wonten ngarsa panjenengan sedaya.\nIngkang kapisan, sumangga kita tansah ngaturaken raos syukur dhumateng Gusti Allah SWT, ingkang sampun paring kesarasan lan kalodhangan, saengga kita saged kempal manunggal wonten ing adicara pawiwahan menika kanthi wilujeng nir ing sambekala.\nIngkang kaping kalih, kula ngaturaken salam taklimipun Bapak kaliyan Ibu Hardi Wibowo katur dhumateng Bapak kaliyan Ibu Harjo Sunarto sakulawarga, kanthi pamuji mugi-mugi keslametan lan kabagyan tansah kajiwa kasasar dhumateng kita sedaya.\nPara rawuh ingkang kinurmatan,\nWosing gati utawi tujuwan sowan kula sakanca ing mriki, inggih menika nindakaken amanah pasrah penganten. Kula pasrahaken dhumateng kulawarga mriki, bilih anak mas Bagus Purnomo ingkang sampun nindakaken akad nikah, kanthi tulus ikhlasing manah kersaa dipunwengku lan dipuntampi dados kulawarga ageng wonten ing Dusun Kaliurang mriki.\nMinangka mudha-mudhi ingkang nembe ngancik dunya bebrayan, anak mas Bagus Purnomo menika taksih kirang pengalamanipun, taksih kathah kekiranganipun, lan taksih mbetahaken bimbingan. Mligi kagem Bapak Dukuh Mangunsuwito ing mriki lan para sesepuh, kula titip anak kula menika supados dipun-didik, dipun-arahaken, saengga saged dados warga dusun ingkang sae, saged manunggal kaliyan masyarakat, lan saged mbangun kulawarga ingkang sakinah, mawaddah, warahmah.\nKanthi tulus ikhlas, mangga penganten putra menika dipungandheng kaliyan penganten putri, dipunbimbing sesarengan wonten ing margining kabagyan.\nIngkang pungkasan, kula sakulawarga saking Dusun Kasongan nyuwun agunging samudrasih pangaksama, mbok bilih wonten tindak-tanduk, muna-muni, utawi tata krami sowan kula sakanca ingkang kirang mranani penggalih panjenengan sedaya.\nMugi Gusti Allah SWT tansah njangkung lan ngijabahi niat sae kita sedaya. Amin.\nWassalamu'alaikum Warahmatullahi Wabarakatuh.`],
    ["tampi", "Atur Nampi Penganten (Pawiwahan)", `Assalamu'alaikum Warahmatullahi Wabarakatuh.\nBismillah walhamdulillah, washalahtu wasalamu 'ala rasulillah, sayyidina Muhammadin wa 'ala alihi wa sahbihi ajma'in. Amma ba'du.\nDhumateng para sesepuh, pinisepuh ingkang satuhu pantes sinudarsana.\nDhumateng Bapak Dukuh Sujatmiko saking Dusun Kasongan, Bantul dalah para pengombyong penganten putra ingkang agung kasatriyanipun.\nSerta kulawarga ageng Bapak kaliyan Ibu Harjo Sunarto ingkang bagya mulya.\nKula minangka sesulih utawi wakil saking kulawarga ageng Bapak Harjo Sunarto, ugi minangka pangarsaning dhusun utawi Dukuh wonten ing Kaliurang mriki, keparenga amangsuli atur pasrah ingkang sampun dipun-andharaken kanthi cetha wela-wela dhumateng kita sedaya.\nIngkang kapisan, sumangga kita sesarengan ngaturaken puja lan puji syukur wonten ngarsanipun Gusti Ingkang Maha Agung, amargi kanthi rahmat lan hidayah-Ipun, rombongan penganten putra saged rawuh kanthi binerkahan keslametan, boten wonten alangan satunggal menika.\nIngkang kaping kalih, kula nampi salam taklimipun saking Bapak kaliyan Ibu Hardi Wibowo saking Dusun Kasongan. Kula wangsuli kanthi salam taklim ingkang sami, mugi sesambungan paseduluran ingkang sae menika saged tansah rumaket ngantos akhir jaman.\nPara rawuh ingkang sinuba ing pakurmatan,\nNgenani wosing gati pasrah panjenengan, kula minangka wakil kulawarga lan minangka pamong wonten ing Dusun Kaliurang mriki, kanthi thukul ikhlasing manah, nampi kanthi asta kalih lan gumbiranipun penggalih pasrah penganten putra, inggih anak mas Bagus Purnomo.\nMulai detik menika, anak mas Bagus Purnomo sampun resmi dados perangan saking kulawarga ageng Bapak Harjo Sunarto, lan ugi sah dados warga dhusun kita wonten ing mriki.\nBabagan bimbingan lan pituduh ingkang dipun-kersaken wau, sampun dados kuwajiban kita sedaya minangka tiyang sepuh lan pamong. Kita badhe sesarengan njagi, ngarahaken, lan ndedonga, mugi-mugi penganten kekalih, anak mas Bagus Purnomo lan anak roro Siti Rahayu, saged nyawiji, asah, asih, asuh, nemtokaken jangkah ingkang sae, lan saged mbangun kulawarga ingkang bagya mulya, ngantos kaken-kaken ninen-ninen.\nSalajengipun, sumangga para tamu pengombyong saking Dusun Kasongan, kula aturi lenggah kanthi sekeca, kanthi mardikaning penggalih, ngrahapi dedhaharan lan pasugatan ingkang sampun dicepakaken, senadyan wontenipun namung prasaja.\nPungkasaning atur, kula minangka wakil mriki nyuwun pangapunten ingkang agung, mbok bilih wonten thithik kuciwaning aruh, lungguh, lan suguh ingkang kirang nengsemaken wonten ing manah panjenengan sedaya.\nMugi-mugi Gusti Allah tansah mberkahi adicara menika. Amin.\nWassalamu'alaikum Warahmatullahi Wabarakatuh.`]
  ];

  sheet.getRange(2, 1, dataPidato.length, 3).setValues(dataPidato);
  sheet.setColumnWidth(1, 100).setColumnWidth(2, 250).setColumnWidth(3, 600);
  SpreadsheetApp.getUi().alert("✅ Sheet TeksPidato dibuat dan diisi dengan 5 teks pidato.");
}