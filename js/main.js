// main.js — 게임 루프 / 입력 / 화면 상태 / 솔로·랭킹전 흐름
import { Engine } from './engine.js';
import { Renderer } from './renderer.js';
import * as net from './net.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const engine = new Engine();
const renderer = new Renderer(canvas, engine);

// ── 상태 ──
let state = 'menu';        // menu | matching | playing | over
let mode = 'solo';         // solo | ranked
let aimAngle = 90;
let flying = false;        // 구슬 비행 중
let speedMult = 1;
let match = null;          // 랭킹전 세션
let opp = { round: 0, ballCount: 0, dead: false, deadRound: 0 };
let myDead = false;
let online = false;
const TURN_TIME = 7_000;   // 대전 모드: 7초 내 미발사 시 자동 발사 (지연 이득 축소)
let turnDeadline = 0;
// 솔로 전용 난이도 완화 (대전은 엔진 기본값 사용 — 시드 동기화 유지)
const SOLO_TUNING = {
  itemChance: 0.18,      // 아이템 확률 0.12 → 0.18
  ballPlusW: 0.65,       // 구슬+1 비중 0.5 → 0.65
  doubleHpChance: 0.10,  // 강화 벽돌 확률 0.15 → 0.10
};

const nickname = () => localStorage.getItem('bb_nick') || '';

// ── 초기화 ──
(async () => {
  online = await net.initNet();
  $('btn-ranked').disabled = !online;
  $('btn-friend').disabled = !online;
  $('btn-board').disabled = !online;
  if (!online) $('offline-note').style.display = 'block';
  loop();
})();

// ── 메뉴 버튼 ──
$('btn-solo').onclick = () => startSolo();
$('btn-ranked').onclick = () => startRanked();
$('btn-friend').onclick = () => showPanel('friend');
$('btn-friend-create').onclick = () => startFriendHost();
$('btn-friend-join').onclick = () => startFriendJoin();
$('btn-friend-back').onclick = () => backToMenu();
$('btn-board').onclick = () => showLeaderboard();
$('btn-nick').onclick = () => {
  const n = prompt('새 닉네임 (최대 12자)', nickname());
  if (n && n.trim()) {
    localStorage.setItem('bb_nick', n.trim().slice(0, 12));
    alert(`닉네임이 "${nickname()}"(으)로 변경되었습니다. 다음 기록부터 적용됩니다.`);
  }
};
$('btn-retry').onclick = () => (mode === 'solo' ? startSolo() : backToMenu());
$('btn-menu').onclick = () => backToMenu();
$('btn-cancel-match').onclick = async () => { await match?.leave(); match = null; backToMenu(); };
$('btn-speed').onclick = () => {
  speedMult = speedMult === 1 ? 3 : 1;
  $('btn-speed').textContent = `배속 x${speedMult}`;
};

function backToMenu() {
  state = 'menu';
  showPanel('menu');
}

function showPanel(name) {
  for (const p of document.querySelectorAll('.panel')) p.style.display = 'none';
  if (name) $('panel-' + name).style.display = 'flex';
  $('overlay').style.display = name ? 'flex' : 'none';
  $('hud-right').style.display = mode === 'ranked' && state === 'playing' ? 'block' : 'none';
}

// ── 솔로 시작 ──
function startSolo() {
  mode = 'solo';
  engine.startGame(Math.floor(Math.random() * 2 ** 31), SOLO_TUNING);
  resetPlayState();
}

// ── 랭킹전/친선전 공용 준비 ──
function ensureNickname() {
  if (!nickname()) {
    const n = prompt('닉네임을 입력하세요 (리더보드/랭킹전 표시용)');
    if (!n) return false;
    localStorage.setItem('bb_nick', n.trim().slice(0, 12));
  }
  return true;
}

function prepareVersus() {
  mode = 'ranked';
  state = 'matching';
  opp = { round: 0, ballCount: 0, dead: false, deadRound: 0, left: false };
  myDead = false;
}

