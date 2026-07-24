/* Atlas — a daily knowledge-training quiz.
   Vanilla JS, no build step, no network. State persists in localStorage.
   Learning mechanics: active recall, interleaving, SM-2-style spaced repetition,
   adaptive difficulty, weak-spot weighting, and a weekly review mode. */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'atlas.state.v1';
  const TOPICS = ['History', 'Geography', 'Philosophy'];
  // Recovering interval ladder (days) after a wrong answer: wrong=1, then 3,7,16,35.
  const SR_LADDER = [1, 3, 7, 16, 35];
  const FIRST_TIME_INTERVAL = 14; // correct on first ever sighting -> long interval
  const ROLLING_WINDOW = 10;
  const DAY_MS = 86400000;

  // ---------------------------------------------------------------------------
  // Date helpers (work in whole local days)
  // ---------------------------------------------------------------------------
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / DAY_MS);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const freshState = () => ({
    version: 1,
    settings: { sessionLength: 15, theme: 'dark' },
    streak: { count: 0, lastCompletedDate: null },
    lifetime: { answered: 0, correct: 0 },
    topicStats: {},          // topic -> {seen, correct}
    subtopicStats: {},       // subtopic -> {seen, correct, topic}
    questions: {},           // id -> {seen, correct, wrong, lastSeen, nextDue, srStage, everWrong, wrongDates:[]}
    recentAnswers: [],       // rolling booleans, most recent last
    accuracyHistory: [],     // [{date, accuracy, answered}] one snapshot per completed session
    weeklyReview: { lastRun: null },
    sessionsCompleted: 0,
    createdAt: todayStr(),
  });

  let state = load();
  let QUESTIONS = [];        // loaded question bank
  let BY_ID = {};

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return freshState();
      const parsed = JSON.parse(raw);
      return Object.assign(freshState(), parsed);
    } catch (e) {
      console.warn('Atlas: could not read saved state, starting fresh.', e);
      return freshState();
    }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('Atlas: could not save state.', e); }
  }

  // Per-question record, lazily created.
  function qRec(id) {
    if (!state.questions[id]) {
      state.questions[id] = {
        seen: 0, correct: 0, wrong: 0, lastSeen: null, nextDue: null,
        srStage: -1, everWrong: false, wrongDates: [],
      };
    }
    return state.questions[id];
  }

  // ---------------------------------------------------------------------------
  // Data loading — try questions.json (needs a server), fall back to questions.js
  // ---------------------------------------------------------------------------
  async function loadQuestions() {
    // Fast path: a bundled global (questions.js) if present.
    if (window.ATLAS_QUESTIONS && Array.isArray(window.ATLAS_QUESTIONS)) {
      return window.ATLAS_QUESTIONS;
    }
    // Preferred path: fetch the human-readable JSON (works over http / one npm run dev).
    try {
      const res = await fetch('questions.json', { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) { /* file:// will land here — fall through to script injection */ }

    // Fallback: inject questions.js which sets window.ATLAS_QUESTIONS.
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'questions.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('no-questions-js'));
      document.head.appendChild(s);
    });
    if (window.ATLAS_QUESTIONS) return window.ATLAS_QUESTIONS;
    throw new Error('Could not load question bank.');
  }

  // ---------------------------------------------------------------------------
  // Analytics helpers
  // ---------------------------------------------------------------------------
  const rollingAccuracy = () => {
    const a = state.recentAnswers;
    if (!a.length) return null;
    return a.reduce((s, x) => s + (x ? 1 : 0), 0) / a.length;
  };
  const lifetimeAccuracy = () =>
    state.lifetime.answered ? state.lifetime.correct / state.lifetime.answered : null;

  function subtopicAccuracy(sub) {
    const s = state.subtopicStats[sub];
    return s && s.seen ? s.correct / s.seen : null;
  }
  function averageSubtopicAccuracy() {
    const vals = Object.values(state.subtopicStats).filter(s => s.seen >= 3).map(s => s.correct / s.seen);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  function isDue(id) {
    const r = state.questions[id];
    if (!r || !r.nextDue) return true;      // never scheduled = always eligible
    return daysBetween(todayStr(), r.nextDue) <= 0;
  }

  // ---------------------------------------------------------------------------
  // Session building — weighting + interleaving
  // ---------------------------------------------------------------------------
  function difficultyBias() {
    const acc = rollingAccuracy();
    if (acc === null) return 'mixed';
    if (acc >= 0.8) return 'hard';
    if (acc < 0.5) return 'easy';
    return 'mixed';
  }

  function weightFor(q, bias, avgSub) {
    let w = 1;
    const r = state.questions[q.id];

    // Due status: strongly prefer due / unseen questions.
    if (isDue(q.id)) w *= 3; else w *= 0.35;

    // Never-seen slight boost so new material surfaces.
    if (!r || r.seen === 0) w *= 1.4;

    // Adaptive difficulty.
    if (bias === 'hard') {
      w *= q.difficulty === 'hard' ? 1.9 : q.difficulty === 'medium' ? 1.1 : 0.5;
    } else if (bias === 'easy') {
      w *= q.difficulty === 'easy' ? 1.9 : q.difficulty === 'medium' ? 1.1 : 0.5;
    }

    // Weak-spot weighting: subtopics below average accuracy get oversampled.
    if (avgSub !== null) {
      const sa = subtopicAccuracy(q.subtopic);
      if (sa !== null && sa < avgSub) w *= 1.75;
    }
    return w;
  }

  function weightedSampleWithoutReplacement(items, weights, k) {
    const pool = items.map((it, i) => ({ it, w: weights[i] }));
    const picked = [];
    while (picked.length < k && pool.length) {
      let total = pool.reduce((s, p) => s + p.w, 0);
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx++) { r -= pool[idx].w; if (r <= 0) break; }
      idx = Math.min(idx, pool.length - 1);
      picked.push(pool[idx].it);
      pool.splice(idx, 1);
    }
    return picked;
  }

  // Reorder so no two consecutive questions share a topic (interleaving).
  function interleave(list) {
    const buckets = {};
    list.forEach(q => { (buckets[q.topic] = buckets[q.topic] || []).push(q); });
    Object.values(buckets).forEach(b => b.sort(() => Math.random() - 0.5));
    const out = [];
    let last = null;
    const remaining = () => Object.values(buckets).reduce((s, b) => s + b.length, 0);
    while (remaining()) {
      // pick the largest bucket whose topic != last
      let best = null;
      for (const t of Object.keys(buckets)) {
        if (!buckets[t].length) continue;
        if (t === last && remaining() > buckets[t].length) continue; // avoid repeat if alternatives exist
        if (!best || buckets[t].length > buckets[best].length) best = t;
      }
      if (!best) best = Object.keys(buckets).find(t => buckets[t].length);
      out.push(buckets[best].pop());
      last = best;
    }
    return out;
  }

  function buildSession(length) {
    const bias = difficultyBias();
    const avgSub = averageSubtopicAccuracy();
    const candidates = QUESTIONS.slice();
    const weights = candidates.map(q => weightFor(q, bias, avgSub));
    const picked = weightedSampleWithoutReplacement(candidates, weights, Math.min(length, candidates.length));
    return interleave(picked);
  }

  function buildWeeklyReview() {
    const cutoff = addDays(todayStr(), -7);
    const wrongIds = Object.keys(state.questions).filter(id => {
      const r = state.questions[id];
      return r.wrongDates && r.wrongDates.some(d => d >= cutoff);
    });
    const items = wrongIds.map(id => BY_ID[id]).filter(Boolean);
    items.sort(() => Math.random() - 0.5);
    return interleave(items.slice(0, 10));
  }

  function weeklyReviewAvailable() {
    const cutoff = addDays(todayStr(), -7);
    const anyWrong = Object.values(state.questions).some(r => r.wrongDates && r.wrongDates.some(d => d >= cutoff));
    if (!anyWrong) return false;
    const last = state.weeklyReview.lastRun;
    return !last || daysBetween(last, todayStr()) >= 7;
  }

  // ---------------------------------------------------------------------------
  // Answer recording + spaced repetition scheduling
  // ---------------------------------------------------------------------------
  function recordAnswer(q, correct, opts = {}) {
    const r = qRec(q.id);
    const firstEver = r.seen === 0;
    r.seen += 1;
    r.lastSeen = todayStr();

    // Rolling accuracy + lifetime + topic/subtopic (skip counting for weekly review to avoid double-weighting? we count all)
    if (!opts.noStats) {
      state.recentAnswers.push(!!correct);
      if (state.recentAnswers.length > ROLLING_WINDOW) state.recentAnswers.shift();
      state.lifetime.answered += 1;
      if (correct) state.lifetime.correct += 1;

      const ts = (state.topicStats[q.topic] = state.topicStats[q.topic] || { seen: 0, correct: 0 });
      ts.seen += 1; if (correct) ts.correct += 1;
      const ss = (state.subtopicStats[q.subtopic] = state.subtopicStats[q.subtopic] || { seen: 0, correct: 0, topic: q.topic });
      ss.seen += 1; if (correct) ss.correct += 1;
    }

    // Scheduling
    let interval;
    if (correct) {
      r.correct += 1;
      if (firstEver && !r.everWrong) {
        interval = FIRST_TIME_INTERVAL;
        r.srStage = 2; // roughly aligned to the 7-day rung so next correct -> 16
      } else {
        r.srStage = Math.min((r.srStage < 0 ? 0 : r.srStage) + 1, SR_LADDER.length - 1);
        interval = SR_LADDER[r.srStage];
      }
    } else {
      r.wrong += 1;
      r.everWrong = true;
      r.srStage = 0;
      interval = SR_LADDER[0]; // 1 day
      if (!r.wrongDates.includes(todayStr())) r.wrongDates.push(todayStr());
    }
    r.nextDue = addDays(todayStr(), interval);
    return interval;
  }

  function completeSession(results) {
    // results: [{q, correct, revealedThenAnswered}]
    const today = todayStr();
    // Streak
    if (state.streak.lastCompletedDate !== today) {
      if (state.streak.lastCompletedDate && daysBetween(state.streak.lastCompletedDate, today) === 1) {
        state.streak.count += 1;
      } else {
        state.streak.count = 1;
      }
      state.streak.lastCompletedDate = today;
    }
    state.sessionsCompleted += 1;
    const answered = results.length;
    const correct = results.filter(r => r.correct).length;
    state.accuracyHistory.push({ date: today, accuracy: answered ? correct / answered : 0, answered });
    if (state.accuracyHistory.length > 400) state.accuracyHistory.shift();
    save();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const main = document.getElementById('main');
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) n.setAttribute(k, v);
    }
    kids.flat().forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  };
  const pct = x => (x === null || x === undefined) ? '—' : Math.round(x * 100) + '%';
  const esc = s => String(s);

  let current = { view: 'home' };

  function setActiveNav(view) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  }

  function render(view, data) {
    current = { view, data };
    setActiveNav(view === 'quiz' || view === 'summary' ? '' : view);
    main.innerHTML = '';
    if (view === 'home') renderHome();
    else if (view === 'stats') renderStats();
    else if (view === 'settings') renderSettings();
    else if (view === 'quiz') renderQuiz(data);
    else if (view === 'summary') renderSummary(data);
    window.scrollTo(0, 0);
  }

  // ---- Home ----
  function renderHome() {
    const life = lifetimeAccuracy();
    const factsLearned = Object.values(state.questions).filter(r => r.correct > 0).length;

    main.appendChild(el('div', { class: 'stat-strip' },
      el('div', { class: 'stat' }, el('div', { class: 'big flame' }, String(state.streak.count)), el('div', { class: 'lbl' }, 'Day streak')),
      el('div', { class: 'stat' }, el('div', { class: 'big' }, pct(life)), el('div', { class: 'lbl' }, 'Accuracy')),
      el('div', { class: 'stat' }, el('div', { class: 'big' }, String(factsLearned)), el('div', { class: 'lbl' }, 'Facts learned')),
    ));

    if (weeklyReviewAvailable()) {
      main.appendChild(el('div', { class: 'banner' },
        el('div', { class: 'txt' }, el('strong', {}, 'Weekly review is ready'),
          el('span', {}, 'A short session drawn only from what you missed this week.')),
        el('button', { class: 'btn', onclick: () => startSession('weekly') }, 'Review (~10)'),
      ));
    }

    const done = state.streak.lastCompletedDate === todayStr();
    const card = el('div', { class: 'card' });
    card.appendChild(el('h1', {}, done ? 'Another round?' : "Today's session"));
    card.appendChild(el('p', { class: 'sub' }, done
      ? "You've completed today's session — your streak is safe. Keep going if you like."
      : 'Think first, then reveal the options. Broad knowledge, one question at a time.'));

    const len = state.settings.sessionLength;
    const seg = el('div', { class: 'seg' });
    [10, 15, 25].forEach(n => {
      seg.appendChild(el('button', {
        class: n === len ? 'active' : '',
        onclick: () => { state.settings.sessionLength = n; save(); render('home'); },
      }, String(n)));
    });
    card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Session length'), seg));
    card.appendChild(el('button', { class: 'btn mt', onclick: () => startSession('daily') }, `Start ${len}-question session →`));
    main.appendChild(card);

    // Small "how it works" note
    main.appendChild(el('p', { class: 'muted-note center mt' },
      'Shortcuts: Space reveals · 1–4 answer · Enter continues'));
  }

  // ---- Quiz ----
  let session = null; // {items, index, results, mode, phase, selected}

  function startSession(mode) {
    const items = mode === 'weekly' ? buildWeeklyReview() : buildSession(state.settings.sessionLength);
    if (!items.length) { render('home'); return; }
    session = { items, index: 0, results: [], mode, phase: 'recall', selected: null };
    render('quiz');
  }

  function renderQuiz() {
    const q = session.items[session.index];
    const total = session.items.length;

    const wrap = el('div', {});
    wrap.appendChild(el('div', { class: 'quiz-head' },
      el('span', {}, `${session.mode === 'weekly' ? 'Weekly review · ' : ''}Question ${session.index + 1} of ${total}`),
      el('span', {}, `${session.results.filter(r => r.correct).length} correct`),
    ));
    wrap.appendChild(el('div', { class: 'progress' }, el('i', { style: `width:${(session.index / total) * 100}%` })));

    const card = el('div', { class: 'card' });
    const tags = el('div', { class: 'tags' },
      el('span', { class: 'tag topic' }, q.topic),
      el('span', { class: 'tag' }, q.subtopic),
      el('span', { class: `tag ${q.difficulty}` }, q.difficulty),
    );
    if (q.connect) tags.appendChild(el('span', { class: 'tag connect' }, 'connect the dots'));
    card.appendChild(tags);
    card.appendChild(el('div', { class: 'qtext' }, q.question));

    if (session.phase === 'recall') {
      card.appendChild(el('div', { class: 'recall-hint' }, 'Think of your answer first — then reveal the options.'));
      card.appendChild(el('button', { class: 'btn', onclick: revealOptions }, 'Reveal options  (Space)'));
    } else {
      card.appendChild(renderChoices(q));
      if (session.phase === 'feedback') card.appendChild(renderFeedback(q));
    }
    wrap.appendChild(card);
    main.appendChild(wrap);
  }

  function renderChoices(q) {
    const box = el('div', { class: 'choices' });
    q.choices.forEach((choice, i) => {
      const btn = el('button', { class: 'choice', onclick: () => pickAnswer(i) },
        el('span', { class: 'key' }, String(i + 1)),
        el('span', {}, choice),
      );
      if (session.phase === 'feedback') {
        btn.disabled = true;
        if (i === q.answerIndex) btn.classList.add('correct');
        else if (i === session.selected) btn.classList.add('wrong');
        else btn.classList.add('muted');
      }
      box.appendChild(btn);
    });
    return box;
  }

  function renderFeedback(q) {
    const correct = session.selected === q.answerIndex;
    const fb = el('div', { class: 'feedback' });
    fb.appendChild(el('div', { class: `verdict ${correct ? 'correct' : 'wrong'}` },
      correct ? '✓ Correct' : '✗ Not quite'));
    fb.appendChild(el('div', { class: 'fb-block' },
      el('div', { class: 'k' }, 'Why'), el('div', { class: 'v' }, q.explanation)));
    if (q.distractorNotes) fb.appendChild(el('div', { class: 'fb-block distractor' },
      el('div', { class: 'k' }, 'Watch out'), el('div', { class: 'v' }, q.distractorNotes)));
    if (q.connection) fb.appendChild(el('div', { class: 'fb-block connection' },
      el('div', { class: 'k' }, 'Connection'), el('div', { class: 'v' }, q.connection)));

    const isLast = session.index === session.items.length - 1;
    fb.appendChild(el('button', { class: 'btn mt', onclick: nextQuestion },
      isLast ? 'Finish session  (Enter)' : 'Continue  (Enter)'));
    return fb;
  }

  function revealOptions() {
    if (session.phase !== 'recall') return;
    session.phase = 'answer';
    renderCurrent();
  }
  function pickAnswer(i) {
    if (session.phase !== 'answer') return;
    session.selected = i;
    session.phase = 'feedback';
    const q = session.items[session.index];
    const correct = i === q.answerIndex;
    recordAnswer(q, correct, { noStats: false });
    session.results.push({ q, correct });
    save();
    renderCurrent();
  }
  function nextQuestion() {
    if (session.phase !== 'feedback') return;
    if (session.index < session.items.length - 1) {
      session.index += 1;
      session.phase = 'recall';
      session.selected = null;
      renderCurrent();
    } else {
      if (session.mode === 'weekly') { state.weeklyReview.lastRun = todayStr(); }
      completeSession(session.results);
      render('summary', { results: session.results, mode: session.mode });
    }
  }
  function renderCurrent() { main.innerHTML = ''; renderQuiz(); }

  // ---- Summary ----
  function renderSummary(data) {
    const results = data.results;
    const total = results.length;
    const correct = results.filter(r => r.correct).length;
    const acc = total ? correct / total : 0;

    const hero = el('div', { class: 'card score-hero' },
      el('div', { class: 'pct' }, pct(acc)),
      el('div', { class: 'frac' }, `${correct} of ${total} correct`),
    );
    main.appendChild(hero);

    // Streak line
    main.appendChild(el('div', { class: 'card' },
      el('h2', {}, 'Session complete'),
      el('p', {}, `Day streak: ${state.streak.count} · Session ${state.sessionsCompleted}`),
    ));

    // Per-topic breakdown
    const byTopic = {};
    results.forEach(r => {
      const t = (byTopic[r.q.topic] = byTopic[r.q.topic] || { seen: 0, correct: 0 });
      t.seen++; if (r.correct) t.correct++;
    });
    const bd = el('div', { class: 'card' }, el('h3', {}, 'By topic'));
    Object.entries(byTopic).forEach(([t, s]) => {
      bd.appendChild(el('div', { class: 'breakdown-row' },
        el('div', { class: 'name' }, t),
        el('div', { class: 'bar' }, el('i', { style: `width:${(s.correct / s.seen) * 100}%` })),
        el('div', { class: 'val' }, `${s.correct}/${s.seen}`),
      ));
    });
    main.appendChild(bd);

    // What you learned — up to 5 notable facts (prefer connections, then hard, then missed)
    const notable = pickNotable(results, 5);
    if (notable.length) {
      const rc = el('div', { class: 'card' }, el('h3', {}, 'What you learned today'));
      notable.forEach(r => {
        const it = el('div', { class: 'recap-item' },
          el('div', { class: 'q' }, r.q.question),
          el('div', { class: 'a' }, r.q.choices[r.q.answerIndex]),
          el('div', { class: 'e' }, r.q.explanation),
        );
        rc.appendChild(it);
      });
      main.appendChild(rc);
    }

    // Review list (what to revisit)
    const missed = results.filter(r => !r.correct);
    if (missed.length) {
      const rv = el('div', { class: 'card' }, el('h3', {}, `To review (${missed.length})`));
      const ul = el('ul', { class: 'review-list' });
      missed.forEach(r => ul.appendChild(el('li', {}, `${r.q.question} — ${r.q.choices[r.q.answerIndex]}`)));
      rv.appendChild(ul);
      rv.appendChild(el('p', { class: 'muted-note mt' }, 'These are scheduled to resurface in about a day.'));
      main.appendChild(rv);
    }

    main.appendChild(el('div', { class: 'btn-row mt' },
      el('button', { class: 'btn', onclick: () => render('home') }, 'Done'),
      el('button', { class: 'btn secondary', onclick: () => render('stats') }, 'View stats'),
    ));
  }

  function pickNotable(results, n) {
    const score = r => {
      let s = 0;
      if (r.q.connection) s += 3;
      if (r.q.connect) s += 2;
      if (r.q.difficulty === 'hard') s += 2; else if (r.q.difficulty === 'medium') s += 1;
      if (r.correct) s += 0.5; // slight preference to reinforce wins, but keep variety
      return s;
    };
    return results.slice().sort((a, b) => score(b) - score(a)).slice(0, n);
  }

  // ---- Stats / dashboard ----
  function renderStats() {
    const life = lifetimeAccuracy();
    const factsLearned = Object.values(state.questions).filter(r => r.correct > 0).length;
    const dueCount = QUESTIONS.filter(q => { const r = state.questions[q.id]; return r && r.nextDue && daysBetween(todayStr(), r.nextDue) <= 0; }).length;

    main.appendChild(el('div', { class: 'metric-grid' },
      metric(String(state.streak.count), 'Day streak'),
      metric(pct(life), 'Lifetime accuracy'),
      metric(String(state.lifetime.answered), 'Answered'),
      metric(String(factsLearned), 'Facts learned'),
      metric(String(state.sessionsCompleted), 'Sessions'),
      metric(String(dueCount), 'Due now'),
    ));

    // Accuracy trend sparkline
    const trend = el('div', { class: 'card' }, el('h3', {}, 'Accuracy trend'));
    if (state.accuracyHistory.length >= 2) {
      trend.appendChild(sparkline(state.accuracyHistory.map(h => h.accuracy)));
      const recent = state.accuracyHistory.slice(-5).map(h => pct(h.accuracy)).join('  ·  ');
      trend.appendChild(el('p', { class: 'muted-note mt' }, 'Recent sessions: ' + recent));
    } else {
      trend.appendChild(el('p', { class: 'muted-note' }, 'Complete a few sessions to see your trend.'));
    }
    main.appendChild(trend);

    // Strongest / weakest subtopics
    const subs = Object.entries(state.subtopicStats)
      .filter(([, s]) => s.seen >= 3)
      .map(([name, s]) => ({ name, topic: s.topic, acc: s.correct / s.seen, seen: s.seen }));
    subs.sort((a, b) => b.acc - a.acc);

    if (subs.length) {
      const strong = subs.slice(0, 5);
      const weak = subs.slice(-5).reverse();

      const sCard = el('div', { class: 'card' }, el('h3', {}, 'Strongest subtopics'));
      const st = el('table', { class: 'tbl' });
      strong.forEach(x => st.appendChild(el('tr', {},
        el('td', {}, el('span', { class: 'pill strong' }, pct(x.acc))),
        el('td', {}, `${x.name} · ${x.topic}`),
        el('td', {}, `${x.seen} seen`))));
      sCard.appendChild(st);
      main.appendChild(sCard);

      const wCard = el('div', { class: 'card' }, el('h3', {}, 'Weakest subtopics (oversampled)'));
      const wt = el('table', { class: 'tbl' });
      weak.forEach(x => wt.appendChild(el('tr', {},
        el('td', {}, el('span', { class: 'pill weak' }, pct(x.acc))),
        el('td', {}, `${x.name} · ${x.topic}`),
        el('td', {}, `${x.seen} seen`))));
      wCard.appendChild(wt);
      main.appendChild(wCard);
    } else {
      main.appendChild(el('div', { class: 'card' },
        el('p', { class: 'muted-note' }, 'Answer more questions to reveal your strongest and weakest subtopics.')));
    }

    // Per-topic
    const tCard = el('div', { class: 'card' }, el('h3', {}, 'By topic'));
    TOPICS.forEach(t => {
      const s = state.topicStats[t];
      const a = s && s.seen ? s.correct / s.seen : null;
      tCard.appendChild(el('div', { class: 'breakdown-row' },
        el('div', { class: 'name' }, t),
        el('div', { class: 'bar' }, el('i', { style: `width:${a === null ? 0 : a * 100}%` })),
        el('div', { class: 'val' }, s ? `${s.correct}/${s.seen}` : '—')));
    });
    main.appendChild(tCard);
  }

  function metric(big, lbl) {
    return el('div', { class: 'stat' }, el('div', { class: 'big' }, big), el('div', { class: 'lbl' }, lbl));
  }

  function sparkline(values) {
    const w = 600, h = 70, pad = 4;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const n = values.length;
    const x = i => pad + (i / (n - 1)) * (w - 2 * pad);
    const y = v => h - pad - v * (h - 2 * pad);
    let d = '';
    values.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
    const area = document.createElementNS(svg.namespaceURI, 'path');
    area.setAttribute('d', d + `L${x(n - 1)} ${h} L${x(0)} ${h} Z`);
    area.setAttribute('fill', 'rgba(110,168,254,0.14)');
    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute('d', d);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--accent)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(area); svg.appendChild(line);
    return svg;
  }

  // ---- Settings ----
  function renderSettings() {
    const card = el('div', { class: 'card' });
    card.appendChild(el('h1', {}, 'Settings'));
    card.appendChild(el('p', { class: 'sub' }, 'Everything is stored locally in your browser.'));

    // Session length
    const len = state.settings.sessionLength;
    const seg = el('div', { class: 'seg' });
    [10, 15, 25].forEach(n => seg.appendChild(el('button', {
      class: n === len ? 'active' : '',
      onclick: () => { state.settings.sessionLength = n; save(); render('settings'); },
    }, String(n))));
    card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Default session length'), seg));

    // Theme
    const themeSeg = el('div', { class: 'seg' });
    [['dark', 'Dark'], ['light', 'Light']].forEach(([v, label]) => themeSeg.appendChild(el('button', {
      class: state.settings.theme === v ? 'active' : '',
      onclick: () => setTheme(v),
    }, label)));
    card.appendChild(el('div', { class: 'field' }, el('label', {}, 'Theme'), themeSeg));
    main.appendChild(card);

    // Data management
    const data = el('div', { class: 'card' });
    data.appendChild(el('h3', {}, 'Your data'));
    data.appendChild(el('p', { class: 'muted-note' }, `Bank: ${QUESTIONS.length} questions · Progress on ${Object.keys(state.questions).length} of them.`));
    data.appendChild(el('div', { class: 'btn-row mt' },
      el('button', { class: 'btn secondary', onclick: exportProgress }, 'Export progress'),
      el('button', { class: 'btn secondary', onclick: importProgress }, 'Import progress'),
    ));
    data.appendChild(el('button', { class: 'btn danger mt', onclick: resetProgress }, 'Reset all progress'));
    main.appendChild(data);

    // About mechanics
    const about = el('div', { class: 'card' });
    about.appendChild(el('h3', {}, 'How Atlas trains you'));
    about.appendChild(el('ul', { class: 'review-list' },
      el('li', {}, 'Active recall: you attempt the answer before options appear.'),
      el('li', {}, 'Interleaving: topics alternate — never two of the same in a row.'),
      el('li', {}, 'Spaced repetition: missed questions resurface after 1–3 days, then 7, 16, 35.'),
      el('li', {}, 'Adaptive difficulty: recent accuracy shifts the mix harder or easier.'),
      el('li', {}, 'Weak-spot weighting: below-average subtopics get oversampled.'),
      el('li', {}, 'Weekly review: a short session of only what you missed this week.'),
    ));
    main.appendChild(about);
  }

  function setTheme(v) {
    state.settings.theme = v;
    document.documentElement.setAttribute('data-theme', v);
    save();
    if (current.view === 'settings') render('settings');
  }

  // ---- Data export / import / reset ----
  function exportProgress() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `atlas-progress-${todayStr()}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importProgress() {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || typeof parsed !== 'object' || !parsed.questions) throw new Error('bad');
          state = Object.assign(freshState(), parsed);
          save();
          applyTheme();
          render('stats');
          alert('Progress imported.');
        } catch (e) { alert('That file could not be imported — is it an Atlas export?'); }
      };
      reader.readAsText(file);
    });
    input.click();
  }
  function resetProgress() {
    if (!confirm('Reset ALL progress? This clears your streak, history, and scheduling. This cannot be undone.')) return;
    if (!confirm('Really reset? Consider exporting first.')) return;
    state = freshState();
    save();
    applyTheme();
    render('home');
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (current.view !== 'quiz' || !session) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' && session.phase === 'recall') { e.preventDefault(); revealOptions(); }
    else if (session.phase === 'answer' && ['1', '2', '3', '4'].includes(e.key)) {
      const i = parseInt(e.key, 10) - 1;
      const q = session.items[session.index];
      if (i < q.choices.length) { e.preventDefault(); pickAnswer(i); }
    }
    else if (e.key === 'Enter' && session.phase === 'feedback') { e.preventDefault(); nextQuestion(); }
  });

  // ---------------------------------------------------------------------------
  // Theme + nav wiring
  // ---------------------------------------------------------------------------
  function applyTheme() { document.documentElement.setAttribute('data-theme', state.settings.theme || 'dark'); }

  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => render(btn.dataset.view)));
  document.getElementById('themeToggle').addEventListener('click', () =>
    setTheme(state.settings.theme === 'dark' ? 'light' : 'dark'));
  const home = document.getElementById('navHome');
  home.addEventListener('click', () => render('home'));
  home.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') render('home'); });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  applyTheme();
  main.appendChild(el('p', { class: 'muted-note center' }, 'Loading question bank…'));

  loadQuestions().then(qs => {
    QUESTIONS = qs.filter(q => q && q.id && Array.isArray(q.choices) && q.choices.length >= 2 && typeof q.answerIndex === 'number');
    BY_ID = {};
    QUESTIONS.forEach(q => { BY_ID[q.id] = q; });
    render('home');
  }).catch(err => {
    console.error(err);
    main.innerHTML = '';
    main.appendChild(el('div', { class: 'card' },
      el('h2', {}, 'Could not load questions'),
      el('div', { class: 'error-box' },
        el('p', { html: 'Atlas needs <b>questions.json</b> (or the bundled <b>questions.js</b>) next to this page.' }),
        el('p', { html: 'If you opened <b>index.html</b> directly and see this, run a tiny local server instead:' }),
        el('p', { html: '<code>cd atlas &amp;&amp; python3 -m http.server 8000</code> then visit <code>http://localhost:8000</code>' }),
      )));
  });
})();
