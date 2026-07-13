const storageDefaults = {
  yearProfiles: {},
  otRecords: [],
};

const elements = {
  status: document.getElementById('appStatus'),
  toast: document.getElementById('toastMessage'),
  tabs: document.querySelectorAll('.tab-button'),
  panels: document.querySelectorAll('.panel'),
  summaryPanel: document.getElementById('summary'),
  recordsPanel: document.getElementById('records'),
  settingsPanel: document.getElementById('settings'),
  summaryYear: document.getElementById('summaryYear'),
  summaryMonth: document.getElementById('summaryMonth'),
  summaryMonthLabel: document.getElementById('summaryMonthLabel'),
  summaryCount: document.getElementById('summaryCount'),
  summaryHours: document.getElementById('summaryHours'),
  summaryBasePay: document.getElementById('summaryBasePay'),
  summaryNightPay: document.getElementById('summaryNightPay'),
  summaryAllowancePay: document.getElementById('summaryAllowancePay'),
  summaryTotalPay: document.getElementById('summaryTotalPay'),
  recordForm: document.getElementById('recordForm'),
  recordDate: document.getElementById('recordDate'),
  recordStart: document.getElementById('recordStart'),
  recordEnd: document.getElementById('recordEnd'),
  recordExtra: document.getElementById('recordExtra'),
  recordMemo: document.getElementById('recordMemo'),
  recordsTableBody: document.querySelector('#recordsTable tbody'),
  profileForm: document.getElementById('profileForm'),
  exportDataButton: document.getElementById('exportDataButton'),
  importDataButton: document.getElementById('importDataButton'),
  clearRecordsButton: document.getElementById('clearRecordsButton'),
  settingsList: document.getElementById('settingsList'),
  importDataFile: document.getElementById('importDataFile'),
  profileYear: document.getElementById('profileYear'),
  profileWage: document.getElementById('profileWage'),
  profileOtMultiplier: document.getElementById('profileOtMultiplier'),
  profileNightMultiplier: document.getElementById('profileNightMultiplier'),
  profileNightStart: document.getElementById('profileNightStart'),
  profileNightEnd: document.getElementById('profileNightEnd'),
  profileNote: document.getElementById('profileNote'),
};

let state = { ...storageDefaults };
let currentYear;
let currentMonth;
let summaryCache = null;

function formatWon(value) {
  return `${Math.round(value).toLocaleString()}원`;
}

function pad(value) {
  return value.toString().padStart(2, '0');
}

function parseHHMM(value) {
  const [hh, mm] = value.split(':').map(Number);
  return hh * 60 + mm;
}

function normalizeTime(value) {
  const normalized = value.trim();
  if (!normalized) throw new Error('시간이 비어 있습니다.');
  if (!/^\d{1,2}:\d{2}$/.test(normalized)) {
    throw new Error('시간 형식은 HH:MM 이어야 합니다.');
  }
  const [hh, mm] = normalized.split(':').map(Number);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error('시간 범위가 올바르지 않습니다.');
  }
  return `${pad(hh)}:${pad(mm)}`;
}

function intervalMinutes(start, end) {
  if (end <= start) return end + 1440 - start;
  return end - start;
}

function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function crossMidnightSegments(start, end) {
  return start < end ? [[start, end], [start + 1440, end + 1440]] : [[start, 1440], [1440, end + 1440]];
}

function overlapWithWindow(shiftStart, shiftEnd, windowStart, windowEnd) {
  if (shiftEnd <= shiftStart) shiftEnd += 1440;
  const segments = crossMidnightSegments(windowStart, windowEnd);
  return segments.reduce((sum, [ws, we]) => sum + overlapMinutes(shiftStart, shiftEnd, ws, we), 0);
}

function calculateAllowance(startMin, endMin, rules) {
  if (endMin <= startMin) endMin += 1440;
  return rules.reduce((sum, rule) => {
    if (!rule.active) return sum;
    const rs = parseHHMM(rule.startTime);
    const re = parseHHMM(rule.endTime);
    const segments = crossMidnightSegments(rs, re);
    const ruleMinutes = segments.reduce((sub, [segStart, segEnd]) => sub + overlapMinutes(startMin, endMin, segStart, segEnd), 0);
    return sum + (ruleMinutes / 60) * rule.amountPerHour;
  }, 0);
}

