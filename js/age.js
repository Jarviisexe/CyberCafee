// Age Calculator Module (Supports Manual DD/MM/YYYY Typing & Calendar Picker)
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDDMMYYYY(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function formatYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Strictly parses DD/MM/YYYY (rejects invalid dates like 31/02/2000)
function parseDDMMYYYY(str) {
  const cleaned = (str || '').trim().replace(/[-.]/g, '/');
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(cleaned);
  if (!match) return null;

  const d = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  if (y < 1900 || y > 2150 || m < 1 || m > 12 || d < 1 || d > 31) return null;

  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function openNativePicker(pickerId) {
  const el = document.getElementById(pickerId);
  if (el.showPicker) el.showPicker();
  else el.click();
}

function onManualDateInput(which) {
  const textEl = document.getElementById(which === 'dob' ? 'ageDobText' : 'ageTargetText');
  const pickerEl = document.getElementById(which === 'dob' ? 'ageDobPicker' : 'ageTargetPicker');

  // Auto-insert slashes as user types digits (e.g. 15082000 -> 15/08/2000)
  let digits = textEl.value.replace(/\D/g, '').slice(0, 8);
  let formatted = digits;
  if (digits.length > 4) formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  else if (digits.length > 2) formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;

  if (textEl.value !== formatted) textEl.value = formatted;

  const parsed = parseDDMMYYYY(formatted);
  if (parsed) {
    pickerEl.value = formatYYYYMMDD(parsed);
  }
  calculateAge();
}

function onPickerDateChange(which) {
  const textEl = document.getElementById(which === 'dob' ? 'ageDobText' : 'ageTargetText');
  const pickerEl = document.getElementById(which === 'dob' ? 'ageDobPicker' : 'ageTargetPicker');
  if (pickerEl.value) {
    const [y, m, d] = pickerEl.value.split('-').map(Number);
    textEl.value = formatDDMMYYYY(new Date(y, m - 1, d));
  }
  calculateAge();
}

function resetAgeToday() {
  const today = new Date();
  document.getElementById('ageTargetText').value = formatDDMMYYYY(today);
  document.getElementById('ageTargetPicker').value = formatYYYYMMDD(today);
  calculateAge();
}

function clearAgeStats(statusMsg) {
  document.getElementById('ageHeroValue').innerText = '— Years, — Months, — Days';
  document.getElementById('ageCategoryBadge').innerText = statusMsg;
  document.getElementById('ageBornDay').innerText = '—';
  document.getElementById('ageTotalMonths').innerText = '—';
  document.getElementById('ageTotalWeeks').innerText = '—';
  document.getElementById('ageTotalDays').innerText = '—';
  document.getElementById('ageTotalHours').innerText = '—';
  document.getElementById('ageNextBday').innerText = '—';
  document.getElementById('ageNextBdaySub').innerText = 'Waiting for valid DOB';
}

function calculateAge() {
  const dobText = document.getElementById('ageDobText').value;
  const targetText = document.getElementById('ageTargetText').value;

  const dob = parseDDMMYYYY(dobText);
  const target = parseDDMMYYYY(targetText) || new Date();
  const sumEl = document.getElementById('ageSummaryText');

  if (!dob) {
    clearAgeStats(dobText.length >= 10 ? 'Invalid Date' : 'Enter DOB');
    sumEl.innerText = dobText.length >= 10
      ? 'Please enter a valid date in DD/MM/YYYY format'
      : 'Type DD/MM/YYYY or choose from calendar';
    return;
  }

  if (dob > target) {
    clearAgeStats('Invalid Range');
    document.getElementById('ageHeroValue').innerText = 'DOB cannot be after target date';
    sumEl.innerText = 'Please enter a Date of Birth earlier than Target Date';
    return;
  }

  let years = target.getFullYear() - dob.getFullYear();
  let months = target.getMonth() - dob.getMonth();
  let days = target.getDate() - dob.getDate();

  if (days < 0) {
    months--;
    days += new Date(target.getFullYear(), target.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  document.getElementById('ageHeroValue').innerText = `${years} Years, ${months} Months, ${days} Days`;

  const catEl = document.getElementById('ageCategoryBadge');
  if (years >= 60) {
    catEl.innerText = 'Senior Citizen (60+)';
    catEl.style.color = '#fbbf24';
  } else if (years >= 18) {
    catEl.innerText = 'Adult (18+)';
    catEl.style.color = '#34d399';
  } else {
    catEl.innerText = 'Minor (<18)';
    catEl.style.color = '#38bdf8';
  }

  const totalDays = Math.floor((target - dob) / (1000 * 60 * 60 * 24));
  const totalWeeks = Math.floor(totalDays / 7);
  const totalMonths = years * 12 + months;
  const totalHours = totalDays * 24;

  let nextBday = new Date(target.getFullYear(), dob.getMonth(), dob.getDate());
  if (nextBday <= target) {
    nextBday = new Date(target.getFullYear() + 1, dob.getMonth(), dob.getDate());
  }
  let nbM = nextBday.getMonth() - target.getMonth();
  let nbD = nextBday.getDate() - target.getDate();
  if (nbD < 0) {
    nbM--;
    nbD += new Date(nextBday.getFullYear(), nextBday.getMonth(), 0).getDate();
  }
  if (nbM < 0) nbM += 12;

  const isBirthdayToday = dob.getMonth() === target.getMonth() && dob.getDate() === target.getDate();

  document.getElementById('ageBornDay').innerText = WEEKDAYS[dob.getDay()];
  document.getElementById('ageTotalMonths').innerText = totalMonths.toLocaleString('en-IN');
  document.getElementById('ageTotalWeeks').innerText = totalWeeks.toLocaleString('en-IN');
  document.getElementById('ageTotalDays').innerText = totalDays.toLocaleString('en-IN');
  document.getElementById('ageTotalHours').innerText = totalHours.toLocaleString('en-IN');

  if (isBirthdayToday) {
    document.getElementById('ageNextBday').innerText = '🎉 Today!';
    document.getElementById('ageNextBdaySub').innerText = 'Happy Birthday!';
  } else {
    document.getElementById('ageNextBday').innerText = `${nbM}M ${nbD}D`;
    document.getElementById('ageNextBdaySub').innerText =
      `On ${nextBday.getDate()} ${MONTHS_SHORT[nextBday.getMonth()]} (${WEEKDAYS[nextBday.getDay()]})`;
  }

  sumEl.innerText = `DOB: ${formatDDMMYYYY(dob)} • Age: ${years}y ${months}m ${days}d`;
}

function copyAgeSummary() {
  const val = document.getElementById('ageHeroValue').innerText;
  const sum = document.getElementById('ageSummaryText').innerText;
  if (val.startsWith('—')) return;
  navigator.clipboard?.writeText(`${sum} (${val})`).then(() => {
    showToast('Age copied to clipboard!');
  });
}

resetAgeToday();
