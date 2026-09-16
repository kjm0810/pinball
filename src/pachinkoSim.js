// 파칭코(플린코) 물리 코어 — React 컴포넌트와 몬테카를로 테스트가 공유한다.
// webpack(import)과 node(require) 양쪽에서 쓰려고 CommonJS로 작성.
//
// 기믹
//  1) 잭팟 가드 바람개비: JACKPOT 칸(아주 좁음) 바로 위에서 빠르게 도는 십자 막대가
//     다가오는 공을 거의 다 옆으로 쳐낸다 → 잭팟은 극악의 확률.
//  2) 바람개비(windmill): 회전하는 십자 막대 5개. 공을 마구 튕긴다.
//     좌우 배치는 회전 방향을 반대로 두어 좌우 대칭 유지.
//
// 몬테카를로(scratchpad/mc.js, 동시 다구) 결과
//   전체 잭팟률 ≈ 0.3~0.5% · 전체 당첨률 ≈ 10% · RTP ≈ 90~110%

const W = 440;
const H = 700;
const BALL_R = 6;
const PEG_R = 4.5;
const GRAVITY = 950;
const LEFT = 16;
const RIGHT = 424;

const BIN_TOP = 560;
const BIN_BOTTOM = 686;

// 9칸, 중앙(x=220) 기준 좌우 대칭.
const BIN_EDGES = [20, 90, 116, 142, 210, 230, 298, 324, 350, 420];
const BIN_PRIZES = [0, 4, 6, 0, 50, 0, 6, 4, 0];
const BIN_LABELS = [
  '꽝', 'x4', 'x6', '꽝', 'JACKPOT', '꽝', 'x6', 'x4', '꽝',
];
const JACKPOT_MULT = 50;

// x4 / x6 칸 입구 위쪽의 가드 못 (칸보다 높이 두어 확률을 낮추되 완전히 막진 않음)
const GUARD_X = [103, 129, 311, 337];
const GUARD_Y = 524;

// 발사 연출: 공은 왼쪽 아래에서 레인을 타고 수욱 올라와 위에서 목표 x로 떨어진다.
const LAUNCH_X = 9;
const LAUNCH_Y = H - 34;
const LAUNCH_RISE_SPEED = 900; // px/s (상승 등속)
const LAUNCH_LANE_TOP = 58; // 이 높이에 닿으면 상단으로 진입

// 잭팟 가드 바람개비 위치 (JACKPOT 칸 바로 위, 렌더에도 사용)
const GATE_X = 220;
const GATE_Y = 516;

// 바람개비
const WINDMILL_LEN = 28;
const WINDMILL_OMEGA = 3.4;
const GATE_MILL_LEN = 17; // 잭팟 가드 바람개비

const RESTITUTION = 0.4;
const PEG_NUDGE = 14;

