// renderer.js — 엔진 상태를 Canvas에 그리기만 함 (게임 로직 없음)

const COLORS = {
  bg: '#0b1220',
  gridLine: 'rgba(120,150,200,0.06)',
  ball: '#f5f0e8',
  aim: 'rgba(90,200,255,0.75)',
  danger: 'rgba(255,80,80,0.5)',
  launcher: '#5ac8ff',
  text: '#e8eefc',
};

const ITEM_STYLE = {
  'ball+1': { color: '#5ac8ff', label: '+1' },
  pierce:   { color: '#ffd166', label: '↟' },
  split:    { color: '#b78cff', label: 'Y' },
  bomb:     { color: '#ff6b6b', label: '✸' },
};

// HP → 색: 낮음(청록) → 높음(적색). round 기준 상대 스케일
function brickColor(hp, round) {
  const t = Math.min(1, hp / Math.max(1, round * 2));
  const hue = 190 - t * 190; // 190(cyan) → 0(red)
  return `hsl(${hue} 70% ${38 + t * 8}%)`;
}

export class Renderer {
  constructor(canvas, engine) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.e = engine;
  }

  draw({ aimAngle = null, canAim = false } = {}) {
    const { ctx, e } = this;
    const cs = e.cfg.cellSize;
    const W = this.cv.width, H = this.cv.height;

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    // 은은한 그리드
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < e.cfg.cols; c++) { ctx.moveTo(c * cs, 0); ctx.lineTo(c * cs, e.height); }
    for (let r = 1; r < e.cfg.rows; r++) { ctx.moveTo(0, r * cs); ctx.lineTo(e.width, r * cs); }
    ctx.stroke();

    // 위험선 (최하단 행 상단 = 여기 닿으면 게임오버)
    const dangerY = (e.cfg.rows - 1) * cs;
    ctx.strokeStyle = COLORS.danger;
    ctx.setLineDash([10, 8]);
    ctx.beginPath(); ctx.moveTo(0, dangerY); ctx.lineTo(e.width, dangerY); ctx.stroke();
    ctx.setLineDash([]);

    // 셀: 벽돌 + 아이템
    for (let row = 0; row < e.cfg.rows; row++) {
      for (let col = 0; col < e.cfg.cols; col++) {
        const cell = e.grid[row][col];
        if (!cell) continue;
        const x = col * cs, y = row * cs;

        if (cell.type === 'item') {
          drawItem(ctx, cell.kind, x + cs / 2, y + cs / 2, cs);
        } else {
          ctx.fillStyle = cell.type === 'attack'
            ? 'hsl(330 65% 42%)'                 // 공격 벽돌: 마젠타
            : brickColor(cell.hp, e.round);
          const pad = 3, rr = 6;
          roundRect(ctx, x + pad, y + pad, cs - pad * 2, cs - pad * 2, rr);
          ctx.fill();
          ctx.fillStyle = COLORS.text;
          ctx.font = 'bold 20px "Consolas", monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(cell.hp, x + cs / 2, y + cs / 2 + 1);
        }
      }
    }

    // 구슬
    ctx.fillStyle = COLORS.ball;
    for (const b of e.balls) {
      if (!b.active) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, e.cfg.ballRadius, 0, Math.PI * 2);
      ctx.fill();
      if (b.pierce) { // 관통 구슬은 금색 링
        ctx.strokeStyle = ITEM_STYLE.pierce.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, e.cfg.ballRadius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 발사대 + 조준선
    const lx = e.launchX, ly = e.height;
    ctx.fillStyle = COLORS.launcher;
    ctx.beginPath(); ctx.arc(lx, ly, 9, 0, Math.PI * 2); ctx.fill();
    if (canAim && aimAngle !== null) {
      const rad = (aimAngle * Math.PI) / 180;
      ctx.strokeStyle = COLORS.aim;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 10]);
      ctx.beginPath();
      ctx.moveTo(lx, ly - 4);
      ctx.lineTo(lx + Math.cos(rad) * 340, ly - Math.sin(rad) * 340);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── 아이템 아이콘 (도형 기반, 글로우 포함) ──
function drawItem(ctx, kind, cx, cy, cs) {
  const st = ITEM_STYLE[kind];
  ctx.save();
  ctx.shadowColor = st.color;
  ctx.shadowBlur = 10;
  ctx.strokeStyle = st.color;
  ctx.fillStyle = st.color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';

  // 공통 외곽 링 (획득 가능 오브젝트 표시)
  ctx.beginPath();
  ctx.arc(cx, cy, cs * 0.32, 0, Math.PI * 2);
  ctx.stroke();

  switch (kind) {
    case 'ball+1': { // 구슬 + "+1"
      ctx.beginPath();
      ctx.arc(cx - 7, cy, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 15px Consolas, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('+1', cx + 1, cy + 1);
      break;
    }
    case 'pierce': { // 위로 뚫는 화살표 (몸통 + 촉)
      ctx.beginPath();
      ctx.moveTo(cx, cy + 11);
      ctx.lineTo(cx, cy - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - 12);
      ctx.lineTo(cx - 6.5, cy - 3);
      ctx.lineTo(cx + 6.5, cy - 3);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'split': { // 한 점에서 두 갈래 + 끝에 구슬
      ctx.beginPath();
      ctx.moveTo(cx, cy + 10);
      ctx.lineTo(cx, cy + 2);
      ctx.moveTo(cx, cy + 2);
      ctx.lineTo(cx - 7, cy - 7);
      ctx.moveTo(cx, cy + 2);
      ctx.lineTo(cx + 7, cy - 7);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(cx - 8, cy - 9, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 8, cy - 9, 3.2, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'bomb': { // 코어 + 8방향 스파이크
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * 7.5, cy + Math.sin(a) * 7.5);
        ctx.lineTo(cx + Math.cos(a) * 12.5, cy + Math.sin(a) * 12.5);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}