function calculateComponents(profile, startTime, endTime, rules, extraPay) {
  const s = parseHHMM(startTime);
  const e = parseHHMM(endTime);
  const workedMinutes = intervalMinutes(s, e);
  const hours = workedMinutes / 60;
  const nightStart = parseHHMM(profile.nightStart);
  const nightEnd = parseHHMM(profile.nightEnd);
  const nightMinutes = overlapWithWindow(s, e, nightStart, nightEnd);
  const nightHours = nightMinutes / 60;
  const regularOtHours = Math.max(0, hours - nightHours);
  const basePay = profile.hourlyWage * profile.otMultiplier * regularOtHours;
  const nightPay = profile.hourlyWage * profile.nightMultiplier * nightHours;
  const allowancePay = extraPay * Math.floor(hours);
  const totalPay = basePay + nightPay + allowancePay;
  return { hours, basePay, nightPay, allowancePay, totalPay };
}

function getProfileForYear(year) {
  const key = getYearKey(year);
  return state.yearProfiles[key] || getDefaultProfile(year);
}

function normalizeStoredRecords() {
  state.otRecords = state.otRecords.map((record) => {
    const profile = getProfileForYear(record.year);
    const recalculated = calculateComponents(profile, record.startTime, record.endTime, [], record.extraPay);
    return {
      ...record,
      ...recalculated,
    };
  });
}

function getYearKey(year) {
  return `${year}`;
}

function getDefaultProfile(year) {
  return {
    year,
    hourlyWage: 10320,
    otMultiplier: 1.5,
    nightMultiplier: 2.0,
    nightStart: '22:00',
    nightEnd: '06:00',
    note: '',
  };
}

function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(storageDefaults, (result) => {
      state = {
        yearProfiles: result.yearProfiles || {},
        otRecords: result.otRecords || [],
      };
      resolve();
    });
  });
}

function saveState() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      yearProfiles: state.yearProfiles,
      otRecords: state.otRecords,
    }, resolve);
  });
}

function invalidateSummaryCache() {
  summaryCache = null;
}

function ensureDefaults() {
  if (!state.otRecords) state.otRecords = [];
  if (!state.yearProfiles) state.yearProfiles = {};
}

function fillYearMonthSelects() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 5 }, (_, idx) => currentYear - 2 + idx);
  const monthOptions = Array.from({ length: 12 }, (_, idx) => idx + 1);
  const yearSelects = [elements.summaryYear, elements.profileYear];
  elements.summaryMonth.innerHTML = '';
  elements.summaryYear.innerHTML = '';
  elements.profileYear.innerHTML = '';
  years.forEach((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = `${year}년`;
    yearSelects.forEach((select) => select.appendChild(option.cloneNode(true)));
  });
  monthOptions.forEach((month) => {
    const option = document.createElement('option');
    option.value = month;
    option.textContent = `${month}월`;
    elements.summaryMonth.appendChild(option);
  });
  yearSelects.forEach((select) => (select.value = currentYear));
  elements.summaryMonth.value = now.getMonth() + 1;
}

function getProfileForCurrentSelection() {
  return getProfileForYear(Number(elements.profileYear.value));
}

function refreshProfileForm() {
  const profile = getProfileForCurrentSelection();
  elements.profileWage.value = profile.hourlyWage;
  elements.profileOtMultiplier.value = profile.otMultiplier;
  elements.profileNightMultiplier.value = profile.nightMultiplier;
  elements.profileNightStart.value = profile.nightStart;
  elements.profileNightEnd.value = profile.nightEnd;
  elements.profileNote.value = profile.note;
}

function renderSettingsList() {
  if (!elements.settingsList) return;
  const profileKeys = Object.keys(state.yearProfiles).sort((a, b) => b.localeCompare(a));
  if (!profileKeys.length) {
    elements.settingsList.innerHTML = '<div class="settings-list-empty">저장된 설정이 없습니다.</div>';
    return;
  }

  const items = profileKeys.map((key) => {
    const year = key;
    return `<button type="button" class="settings-list-item" data-key="${key}">${year}년</button>`;
  });
  elements.settingsList.innerHTML = items.join('');
}

function loadProfileSettings(key) {
  const year = Number(key);
  elements.profileYear.value = year;
  refreshProfileForm();
  showMessage(`${year}년 설정을 불러왔습니다.`);
}

function setStatus(text) {
  elements.status.textContent = text;
}

