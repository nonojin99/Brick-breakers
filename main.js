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

const nickname = () => localStorage.getItem('bb_nick') || '';

// ── 초기화 ──
(async () => {
  online = await net.initNet();
  $('btn-ranked').disabled = !online;
  $('btn-board').disabled = !online;
  if (!online) $('offline-note').style.display = 'block';
  loop();
})();

// ── 메뉴 버튼 ──
$('btn-solo').onclick = () => startSolo();
$('btn-ranked').onclick = () => startRanked();
$('btn-board').onclick = () => showLeaderboard();
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
  engine.startGame(Math.floor(Math.random() * 2 ** 31));
  resetPlayState();
}

// ── 랭킹전 시작 ──
async function startRanked() {
  if (!nickname()) {
    const n = prompt('닉네임을 입력하세요 (리더보드/랭킹전 표시용)');
    if (!n) return;
    localStorage.setItem('bb_nick', n.trim().slice(0, 12));
  }
  mode = 'ranked';
  state = 'matching';
  showPanel('matching');
  opp = { round: 0, ballCount: 0, dead: false, deadRound: 0, left: false };
  myDead = false;

  match = await net.findMatch({
    onOpponentJoined: () => beginRankedGame(),
    onOpponentState: (p) => { opp.round = p.round; opp.ballCount = p.ballCount; updateOppHud(); },
    onOpponentDead: (p) => {
      opp.dead = true; opp.deadRound = p.round;
      updateOppHud();
      if (!myDead) endRanked(true); // 상대 먼저 사망 = 내 승리
    },
    onOpponentLeft: () => {
      // Presence 이탈 감지: 플레이 도중 상대가 나가면 몰수승
      if (state === 'playing' && !myDead && !opp.dead) {
        opp.left = true;
        endRanked(true, `상대 이탈 — 몰수승 (내 라운드 ${engine.round})`);
      }
    },
  });
  if (!match) { alert('매치 생성 실패 (Supabase 설정 확인)'); backToMenu(); return; }
  if (!match.isHost) beginRankedGame(); // 참가자는 즉시 시작 (호스트는 joined 수신 시)
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

canvas.addEventListener('click', () => {
  if (state !== 'playing' || flying) return;
  engine.launch(aimAngle);
  flying = true;
});

// ── 메인 루프 ──
function loop() {
  requestAnimationFrame(loop);

  if (state === 'playing' && flying) {
    for (let i = 0; i < speedMult; i++) {
      if (!engine.isTurnOver()) engine.step();
    }
    if (engine.isTurnOver()) {
      flying = false;
      engine.endTurn();
      updateHud();
      if (mode === 'ranked' && match) {
        match.send('state', { round: engine.round, ballCount: engine.ballCount });
      }
      if (engine.gameOver) onGameOver();
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
