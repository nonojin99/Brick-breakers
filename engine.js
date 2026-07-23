// engine.js — 순수 게임 로직 (DOM/Canvas 무관, Node 콘솔에서 단독 실행 가능)
// 좌표계: x → 오른쪽, y → 아래 (화면 기준). 발사각 90° = 정위쪽.

// ── 시드 기반 PRNG (멀티플레이 동일 시드 재현용. Math.random 사용 금지) ──
export function createRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 설정 (PC 기준) ──
export const CONFIG = {
  cols: 11,
  rows: 12,          // 이 행을 넘어 내려오면 게임오버
  cellSize: 64,
  ballRadius: 7,
  ballSpeed: 14,     // px / step
  minAngle: 10,      // 수평 방지: 10° ~ 170°
  maxAngle: 170,
};

export class Engine {
  constructor(config = CONFIG) {
    this.cfg = config;
    this.width = config.cols * config.cellSize;   // 704
    this.height = config.rows * config.cellSize;  // 832 (바닥 = 발사선)
    this.grid = this.emptyGrid();                 // grid[row][col] = {type, hp} | null
    this.balls = [];
    this.launchX = this.width / 2;
    this.events = [];                             // step()이 쌓는 이벤트 로그
    // ── 턴 시스템 상태 ──
    this.round = 1;
    this.gameOver = false;
    this.rng = null;                              // startGame(seed)에서 주입
    this.nextLaunchX = null;                      // 첫 귀환 구슬 x = 다음 발사 위치
    this.ballCount = 1;                           // 아이템으로 성장
  }

  emptyGrid() {
    return Array.from({ length: this.cfg.rows }, () =>
      Array(this.cfg.cols).fill(null)
    );
  }

  setBrick(row, col, brick) {
    this.grid[row][col] = brick; // {type:'normal', hp:N}
  }

  // ── 발사 ──
  launch(angleDeg, count = this.ballCount) {
    const a = Math.max(this.cfg.minAngle, Math.min(this.cfg.maxAngle, angleDeg));
    const rad = (a * Math.PI) / 180;
    const vx = Math.cos(rad) * this.cfg.ballSpeed;
    const vy = -Math.sin(rad) * this.cfg.ballSpeed; // 화면 y는 아래가 +
    this.balls = [];
    for (let i = 0; i < count; i++) {
      this.balls.push({
        x: this.launchX,
        y: this.height - this.cfg.ballRadius,
        vx, vy,
        delay: i * 6,   // 구슬 간 발사 간격 (step 수)
        active: true,
        pierce: false,  // 관통 아이템 획득 시 true
        hitCd: {},      // 관통 시 벽돌별 재타격 쿨다운 (substep)
      });
    }
    this.events = [];
  }