function normAngle(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function createWorld() {
  const pegs = [];
  const rows = 12;
  const top = 100;
  const gapY = 32;
  const gapX = 40;
  // 좌우 미러 쌍으로 배치해 좌우 대칭을 보장한다.
  const windmills = [
    { x: 176, y: 244, angle: 0.3, omega: -WINDMILL_OMEGA, len: WINDMILL_LEN },
    { x: 264, y: 244, angle: -0.3, omega: WINDMILL_OMEGA, len: WINDMILL_LEN },
    { x: 92, y: 372, angle: 0.6, omega: WINDMILL_OMEGA, len: WINDMILL_LEN },
    { x: 348, y: 372, angle: -0.6, omega: -WINDMILL_OMEGA, len: WINDMILL_LEN },
    // JACKPOT 칸 바로 위 — 다가오는 공을 거의 다 쳐낸다.
    // 좌우 편향이 없도록 회전 방향을 주기적으로 뒤집는다.
    {
      x: GATE_X,
      y: GATE_Y,
      angle: 0,
      omega: WINDMILL_OMEGA * 2.1,
      len: GATE_MILL_LEN,
      guard: true,
      flipEvery: 0.6,
    },
  ];
  for (let r = 0; r < rows; r++) {
    const y = top + r * gapY;
    const even = r % 2 === 0;
    const count = even ? 11 : 10;
    const ox = even ? 20 : 40;
    for (let i = 0; i < count; i++) {
      const x = ox + i * gapX;
      if (windmills.some((m) => Math.hypot(x - m.x, y - m.y) < m.len + 12)) {
        continue;
      }
      pegs.push({ x, y, guard: false });
    }
  }
  for (const gx of GUARD_X) pegs.push({ x: gx, y: GUARD_Y, guard: true });

  return {
    pegs,
    windmills,
    t: 0,
  };
}

function advanceWorld(world, dt) {
  world.t += dt;
  for (const m of world.windmills) {
    if (m.guard) {
      const dir = Math.floor(world.t / m.flipEvery) % 2 === 0 ? 1 : -1;
      m.omega = Math.abs(m.omega) * dir;
    }
    m.angle = normAngle(m.angle + m.omega * dt);
  }
}

function binIndexForX(x) {
  for (let i = 0; i < BIN_PRIZES.length; i++) {
    if (x >= BIN_EDGES[i] && x < BIN_EDGES[i + 1]) return i;
  }
  return x < BIN_EDGES[0] ? 0 : BIN_PRIZES.length - 1;
}

function makeBall(id) {
  // 발사 강도가 불특정 → 상단 진입 지점도 불특정(플레이어가 조준 불가).
  const targetX = 34 + Math.random() * (RIGHT - LEFT - 52);
  return {
    x: LAUNCH_X,
    y: LAUNCH_Y,
    vx: 0,
    vy: -LAUNCH_RISE_SPEED * (0.9 + Math.random() * 0.25),
    r: BALL_R,
    done: false,
    binIndex: -1,
    phase: 'rise', // 'rise' → 'enter' → null(정상 물리)
    targetX,
    launchT: 0,
    id: id == null ? Math.random() : id,
  };
}

// 발사 연출 단계. 정상 물리로 넘어가면 true 반환.
function stepLaunch(b, dt) {
  b.launchT += dt;
  if (b.phase === 'rise') {
    b.x = LAUNCH_X;
    b.y += b.vy * dt;
    if (b.y <= LAUNCH_LANE_TOP || b.launchT > 1.4) {
      b.phase = 'enter';
      b.vx = Math.min(Math.max((b.targetX - b.x) * 3.2, 60), 640);
      b.vy = -50;
      b.launchT = 0;
    }
    return false;
  }
  // 'enter' — 상단을 타고 목표 x로 이동
  b.vy += 380 * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  if (b.x >= b.targetX || b.launchT > 1.2) {
    b.x = b.targetX;
    b.vx = (Math.random() - 0.5) * 20;
    b.vy = Math.max(b.vy, 120);
    b.phase = null;
    return true;
  }
  return false;
}

function reflect(b, nx, ny, rest, extraNudge) {
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) {
    b.vx -= (1 + rest) * vn * nx;
    b.vy -= (1 + rest) * vn * ny;
  }
  if (extraNudge) b.vx += (Math.random() - 0.5) * extraNudge;
}

function resolvePegs(b, pegs) {
  const min = b.r + PEG_R;
  let near = null;
  let nearD = min;
  for (const p of pegs) {
    const dx = b.x - p.x;
    if (dx > min || dx < -min) continue;
    const dy = b.y - p.y;
    if (dy > min || dy < -min) continue;
    const d = Math.hypot(dx, dy);
    if (d < nearD) {
      nearD = d;
      near = p;
    }
  }
  if (!near) return;
  let nx;
  let ny;
  if (nearD < 1e-6) {
    nx = Math.random() < 0.5 ? -1 : 1;
    ny = 0;
  } else {
    nx = (b.x - near.x) / nearD;
    ny = (b.y - near.y) / nearD;
  }
  b.x = near.x + nx * min;
  b.y = near.y + ny * min;
  reflect(b, nx, ny, RESTITUTION, PEG_NUDGE);
  b.hit = true;
}

