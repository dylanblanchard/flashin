'use strict';

// ─── Constants ────────────────────────────────────────────
const STORAGE_KEY = 'flashin_data';
const NEW_CARDS_PER_DAY = 5;
const SESSION_CAP = 20;

const SEED_CARDS = [
  {
    english: "You're my little kitty",
    pinyin: 'Nĩ shì wõ de xião māo',
    characters: '你是我的小猫',
  },
  {
    english: 'Little princess',
    pinyin: 'xiǎo gōng zhù',
    characters: '小公主',
  },
];

// ─── Storage ──────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return null;
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function initData() {
  let data = loadData();
  if (!data) {
    data = {
      cards: SEED_CARDS.map(makeCard),
      settings: { newCardsPerDay: NEW_CARDS_PER_DAY },
      streak: { count: 0, lastReviewDate: null },
    };
    saveData(data);
  }
  // Migrate: add streak field if missing
  if (!data.streak) {
    data.streak = { count: 0, lastReviewDate: null };
    saveData(data);
  }
  return data;
}

// ─── Card factory ─────────────────────────────────────────
function makeCard(fields) {
  return {
    id: crypto.randomUUID(),
    english: fields.english || '',
    pinyin: fields.pinyin || '',
    characters: fields.characters || '',
    interval: 1,
    easeFactor: 2.5,
    repetitions: 0,
    nextReviewDate: null,
    createdAt: today(),
  };
}

// ─── Date helpers ─────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const msA = new Date(a + 'T00:00:00').getTime();
  const msB = new Date(b + 'T00:00:00').getTime();
  return Math.round((msB - msA) / 86400000);
}

// ─── SM-2 ─────────────────────────────────────────────────
function applyGrade(card, correct) {
  if (!correct) {
    card.repetitions = 0;
    card.interval = 1;
    card.easeFactor = Math.max(1.3, card.easeFactor - 0.2);
  } else {
    if (card.repetitions === 0) card.interval = 1;
    else if (card.repetitions === 1) card.interval = 6;
    else card.interval = Math.round(card.interval * card.easeFactor);
    card.repetitions += 1;
    card.easeFactor = card.easeFactor + 0.1;
  }
  card.nextReviewDate = addDays(today(), card.interval);
  return card;
}

// ─── Session builder ──────────────────────────────────────
function buildSession(data) {
  const todayStr = today();
  const due = data.cards.filter(c => c.nextReviewDate && c.nextReviewDate <= todayStr);
  const isNew = data.cards.filter(c => !c.nextReviewDate);

  const newLimit = data.settings.newCardsPerDay ?? NEW_CARDS_PER_DAY;
  const newCards = isNew.slice(0, newLimit);

  let queue = [...due, ...newCards];
  // Cap at SESSION_CAP
  if (queue.length > SESSION_CAP) queue = queue.slice(0, SESSION_CAP);

  // Shuffle
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  return { queue, dueCount: due.length, newCount: newCards.length };
}

// ─── Streak ───────────────────────────────────────────────
function updateStreak(data) {
  const todayStr = today();
  const last = data.streak.lastReviewDate;

  if (last === todayStr) return; // Already counted today

  if (last && daysBetween(last, todayStr) === 1) {
    data.streak.count += 1;
  } else if (last !== todayStr) {
    data.streak.count = 1;
  }
  data.streak.lastReviewDate = todayStr;
  saveData(data);
}

// ─── App state ────────────────────────────────────────────
let appData;
let session = { queue: [], index: 0, correct: 0, again: 0 };
let editingCardId = null;

// ─── DOM refs ─────────────────────────────────────────────
const views = {
  home: document.getElementById('view-home'),
  review: document.getElementById('view-review'),
  complete: document.getElementById('view-complete'),
  admin: document.getElementById('view-admin'),
  editor: document.getElementById('view-editor'),
};

const $ = id => document.getElementById(id);

// ─── View routing ─────────────────────────────────────────
function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

// ─── Home view ────────────────────────────────────────────
function renderHome() {
  const { queue, dueCount, newCount } = buildSession(appData);
  $('streak-count').textContent = appData.streak.count;
  $('due-count').textContent = dueCount;
  $('new-count').textContent = newCount;

  const hasWork = queue.length > 0;
  $('btn-start').disabled = !hasWork;
  $('no-cards-msg').classList.toggle('hidden', hasWork);
  showView('home');
}

// ─── Review view ─────────────────────────────────────────
function startSession() {
  const built = buildSession(appData);
  session = { queue: built.queue, index: 0, correct: 0, again: 0 };
  if (session.queue.length === 0) { renderHome(); return; }
  showView('review');
  renderCard();
}

function renderCard() {
  const card = session.queue[session.index];
  if (!card) { endSession(); return; }

  // Reset flip state
  const flashcard = $('flashcard');
  flashcard.classList.remove('flipped');

  $('card-english').textContent = card.english;
  $('card-pinyin').textContent = card.pinyin;
  $('card-characters').textContent = card.characters;

  // Progress
  const total = session.queue.length;
  const done = session.index;
  $('progress-bar').style.width = `${(done / total) * 100}%`;
  $('progress-text').textContent = `${done} / ${total}`;

  // Reset grade UI
  $('grade-buttons').classList.add('hidden');
  $('card-tap-hint').classList.remove('hidden');

  // TTS
  const ttsBtn = $('btn-tts');
  if (typeof speechSynthesis !== 'undefined') {
    ttsBtn.classList.remove('hidden');
  } else {
    ttsBtn.classList.add('hidden');
  }
}