function getSummaryData(year, month) {
  if (summaryCache && summaryCache.year === year && summaryCache.month === month) {
    return summaryCache;
  }

  const profile = getProfileForYear(year);
  const filteredRecords = state.otRecords.filter((record) => record.year === year && record.month === month);
  const records = filteredRecords.map((record) => ({
    ...record,
    ...calculateComponents(profile, record.startTime, record.endTime, [], record.extraPay),
  }));
  const totalHours = records.reduce((sum, record) => sum + record.hours, 0);
  const totalBase = records.reduce((sum, record) => sum + record.basePay, 0);
  const totalNight = records.reduce((sum, record) => sum + record.nightPay, 0);
  const totalAllowance = records.reduce((sum, record) => sum + record.allowancePay, 0);
  const totalPay = records.reduce((sum, record) => sum + record.totalPay, 0);

  summaryCache = {
    year,
    month,
    profile,
    records,
    totalHours,
    totalBase,
    totalNight,
    totalAllowance,
    totalPay,
  };

  return summaryCache;
}

function getActivePanelId() {
  const activeTab = document.querySelector('.tab-button.active');
  return activeTab ? activeTab.dataset.tab : null;
}

function updateSummary() {
  const summary = getSummaryData(currentYear, currentMonth);
  elements.summaryMonthLabel.textContent = `${summary.year}년 ${summary.month}월`;
  elements.summaryCount.textContent = summary.records.length;
  elements.summaryHours.textContent = `${summary.totalHours.toFixed(2)}시간`;
  elements.summaryBasePay.textContent = formatWon(summary.totalBase);
  elements.summaryNightPay.textContent = formatWon(summary.totalNight);
  elements.summaryAllowancePay.textContent = formatWon(summary.totalAllowance);
  elements.summaryTotalPay.textContent = formatWon(summary.totalPay);
}

