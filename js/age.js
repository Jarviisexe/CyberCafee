// Age Calculator Module
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toInputDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resetAgeToday() {
  document.getElementById('ageTargetInput').value = toInputDateStr(new Date());
  calculateAge();
}

function parseLocalDate(val) {
  if (!val) return null;
  const [y, m, d] = val.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function calculateAge() {
  const dob = parseLocalDate(document.getElementById('ageDobInput').value);
  const target = parseLocalDate(document.getElementById('ageTargetInput').value) || new Date();

  const heroEl = document.getElementById('ageHeroValue');
  const catEl = document.getElementById('ageCategoryBadge');
  const sumEl = document.getElementById('ageSummaryText');

  if (!dob) {
    heroEl.innerText = '— Years, — Months, — Days';
    catEl.innerText = 'Select DOB';
    sumEl.innerText = 'Enter your Date of Birth to see full breakdown';
    return;
  }

  if (dob > target) {
    heroEl.innerText = 'DOB cannot be after target date';
    catEl.innerText = 'Invalid';
    sumEl.innerText = 'Please select a valid Date of Birth';
    return;
  }

  let years = target.getFullYear() - dob.getFullYear();
  let months = target.getMonth() - dob.getMonth();
  let days = target.getDate() - dob.getDate();

  if (days < 0) {
    months--;
    const prevMonthDays = new Date(target.getFullYear(), target.getMonth(), 0).getDate();
    days += prevMonthDays;
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  heroEl.innerText = `${years} Years, ${months} Months, ${days} Days`;

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

  // Next Birthday Calculation relative to target date
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

  sumEl.innerText = `DOB: ${dob.getDate()} ${MONTHS_SHORT[dob.getMonth()]} ${dob.getFullYear()} • Age: ${years}y ${months}m ${days}d`;
}

function copyAgeSummary() {
  const val = document.getElementById('ageHeroValue').innerText;
  const sum = document.getElementById('ageSummaryText').innerText;
  if (val.startsWith('—')) return;
  navigator.clipboard?.writeText(`${sum} (${val})`).then(() => {
    showToast('Age copied to clipboard!');
  });
}

// Set Target Date to Today on load
resetAgeToday();