function matchHandlers() {
  return {
    onOpponentJoined: () => beginRankedGame(),
    onOpponentState: (p) => { opp.round = p.round; opp.ballCount = p.ballCount; updateOppHud(); },
    onOpponentDead: (p) => {
      opp.dead = true; opp.deadRound = p.round;
      updateOppHud();
      if (!myDead) endRanked(true); // 상대 먼저 사망 = 내 승리
    },
    onOpponentAttack: (p) => {
      // 상대 공격 수신 → 큐 적재 (내 턴 종료 시 적용)
      engine.queueAttack(p.rows);
      updateAtkHud();
    },
    onOpponentLeft: () => {
      // Presence 이탈 감지: 플레이 도중 상대가 나가면 몰수승
      if (state === 'playing' && !myDead && !opp.dead) {
        opp.left = true;
        endRanked(true, `상대 이탈 — 몰수승 (내 라운드 ${engine.round})`);
      }
    },
  };
}

// ── 랭킹전 (자동 매칭) ──
async function startRanked() {
  if (!ensureNickname()) return;
  prepareVersus();
  $('match-code-box').style.display = 'none';
  showPanel('matching');

  match = await net.findMatch(matchHandlers());
  if (!match) { alert('매치 생성 실패 (Supabase 설정 확인)'); backToMenu(); return; }
  if (!match.isHost) beginRankedGame(); // 참가자는 즉시 시작 (호스트는 joined 수신 시)
}

// ── 친선전: 방 만들기 (코드 표시 후 대기) ──
async function startFriendHost() {
  if (!ensureNickname()) return;
  prepareVersus();
  showPanel('matching');

  match = await net.createFriendMatch(matchHandlers());
  if (!match) { alert('방 생성 실패 (Supabase 설정 확인)'); backToMenu(); return; }
  $('match-code').textContent = match.code;
  $('match-code-box').style.display = 'block';
}

// ── 친선전: 코드로 참가 ──
async function startFriendJoin() {
  const code = $('friend-code-input').value.trim();
  if (code.length !== 4) { alert('4자리 코드를 입력하세요'); return; }
  if (!ensureNickname()) return;
  prepareVersus();
  showPanel('matching');
  $('match-code-box').style.display = 'none';

  match = await net.joinFriendMatch(code, matchHandlers());
  if (!match) {
    alert('해당 코드의 대기방을 찾을 수 없습니다 (오타 또는 이미 시작됨)');
    backToMenu();
    return;
  }
  beginRankedGame();
}

function beginRankedGame() {
  engine.startGame(match.seed); // 같은 시드 = 양쪽 동일 벽돌
  resetPlayState();
  updateOppHud();
}

function resetPlayState() {
  state = 'playing';
  flying = false;
  myDead = false;
  skipping = false;
  $('btn-skip').style.display = 'none';
  turnDeadline = performance.now() + TURN_TIME;
  $('timer-box').style.display = mode === 'ranked' ? 'block' : 'none';
  // 대전: 공정성 위해 2배속 고정 (선택 불가). 솔로: 자유 토글
  if (mode === 'ranked') {
    speedMult = 2;
    $('btn-speed').style.display = 'none';
  } else {
    speedMult = 1;
    $('btn-speed').textContent = '배속 x1';
    $('btn-speed').style.display = 'block';
  }
  updateAtkHud();
  showPanel(null);
  updateHud();
}