function renderRecords() {
  const records = state.otRecords
    .filter((record) => record.year === currentYear && record.month === currentMonth)
    .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.startTime.localeCompare(b.startTime));
  elements.recordsTableBody.innerHTML = '';

  if (!records.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="6" style="text-align:center; color:#687695;">기록이 없습니다.</td>';
    elements.recordsTableBody.appendChild(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${record.workDate}</td>
      <td>${record.startTime}-${record.endTime}</td>
      <td>${record.hours.toFixed(2)}h</td>
      <td>${formatWon(record.totalPay)}</td>
      <td>${record.memo || '-'}</td>
      <td><button class="action-button" data-action="delete" data-id="${record.id}">삭제</button></td>
    `;
    fragment.appendChild(row);
  });
  elements.recordsTableBody.appendChild(fragment);
}

function dispatchTab(event) {
  const button = event.target.closest('.tab-button');
  if (!button) return;
  elements.tabs.forEach((tab) => tab.classList.remove('active'));
  button.classList.add('active');
  const target = button.dataset.tab;
  elements.panels.forEach((panel) => panel.classList.remove('active'));
  document.getElementById(target).classList.add('active');
  if (target === 'records') {
    renderRecords();
  }
}

function refreshAll() {
  currentYear = Number(elements.summaryYear.value);
  currentMonth = Number(elements.summaryMonth.value);
  elements.profileYear.value = currentYear;
  refreshProfileForm();
  updateSummary();
  const activePanel = getActivePanelId();
  if (activePanel === 'records') {
    renderRecords();
  }
}

function saveProfile(year, profile) {
  const key = getYearKey(year);
  state.yearProfiles[key] = profile;
  return saveState();
}

function addRecord(data) {
  const record = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    year: data.year,
    month: data.month,
    workDate: data.workDate,
    startTime: data.startTime,
    endTime: data.endTime,
    extraPay: data.extraPay,
    memo: data.memo,
    ...calculateComponents(data.profile, data.startTime, data.endTime, data.rules, data.extraPay),
  };
  state.otRecords.push(record);
  invalidateSummaryCache();
  return saveState();
}

function removeRecord(id) {
  state.otRecords = state.otRecords.filter((record) => record.id !== id);
  invalidateSummaryCache();
  return saveState();
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    yearProfiles: state.yearProfiles || {},
    otRecords: state.otRecords || [],
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ot-records-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showMessage('데이터를 내보냈습니다.');
}

function clearAllRecords() {
  state.otRecords = [];
  invalidateSummaryCache();
  return saveState();
}

function importDataFromFile(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(reader.result);
      const importedProfiles = parsed.yearProfiles && typeof parsed.yearProfiles === 'object' ? parsed.yearProfiles : {};
      const importedRecords = Array.isArray(parsed.otRecords) ? parsed.otRecords : [];

      if (!window.confirm('현재 데이터를 가져온 데이터로 교체하시겠습니까?')) {
        return;
      }

      state.yearProfiles = importedProfiles;
      state.otRecords = importedRecords;
      invalidateSummaryCache();
      await saveState();
      refreshAll();
      renderSettingsList();
      renderRecords();
      updateSummary();
      showMessage('데이터를 가져왔습니다.');
    } catch (error) {
      showMessage(error.message || '가져오기 실패', 3200);
    }
  };
  reader.readAsText(file);
}

let toastTimer = null;

function showMessage(text, duration = 2800) {
  elements.status.textContent = text;
  if (elements.toast) {
    elements.toast.textContent = text;
    elements.toast.classList.add('active');
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove('active');
      toastTimer = null;
    }, duration);
  }
  if (duration > 0) {
    setTimeout(() => {
      elements.status.textContent = '정상';
    }, duration);
  }
}

function setupEvents() {
  document.querySelector('.tab-bar').addEventListener('click', dispatchTab);

  elements.summaryYear.addEventListener('change', () => {
    refreshAll();
  });

  elements.summaryMonth.addEventListener('change', () => {
    refreshAll();
  });

  elements.exportDataButton.addEventListener('click', exportData);
  elements.importDataButton.addEventListener('click', () => elements.importDataFile.click());
  elements.clearRecordsButton.addEventListener('click', async () => {
    if (!window.confirm('정말 모든 OT 기록을 삭제하시겠습니까?')) return;
    await clearAllRecords();
    refreshAll();
    renderRecords();
    updateSummary();
    showMessage('전체 기록이 삭제되었습니다.');
  });
  elements.settingsList.addEventListener('click', (event) => {
    const button = event.target.closest('.settings-list-item');
    if (!button) return;
    loadProfileSettings(button.dataset.key);
  });
  elements.importDataFile.addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    importDataFromFile(file);
    event.target.value = '';
  });

  elements.recordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const workDate = elements.recordDate.value;
      const [year, month] = workDate.split('-').map(Number);
      const startTime = normalizeTime(elements.recordStart.value);
      const endTime = normalizeTime(elements.recordEnd.value);
      const extraPay = Number(elements.recordExtra.value);
      const memo = elements.recordMemo.value.trim();
      const profile = getProfileForYear(year);
      const recordData = { year, month, workDate, startTime, endTime, extraPay, memo, profile };
      await addRecord(recordData);
      renderRecords();
      updateSummary();
      elements.recordForm.reset();
      elements.recordExtra.value = '0';
      elements.recordStart.value = '22:00';
      elements.recordStart.dispatchEvent(new Event('change'));
      showMessage('기록이 저장되었습니다.');
    } catch (error) {
      showMessage(error.message || '입력 값을 확인하세요.', 3200);
    }
  });

  elements.recordStart.addEventListener('change', (event) => {
    const startTime = event.target.value;
    if (startTime) {
      try {
        const [hh, mm] = startTime.split(':').map(Number);
        const endHours = (hh + 1) % 24;
        const endTime = `${String(endHours).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        elements.recordEnd.value = endTime;
      } catch (error) {
        console.error('시간 설정 오류:', error);
      }
    }
  });

  elements.recordsTableBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = Number(button.dataset.id);
    if (button.dataset.action === 'delete') {
      await removeRecord(id);
      renderRecords();
      updateSummary();
      showMessage('기록이 삭제되었습니다.');
    }
  });

  elements.profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const year = Number(elements.profileYear.value);
      const profile = {
        year,
        hourlyWage: Number(elements.profileWage.value),
        otMultiplier: Number(elements.profileOtMultiplier.value),
        nightMultiplier: Number(elements.profileNightMultiplier.value),
        nightStart: normalizeTime(elements.profileNightStart.value),
        nightEnd: normalizeTime(elements.profileNightEnd.value),
        note: elements.profileNote.value.trim(),
      };
      await saveProfile(year, profile);
      invalidateSummaryCache();
      normalizeStoredRecords();
      await saveState();
      showMessage('연 별 설정이 저장되었습니다.');
      renderSettingsList();
      if (year === currentYear) {
        refreshProfileForm();
        updateSummary();
        renderRecords();
      }
    } catch (error) {
      showMessage(error.message || '설정 값을 확인하세요.', 3200);
    }
  });
}

async function init() {
  await loadState();
  ensureDefaults();
  normalizeStoredRecords();
  fillYearMonthSelects();
  setupEvents();
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  elements.summaryYear.value = currentYear;
  elements.summaryMonth.value = currentMonth;
  elements.profileYear.value = currentYear;
  elements.recordDate.value = now.toISOString().slice(0, 10);
  elements.recordStart.value = '22:00';
  elements.recordStart.dispatchEvent(new Event('change'));
  await saveState();
  refreshAll();
  renderSettingsList();
  setStatus('정상');
}

init().catch((error) => {
  setStatus('로드 실패');
  console.error(error);
});
