const storageDefaults = {
  monthProfiles: {},
  otRecords: [],
};

const elements = {
  status: document.getElementById('appStatus'),
  tabs: document.querySelectorAll('.tab-button'),
  panels: document.querySelectorAll('.panel'),
  summaryPanel: document.getElementById('summary'),
  recordsPanel: document.getElementById('records'),
  settingsPanel: document.getElementById('settings'),
  summaryYear: document.getElementById('summaryYear'),
  summaryMonth: document.getElementById('summaryMonth'),
  refreshSummary: document.getElementById('refreshSummary'),
  summaryMonthLabel: document.getElementById('summaryMonthLabel'),
  summaryCount: document.getElementById('summaryCount'),
  summaryHours: document.getElementById('summaryHours'),
  summaryBasePay: document.getElementById('summaryBasePay'),
  summaryNightPay: document.getElementById('summaryNightPay'),
  summaryAllowancePay: document.getElementById('summaryAllowancePay'),
  summaryTotalPay: document.getElementById('summaryTotalPay'),
  recordForm: document.getElementById('recordForm'),
  recordYear: document.getElementById('recordYear'),
  recordMonth: document.getElementById('recordMonth'),
  recordDate: document.getElementById('recordDate'),
  recordStart: document.getElementById('recordStart'),
  recordEnd: document.getElementById('recordEnd'),
  recordExtra: document.getElementById('recordExtra'),
  recordMemo: document.getElementById('recordMemo'),
  recordsTableBody: document.querySelector('#recordsTable tbody'),
  profileForm: document.getElementById('profileForm'),
  profileYear: document.getElementById('profileYear'),
  profileMonth: document.getElementById('profileMonth'),
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

function getMonthKey(year, month) {
  return `${year}-${pad(month)}`;
}

function getDefaultProfile(year, month) {
  return {
    year,
    month,
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
        monthProfiles: result.monthProfiles || {},
        otRecords: result.otRecords || [],
      };
      resolve();
    });
  });
}

function saveState() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      monthProfiles: state.monthProfiles,
      otRecords: state.otRecords,
    }, resolve);
  });
}

function invalidateSummaryCache() {
  summaryCache = null;
}

function ensureDefaults() {
  if (!state.otRecords) state.otRecords = [];
  if (!state.monthProfiles) state.monthProfiles = {};
}

function fillYearMonthSelects() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const years = Array.from({ length: 5 }, (_, idx) => currentYear - 2 + idx);
  const monthOptions = Array.from({ length: 12 }, (_, idx) => idx + 1);
  const selects = [
    elements.summaryYear,
    elements.summaryMonth,
    elements.recordYear,
    elements.recordMonth,
    elements.profileYear,
    elements.profileMonth,
  ];
  selects.forEach((select) => {
    select.innerHTML = '';
  });
  years.forEach((year) => {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = `${year}년`;
    [elements.summaryYear, elements.recordYear, elements.profileYear].forEach((select) => select.appendChild(option.cloneNode(true)));
  });
  monthOptions.forEach((month) => {
    const option = document.createElement('option');
    option.value = month;
    option.textContent = `${month}월`;
    [elements.summaryMonth, elements.recordMonth, elements.profileMonth].forEach((select) => select.appendChild(option.cloneNode(true)));
  });
  [elements.summaryYear, elements.recordYear, elements.profileYear].forEach((select) => select.value = currentYear);
  [elements.summaryMonth, elements.recordMonth, elements.profileMonth].forEach((select) => select.value = now.getMonth() + 1);
}

function getProfileForCurrentSelection() {
  const key = getMonthKey(currentYear, currentMonth);
  return state.monthProfiles[key] || getDefaultProfile(currentYear, currentMonth);
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

function setStatus(text) {
  elements.status.textContent = text;
}

function getSummaryData(year, month) {
  if (summaryCache && summaryCache.year === year && summaryCache.month === month) {
    return summaryCache;
  }

  const profile = getProfileForCurrentSelection();
  const records = state.otRecords.filter((record) => record.year === year && record.month === month);
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
  elements.recordYear.value = currentYear;
  elements.recordMonth.value = currentMonth;
  elements.profileYear.value = currentYear;
  elements.profileMonth.value = currentMonth;
  refreshProfileForm();
  updateSummary();
  const activePanel = getActivePanelId();
  if (activePanel === 'records') {
    renderRecords();
  }
}

function saveProfile(year, month, profile) {
  const key = getMonthKey(year, month);
  state.monthProfiles[key] = profile;
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

function showMessage(text, duration = 2200) {
  elements.status.textContent = text;
  if (duration > 0) {
    setTimeout(() => {
      elements.status.textContent = '정상';
    }, duration);
  }
}

function setupEvents() {
  document.querySelector('.tab-bar').addEventListener('click', dispatchTab);

  elements.refreshSummary.addEventListener('click', () => {
    currentYear = Number(elements.summaryYear.value);
    currentMonth = Number(elements.summaryMonth.value);
    refreshProfileForm();
    updateSummary();
    showMessage('요약이 업데이트되었습니다.');
  });

  elements.recordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const year = Number(elements.recordYear.value);
      const month = Number(elements.recordMonth.value);
      const workDate = elements.recordDate.value;
      const startTime = normalizeTime(elements.recordStart.value);
      const endTime = normalizeTime(elements.recordEnd.value);
      const extraPay = Number(elements.recordExtra.value);
      const memo = elements.recordMemo.value.trim();
      const profileKey = getMonthKey(year, month);
      const profile = state.monthProfiles[profileKey] || getDefaultProfile(year, month);
      const recordData = { year, month, workDate, startTime, endTime, extraPay, memo, profile };
      await addRecord(recordData);
      renderRecords();
      updateSummary();
      elements.recordForm.reset();
      elements.recordExtra.value = '0';
      elements.recordStart.value = '22:00';
      elements.recordEnd.value = '06:00';
      showMessage('OT 기록이 저장되었습니다.');
    } catch (error) {
      showMessage(error.message || '입력 값을 확인하세요.', 3200);
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
      const month = Number(elements.profileMonth.value);
      const profile = {
        year,
        month,
        hourlyWage: Number(elements.profileWage.value),
        otMultiplier: Number(elements.profileOtMultiplier.value),
        nightMultiplier: Number(elements.profileNightMultiplier.value),
        nightStart: normalizeTime(elements.profileNightStart.value),
        nightEnd: normalizeTime(elements.profileNightEnd.value),
        note: elements.profileNote.value.trim(),
      };
      await saveProfile(year, month, profile);
      showMessage('월별 설정이 저장되었습니다.');
      if (year === currentYear && month === currentMonth) {
        refreshProfileForm();
        updateSummary();
      }
    } catch (error) {
      showMessage(error.message || '설정 값을 확인하세요.', 3200);
    }
  });
}

async function init() {
  await loadState();
  ensureDefaults();
  fillYearMonthSelects();
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  elements.summaryYear.value = currentYear;
  elements.summaryMonth.value = currentMonth;
  elements.recordYear.value = currentYear;
  elements.recordMonth.value = currentMonth;
  elements.profileYear.value = currentYear;
  elements.profileMonth.value = currentMonth;
  elements.recordDate.value = now.toISOString().slice(0, 10);
  elements.recordStart.value = '22:00';
  elements.recordEnd.value = '06:00';
  await saveState();
  refreshAll();
  setupEvents();
  setStatus('정상');
}

init().catch((error) => {
  setStatus('로드 실패');
  console.error(error);
});