// 회전 막대(중심 c, 각속도 omega, 두께 thick)와 공의 충돌
function collideSpinningSegment(b, seg, c, omega, rest, thick) {
  const abx = seg.bx - seg.ax;
  const aby = seg.by - seg.ay;
  const len2 = abx * abx + aby * aby || 1e-9;
  let tt = ((b.x - seg.ax) * abx + (b.y - seg.ay) * aby) / len2;
  if (tt < 0) tt = 0;
  else if (tt > 1) tt = 1;
  const px = seg.ax + abx * tt;
  const py = seg.ay + aby * tt;
  let nx = b.x - px;
  let ny = b.y - py;
  let d = Math.hypot(nx, ny);
  const minD = b.r + thick;
  if (d >= minD) return false;
  if (d < 1e-6) {
    nx = 0;
    ny = -1;
    d = 1;
  }
  nx /= d;
  ny /= d;
  b.x = px + nx * minD;
  b.y = py + ny * minD;
  const surfVx = -omega * (py - c.y);
  const surfVy = omega * (px - c.x);
  b.vx -= surfVx;
  b.vy -= surfVy;
  reflect(b, nx, ny, rest, 18);
  b.vx += surfVx;
  b.vy += surfVy;
  return true;
}

function resolveWindmills(world, b) {
  for (const m of world.windmills) {
    for (let k = 0; k < 2; k++) {
      const a = m.angle + (k * Math.PI) / 2;
      const dx = Math.cos(a) * m.len;
      const dy = Math.sin(a) * m.len;
      collideSpinningSegment(
        b,
        { ax: m.x - dx, ay: m.y - dy, bx: m.x + dx, by: m.y + dy },
        m,
        m.omega,
        0.5,
        4
      );
    }
    const hd = Math.hypot(b.x - m.x, b.y - m.y);
    if (hd < b.r + 5 && hd > 1e-6) {
      const nx = (b.x - m.x) / hd;
      const ny = (b.y - m.y) / hd;
      b.x = m.x + nx * (b.r + 5);
      b.y = m.y + ny * (b.r + 5);
      reflect(b, nx, ny, 0.5, 30);
    }
  }
}

function resolveDividers(b) {
  if (b.y + b.r <= BIN_TOP) return;
  for (let i = 1; i < BIN_EDGES.length - 1; i++) {
    const wx = BIN_EDGES[i];
    if (Math.abs(b.x - wx) >= b.r) continue;
    if (b.x < wx) {
      b.x = wx - b.r;
      b.vx = -Math.abs(b.vx) * 0.25 - Math.random() * 15;
    } else {
      b.x = wx + b.r;
      b.vx = Math.abs(b.vx) * 0.25 + Math.random() * 15;
    }
  }
}

// 단일 볼 1스텝. world는 createWorld()의 반환값(advanceWorld로 시간 전진 후 호출).
function stepBall(b, world, dt) {
  if (b.done) return;

  if (b.phase) {
    stepLaunch(b, dt);
    return;
  }

  b.vy += GRAVITY * dt;
  b.vx *= 0.995;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  if (b.x < LEFT + b.r) {
    b.x = LEFT + b.r;
    b.vx = Math.abs(b.vx) * RESTITUTION;
  } else if (b.x > RIGHT - b.r) {
    b.x = RIGHT - b.r;
    b.vx = -Math.abs(b.vx) * RESTITUTION;
  }

  resolvePegs(b, world.pegs);
  resolveWindmills(world, b);
  resolveDividers(b);

  if (b.y > BIN_BOTTOM - b.r) {
    b.y = BIN_BOTTOM - b.r;
    b.vy = 0;
    b.vx *= 0.75;
    if (Math.abs(b.vx) < 5) {
      b.done = true;
      b.binIndex = binIndexForX(b.x);
    }
  }
}

// 착지 해석: { multiplier, jackpot }
function interpretLanding(binIndex) {
  const raw = BIN_PRIZES[binIndex] || 0;
  return { multiplier: Math.max(raw, 0), jackpot: raw >= JACKPOT_MULT };
}

module.exports = {
  W,
  H,
  BALL_R,
  PEG_R,
  GRAVITY,
  LEFT,
  RIGHT,
  BIN_TOP,
  BIN_BOTTOM,
  BIN_EDGES,
  BIN_PRIZES,
  BIN_LABELS,
  JACKPOT_MULT,
  GUARD_X,
  GUARD_Y,
  GATE_X,
  GATE_Y,
  GATE_MILL_LEN,
  WINDMILL_LEN,
  LAUNCH_X,
  LAUNCH_Y,
  LAUNCH_LANE_TOP,
  createWorld,
  advanceWorld,
  binIndexForX,
  makeBall,
  stepBall,
  interpretLanding,
};