  // ── 1 스텝 진행. 반환: 이번 스텝 이벤트 배열 ──
  step() {
    const ev = [];
    const r = this.cfg.ballRadius;
    // 속도가 셀보다 크면 관통 오류 → 서브스텝 분할
    const sub = Math.ceil(this.cfg.ballSpeed / r);

    for (const b of [...this.balls]) { // 스냅샷: 분열로 추가된 구슬은 다음 스텝부터
      if (!b.active) continue;
      if (b.delay > 0) { b.delay--; continue; }

      for (let s = 0; s < sub; s++) {
        for (const k in b.hitCd) if (--b.hitCd[k] <= 0) delete b.hitCd[k];
        b.x += b.vx / sub;
        b.y += b.vy / sub;

        // 좌우 벽
        if (b.x < r)              { b.x = r;              b.vx = Math.abs(b.vx);  ev.push({ t: 'wall', side: 'left' }); }
        else if (b.x > this.width - r) { b.x = this.width - r; b.vx = -Math.abs(b.vx); ev.push({ t: 'wall', side: 'right' }); }
        // 천장
        if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy); ev.push({ t: 'wall', side: 'top' }); }
        // 바닥 = 귀환
        if (b.y > this.height - r && b.vy > 0) {
          b.active = false;
          b.y = this.height - r;
          if (this.nextLaunchX === null) this.nextLaunchX = b.x; // 첫 귀환 = 다음 발사 위치
          ev.push({ t: 'return', x: b.x });
          break;
        }

        this.collideBricks(b, ev);
      }
    }
    this.events.push(...ev);
    return ev;
  }

  // 원 vs 셀 충돌: 벽돌은 반사+대미지, 아이템은 획득(반사 없음), 관통은 통과+대미지
  collideBricks(b, ev) {
    const cs = this.cfg.cellSize;
    const r = this.cfg.ballRadius;
    const c0 = Math.max(0, Math.floor((b.x - r) / cs));
    const c1 = Math.min(this.cfg.cols - 1, Math.floor((b.x + r) / cs));
    const r0 = Math.max(0, Math.floor((b.y - r) / cs));
    const r1 = Math.min(this.cfg.rows - 1, Math.floor((b.y + r) / cs));

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cell = this.grid[row][col];
        if (!cell) continue;

        const bx = col * cs, by = row * cs;
        const nx = Math.max(bx, Math.min(b.x, bx + cs));
        const ny = Math.max(by, Math.min(b.y, by + cs));
        const dx = b.x - nx, dy = b.y - ny;
        if (dx * dx + dy * dy > r * r) continue;

        // ── 아이템: 즉시 획득, 반사 없이 통과 ──
        if (cell.type === 'item') {
          this.grid[row][col] = null;
          this.applyItem(cell.kind, row, col, b, ev);
          ev.push({ t: 'item', kind: cell.kind, row, col });
          continue; // 같은 서브스텝에 다른 셀도 처리 가능
        }

        // ── 관통 구슬: 반사 없이 대미지 (벽돌별 쿨다운으로 다중타격 방지) ──
        if (b.pierce) {
          const key = row + ',' + col;
          if (!b.hitCd[key]) {
            b.hitCd[key] = 12; // 셀 통과 시간보다 길게
            this.damageBrick(row, col, 1, ev);
          }
          continue;
        }

        // ── 일반 반사: 침투가 얕은 축으로 ──
        const penX = r - Math.abs(dx);
        const penY = r - Math.abs(dy);
        if (penX < penY) {
          b.vx = dx >= 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
          b.x = nx + (dx >= 0 ? r : -r);
        } else {
          b.vy = dy >= 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
          b.y = ny + (dy >= 0 ? r : -r);
        }
        this.damageBrick(row, col, 1, ev);
        return; // 서브스텝당 반사 1회 (이중 타격 방지)
      }
    }
  }

  damageBrick(row, col, dmg, ev) {
    const brick = this.grid[row][col];
    if (!brick || brick.type === 'item') return;
    brick.hp -= dmg;
    ev.push({ t: 'hit', row, col, hp: brick.hp });
    if (brick.hp <= 0) {
      this.grid[row][col] = null;
      ev.push({ t: 'destroy', row, col });
    }
  }

  // ── 아이템 효과 (op 방식: 종류 추가 시 여기만 확장) ──
  applyItem(kind, row, col, ball, ev) {
    switch (kind) {
      case 'ball+1':
        this.ballCount++;
        break;
      case 'pierce':
        ball.pierce = true;
        break;
      case 'split': { // 진행 방향 ±25°로 2갈래 (원본 소멸 → 총 2개)
        const sp = Math.hypot(ball.vx, ball.vy);
        const base = Math.atan2(ball.vy, ball.vx);
        for (const off of [-25, 25]) {
          const a = base + (off * Math.PI) / 180;
          this.balls.push({
            x: ball.x, y: ball.y,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            delay: 0, active: true, pierce: ball.pierce, hitCd: {},
          });
        }
        ball.active = false;
        break;
      }
      case 'bomb': // 획득 지점 주변 3×3에 1대미지
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            const rr = row + dr, cc = col + dc;
            if (rr >= 0 && rr < this.cfg.rows && cc >= 0 && cc < this.cfg.cols)
              this.damageBrick(rr, cc, 1, ev);
          }
        break;
    }
  }

  isTurnOver() {
    return this.balls.every((b) => !b.active);
  }

  // ── 턴 시스템 ──────────────────────────────────────────────
  // 게임 시작: 시드 고정 (멀티플레이 시 양쪽에 같은 seed 전달)
  startGame(seed) {
    this.rng = createRng(seed);
    this.grid = this.emptyGrid();
    this.round = 1;
    this.gameOver = false;
    this.balls = [];
    this.ballCount = 1;
    this.launchX = this.width / 2;
    this.nextLaunchX = null;
    this.spawnRow();
  }

  // 신규 행 생성 (최상단). 벽돌/아이템/빈칸 — 전부 시드 rng 사용
  spawnRow() {
    const density = Math.min(0.6, 0.4 + this.round * 0.01);
    const ITEM_CHANCE = 0.12;
    let spawned = 0;
    for (let col = 0; col < this.cfg.cols; col++) {
      const roll = this.rng();
      if (roll < density) {
        const hp = this.rng() < 0.15 ? this.round * 2 : this.round;
        this.grid[0][col] = { type: 'normal', hp };
        spawned++;
      } else if (roll < density + ITEM_CHANCE) {
        const v = this.rng();
        const kind = v < 0.5 ? 'ball+1' : v < 0.7 ? 'pierce' : v < 0.85 ? 'split' : 'bomb';
        this.grid[0][col] = { type: 'item', kind };
      }
    }
    // 빈 행 방지: 최소 벽돌 1개 보장
    if (spawned === 0) {
      const col = Math.floor(this.rng() * this.cfg.cols);
      this.grid[0][col] = { type: 'normal', hp: this.round };
    }
  }

  // 전 벽돌 1칸 하강. "벽돌"이 최하단 도달 시 게임오버 (아이템은 소멸)
  descend() {
    const last = this.cfg.rows - 1;
    const isBrick = (c) => c !== null && c.type !== 'item';
    if (this.grid[last].some(isBrick)) {
      this.gameOver = true; // 이미 최하단에 있으면 (이론상 endTurn에서 먼저 걸림)
      return;
    }
    for (let row = last; row >= 1; row--) this.grid[row] = this.grid[row - 1];
    this.grid[0] = Array(this.cfg.cols).fill(null);
    // 최하단의 아이템은 획득 기회 상실 → 제거
    this.grid[last] = this.grid[last].map((c) => (c && c.type === 'item' ? null : c));
    if (this.grid[last].some(isBrick)) this.gameOver = true;
  }

  // 턴 종료 처리: 하강 → 게임오버 판정 → 신규 행 → 발사 위치 갱신 → round++
  endTurn() {
    if (!this.isTurnOver() || this.gameOver) return false;
    this.descend();
    if (this.gameOver) return false;
    this.round++;
    this.spawnRow();
    if (this.nextLaunchX !== null) {
      this.launchX = this.nextLaunchX;
      this.nextLaunchX = null;
    }
    return true;
  }

  // 콘솔 디버그용 그리드 출력 (아이템: B+=구슬 Pi=관통 Sp=분열 Bo=폭파)
  render() {
    const sym = { 'ball+1': 'B+', pierce: 'Pi', split: 'Sp', bomb: 'Bo' };
    return this.grid
      .map((row) =>
        row
          .map((c) => (!c ? ' .' : c.type === 'item' ? sym[c.kind] : String(c.hp).padStart(2)))
          .join(' ')
      )
      .join('\n');
  }
}