// ── 리더보드 ──
async function showLeaderboard() {
  const rows = await net.topScores(10);
  $('board-list').innerHTML = rows.length
    ? rows.map((r, i) =>
        `<li><span class="rank">${i + 1}</span> ${escapeHtml(r.nickname || '???')}` +
        `<span class="score">R${r.round} · 구슬 ${r.balls}</span></li>`).join('')
    : '<li>아직 기록이 없습니다</li>';
  showPanel('board');
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── 입력: 마우스 조준 + 클릭 발사 ──
canvas.addEventListener('mousemove', (ev) => {
  if (state !== 'playing' || flying) return;
  const r = canvas.getBoundingClientRect();
  const mx = (ev.clientX - r.left) * (canvas.width / r.width);
  const my = (ev.clientY - r.top) * (canvas.height / r.height);
  const dx = mx - engine.launchX;
  const dy = engine.height - my; // 위쪽이 +
  let a = (Math.atan2(dy, dx) * 180) / Math.PI;
  aimAngle = Math.max(engine.cfg.minAngle, Math.min(engine.cfg.maxAngle, a));
});

let skipping = false; // 스킵: 이번 턴을 100배속으로 빨리감기 (결과 동일)
function fire() {
  engine.launch(aimAngle);
  flying = true;
  skipping = false;
  $('btn-skip').style.display = 'block';
}
$('btn-skip').onclick = () => { skipping = true; $('btn-skip').style.display = 'none'; };

canvas.addEventListener('click', () => {
  if (state !== 'playing' || flying) return;
  fire();
});

// ── 메인 루프 ──
function loop() {
  requestAnimationFrame(loop);

  if (state === 'playing' && flying) {
    const mult = skipping ? 100 : speedMult;
    for (let i = 0; i < mult; i++) {
      if (!engine.isTurnOver()) engine.step();
    }
    if (engine.isTurnOver()) {
      flying = false;
      skipping = false;
      $('btn-skip').style.display = 'none';
      // 공격 판정: 이번 턴 파괴 수 4개당 1줄 (최대 3줄)
      const destroyed = engine.events.filter((v) => v.t === 'destroy').length;
      const atkRows = Math.min(3, Math.floor(destroyed / 4));
      engine.endTurn();
      updateHud();
      updateAtkHud();
      turnDeadline = performance.now() + TURN_TIME;
      if (mode === 'ranked' && match) {
        match.send('state', { round: engine.round, ballCount: engine.ballCount });
        if (atkRows > 0 && !engine.gameOver) {
          match.send('attack', { rows: atkRows });
          flashAtkSent(atkRows);
        }
      }
      if (engine.gameOver) onGameOver();
    }
  }

  // 턴 타이머 (대전 모드 전용): 시간 초과 시 현재 조준각으로 자동 발사
  if (mode === 'ranked' && state === 'playing' && !flying) {
    const remain = Math.max(0, turnDeadline - performance.now());
    $('hud-timer').textContent = Math.ceil(remain / 1000);
    $('hud-timer').style.color = remain < 3000 ? '#ff6b6b' : '';
    if (remain <= 0) {
      fire();
    }
  }

  renderer.draw({ aimAngle, canAim: state === 'playing' && !flying });
}

// ── 게임오버 ──
async function onGameOver() {
  myDead = true;
  state = 'over';

  if (mode === 'solo') {
    $('over-title').textContent = 'GAME OVER';
    $('over-detail').textContent = `라운드 ${engine.round} · 구슬 ${engine.ballCount}개`;
    if (online) {
      const n = nickname() || prompt('리더보드 등록 닉네임') || '???';
      localStorage.setItem('bb_nick', n);
      await net.saveScore(n, engine.round, engine.ballCount);
    }
    showPanel('over');
  } else {
    match?.send('dead', { round: engine.round });
    // 먼저 죽은 쪽이 패배. 상대도 이미 죽었다면(근소차 동시) 라운드 비교
    endRanked(opp.dead && engine.round > opp.deadRound);
  }
}

async function endRanked(iWon, detailOverride = null) {
  state = 'over';
  $('over-title').textContent = iWon ? '🏆 승리!' : '패배';
  $('over-detail').textContent = detailOverride ??
    `내 라운드 ${engine.round} vs 상대 ${opp.dead ? opp.deadRound : opp.round}`;
  showPanel('over');
  if (iWon && match) await match.finish(match.myId);
  if (online) await net.saveScore(nickname() || '???', engine.round, engine.ballCount);
}

// ── HUD ──
function updateHud() {
  $('hud-round').textContent = engine.round;
  $('hud-balls').textContent = engine.ballCount;
  $('hud-mode').textContent = mode === 'solo' ? 'SOLO' : 'RANKED';
}
function updateOppHud() {
  $('opp-round').textContent = opp.dead ? `${opp.deadRound} (탈락)` : opp.round;
  $('opp-balls').textContent = opp.ballCount;
}
// 받은 공격 대기 표시 (다음 턴 종료 시 적용됨)
function updateAtkHud() {
  const n = engine.pendingAttacks;
  $('atk-in').style.display = mode === 'ranked' && n > 0 ? 'block' : 'none';
  $('atk-in').textContent = `⚠ 공격 유입 +${n}줄`;
}
// 공격 전송 알림 (2초간 표시)
let atkFlashTimer = null;
function flashAtkSent(rows) {
  $('atk-out').textContent = `⚔ 공격 전송! +${rows}줄`;
  $('atk-out').style.display = 'block';
  clearTimeout(atkFlashTimer);
  atkFlashTimer = setTimeout(() => { $('atk-out').style.display = 'none'; }, 2000);
}