function revealCard() {
  const flashcard = $('flashcard');
  if (flashcard.classList.contains('flipped')) return;
  flashcard.classList.add('flipped');
  $('grade-buttons').classList.remove('hidden');
  $('card-tap-hint').classList.add('hidden');
}

function gradeCard(correct) {
  const card = session.queue[session.index];
  // Find card in data and update
  const dataCard = appData.cards.find(c => c.id === card.id);
  if (dataCard) applyGrade(dataCard, correct);
  saveData(appData);

  if (correct) session.correct++;
  else session.again++;

  session.index++;
  renderCard();
}

function endSession() {
  updateStreak(appData);
  $('complete-reviewed').textContent = session.queue.length;
  $('complete-correct').textContent = session.correct;
  $('complete-again').textContent = session.again;
  showView('complete');
}

// ─── Admin view ───────────────────────────────────────────
function renderAdmin() {
  const list = $('card-list');
  list.innerHTML = '';
  if (appData.cards.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:32px 0;font-size:0.9rem;">No cards yet. Tap + to add one.</p>';
  }
  appData.cards.forEach(card => {
    const item = document.createElement('div');
    item.className = 'card-list-item';
    item.innerHTML = `
      <div class="card-list-info">
        <div class="card-list-english">${escHtml(card.english)}</div>
        <div class="card-list-pinyin">${escHtml(card.pinyin)}</div>
      </div>
      <button class="card-list-edit" data-id="${card.id}" aria-label="Edit card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </button>
    `;
    item.querySelector('.card-list-edit').addEventListener('click', () => openEditor(card.id));
    list.appendChild(item);
  });
  showView('admin');
}

// ─── Editor view ─────────────────────────────────────────
function openEditor(cardId) {
  editingCardId = cardId || null;
  $('editor-title').textContent = cardId ? 'Edit card' : 'Add card';
  $('btn-delete-card').classList.toggle('hidden', !cardId);
  $('paste-area').value = '';

  if (cardId) {
    const card = appData.cards.find(c => c.id === cardId);
    $('field-english').value = card.english;
    $('field-pinyin').value = card.pinyin;
    $('field-characters').value = card.characters;
  } else {
    $('field-english').value = '';
    $('field-pinyin').value = '';
    $('field-characters').value = '';
  }
  showView('editor');
}

function parsePaste() {
  const lines = $('paste-area').value.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length >= 1) $('field-english').value = lines[0] || '';
  if (lines.length >= 2) $('field-pinyin').value = lines[1] || '';
  if (lines.length >= 3) $('field-characters').value = lines[2] || '';
}

function saveCard() {
  const english = $('field-english').value.trim();
  const pinyin = $('field-pinyin').value.trim();
  const characters = $('field-characters').value.trim();

  if (!english && !pinyin && !characters) return;

  if (editingCardId) {
    const card = appData.cards.find(c => c.id === editingCardId);
    if (card) { card.english = english; card.pinyin = pinyin; card.characters = characters; }
  } else {
    appData.cards.push(makeCard({ english, pinyin, characters }));
  }
  saveData(appData);
  renderAdmin();
}

function deleteCard() {
  if (!editingCardId) return;
  if (!confirm('Delete this card?')) return;
  appData.cards = appData.cards.filter(c => c.id !== editingCardId);
  saveData(appData);
  renderAdmin();
}

function resetProgress() {
  if (!confirm('Reset all progress? Card content will be kept.')) return;
  if (!confirm('Are you sure? This cannot be undone.')) return;
  appData.cards.forEach(card => {
    card.interval = 1;
    card.easeFactor = 2.5;
    card.repetitions = 0;
    card.nextReviewDate = null;
  });
  appData.streak = { count: 0, lastReviewDate: null };
  saveData(appData);
  renderAdmin();
}

// ─── TTS ─────────────────────────────────────────────────
function speak() {
  const card = session.queue[session.index];
  if (!card || typeof speechSynthesis === 'undefined') return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(card.pinyin);
  utter.lang = 'zh-CN';
  speechSynthesis.speak(utter);
}

// ─── Utils ────────────────────────────────────────────────
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Event wiring ─────────────────────────────────────────
function wireEvents() {
  // Home
  $('btn-admin').addEventListener('click', renderAdmin);
  $('btn-start').addEventListener('click', startSession);

  // Review
  $('btn-back-home').addEventListener('click', renderHome);
  $('flashcard').addEventListener('click', revealCard);
  $('btn-again').addEventListener('click', () => gradeCard(false));
  $('btn-got-it').addEventListener('click', e => { e.stopPropagation(); gradeCard(true); });
  $('btn-tts').addEventListener('click', e => { e.stopPropagation(); speak(); });

  // Complete
  $('btn-done').addEventListener('click', renderHome);

  // Admin
  $('btn-back-admin').addEventListener('click', renderHome);
  $('btn-add-card').addEventListener('click', () => openEditor(null));
  $('btn-reset-progress').addEventListener('click', resetProgress);

  // Editor
  $('btn-back-editor').addEventListener('click', renderAdmin);
  $('btn-parse').addEventListener('click', parsePaste);
  $('btn-save-card').addEventListener('click', saveCard);
  $('btn-delete-card').addEventListener('click', deleteCard);
}

// ─── Boot ─────────────────────────────────────────────────
appData = initData();
wireEvents();
renderHome();

// ─── Service worker registration ──────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
