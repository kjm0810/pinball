// 파칭코(플린코) 물리 코어 — React 컴포넌트와 몬테카를로 테스트가 공유한다.
// webpack(import)과 node(require) 양쪽에서 쓰려고 CommonJS로 작성.
//
// 기믹
//  1) 잭팟 가드 바람개비: JACKPOT 칸(아주 좁음) 바로 위에서 빠르게 도는 십자 막대가
//     다가오는 공을 거의 다 옆으로 쳐낸다 → 잭팟은 극악의 확률.
//  2) 바람개비(windmill): 회전하는 십자 막대 5개. 공을 마구 튕긴다.
//     좌우 배치는 회전 방향을 반대로 두어 좌우 대칭 유지.
//
// 화면 폭 대응: 보드 폭(W)은 고정값이 아니라 createWorld(W)의 매개변수다.
// 세로(H)는 항상 700으로 고정, 원래 설계 폭(DESIGN_W=440)의 칸 배치·확률 비율을
// 그대로 유지한 채(중앙 기준으로 비례 확대) 화면이 더 넓으면 못 열도 늘려서
// "진짜로" 더 넓은 판을 만든다(원 모양이 찌그러지는 CSS 확대와 다르다).
// 폭은 [DESIGN_W, MAX_W] 범위로 clamp된다 — 너무 좁으면 튜닝해둔 확률이 깨지고,
// 너무 넓으면(초광폭 모니터) 가드 요소의 상대 크기가 작아져 확률이 흔들리기 때문.
// 화면 비율이 이 범위를 벗어나면 Pachinko.js가 나머지 공간을 레터박스로 남겨둔다.
//
// 몬테카를로(scratchpad/mc.js) 결과 — 폭 440(기준) ≈ 폭 900~1500(넓은 화면)
//   전체 잭팟률 ≈ 0.1~0.35% · 전체 당첨률 ≈ 16~23% · RTP ≈ 90~130%

const H = 700;
const BALL_R = 6;
const PEG_R = 6.5;
const GRAVITY = 950;
// 기존 게임의 1/360초 스텝에서 쓰던 감속량을 초당 감쇠율로 환산한다.
const AIR_DRAG = -Math.log(0.995) * 360;
const FLOOR_DRAG = -Math.log(0.75) * 360;
const WALL_MARGIN = 16;

const BIN_TOP = 560;
const BIN_BOTTOM = 686;

const DESIGN_W = 440; // 원래 설계 폭 (최소 보장 폭)
const MAX_W = 1500; // 최대 폭 (이 이상은 확률 드리프트가 커져서 여기서 멈춘다)

// 칸 레이아웃(가운데=JACKPOT)을 결정하는 설정값. 설정 화면에서 바꾸면 이 값들이
// 바뀌고, URL 파라미터로 저장/복원된다.
// leftTiers/rightTiers: 좌/우 당첨 등급을 각각 독립적으로 관리 — 더 이상 좌우가
// 강제로 대칭이지 않고, 한쪽에만 칸을 추가/삭제할 수 있다(완전 비대칭 보드 허용).
// 각 목록은 "바깥쪽(벽 옆) → 안쪽(JACKPOT 방향)" 순서로 저장한다.
const DEFAULT_SETTINGS = {
  costPerBall: 10, // 구슬 한 개당 비용(원) — 당첨 결과를 원 단위로 보여주는 데만 쓰인다.
  jackpotWidth: 20, // JACKPOT 칸 폭 (DESIGN_W=440 기준)
  jackpotMult: 50,
  // 꽝 칸 배수 — 기여도 타입에서만 쓰인다(아이템 추첨은 꽝이 그냥 꽝). 기본은
  // 0(진짜 꽝, 배당 없음) — 0보다 크게 설정하면 꽝도 실제로 배당이 나가는
  // "위로상" 칸이 된다. 라벨은 그대로 'x{missMult}'로 실제 배당과 맞춘다.
  missMult: 0,
  // 'contribution' = 칸에 배수(x4/x6/잭팟) 표시. 'item' = 각 당첨칸에 사용자가
  // 정한 이름(상품명 등)을 표시 — 팀 기여도 집계뿐 아니라 선물 추첨 등 다른
  // 용도로도 범용으로 쓰기 위한 설정.
  type: 'contribution',
  jackpotLabel: '', // type='item'일 때 JACKPOT 칸에 보일 이름 (비어있으면 '잭팟'으로 대체)
  leftTiers: [
    { width: 26, mult: 4, label: '' },
    { width: 26, mult: 6, label: '' },
  ],
  rightTiers: [
    { width: 26, mult: 4, label: '' },
    { width: 26, mult: 6, label: '' },
  ],
};

// 설정값으로부터 칸 배치(경계/배당/라벨), 가드 못 x좌표, JACKPOT 칸 인덱스를
// 계산한다. DESIGN_W(440) 기준 좌표를 반환하며, 실제 사용 시 layoutForWidth가
// 화면 폭에 맞게 비례 확대한다. leftTiers/rightTiers 개수가 늘거나 줄면 칸
// 개수도 같이 바뀐다 — 양쪽 개수가 달라도(비대칭) 상관없다.
function computeBinLayout(settings) {
  const margin = 20;
  const usable = DESIGN_W - margin * 2; // 400
  // 목록이 아예 없을 때만(옛 설정 등) 기본값으로 대체 — 빈 배열([])은 "그쪽엔
  // 당첨 등급 없이 꽝만" 같은 유효한 설정이라 그대로 존중한다.
  const leftTiers = Array.isArray(settings.leftTiers) ? settings.leftTiers : DEFAULT_SETTINGS.leftTiers;
  const rightTiers = Array.isArray(settings.rightTiers) ? settings.rightTiers : DEFAULT_SETTINGS.rightTiers;
  const leftN = leftTiers.length;
  const rightN = rightTiers.length;
  const leftWidthSum = leftTiers.reduce((sum, t) => sum + t.width, 0);
  const rightWidthSum = rightTiers.reduce((sum, t) => sum + t.width, 0);
  // JACKPOT 칸은 좌/우 당첨칸 개수·폭이 서로 달라도(비대칭 보드) 항상 화면
  // 정중앙에 오도록, 좌/우에 남는 폭을 정확히 절반씩(leftAvailable=rightAvailable)
  // 배정한다. 그 안에서 미스 칸 폭(missW)은 좌/우가 각자 독립적으로 계산되므로
  // 서로 달라질 수 있다 — 대칭 설정일 때만 결과적으로 같아진다.
  const sideAvailable = (usable - settings.jackpotWidth) / 2;
  // 미스 칸 개수(한쪽 기준): 바깥쪽 1개 + 안쪽(JACKPOT 옆) 1개 + 등급 사이 간격(n-1).
  const missCountLeft = 2 + Math.max(0, leftN - 1);
  const missCountRight = 2 + Math.max(0, rightN - 1);
  const missWLeft = Math.max(4, (sideAvailable - leftWidthSum) / missCountLeft);
  const missWRight = Math.max(4, (sideAvailable - rightWidthSum) / missCountRight);
  const isItem = settings.type === 'item';
  // 꽝 배수는 기여도 타입에서만 실제로 배당에 반영된다 — 아이템 추첨의 꽝은
  // 항상 순수 꽝(배당 0)이다.
  const missMult = settings.missMult ?? DEFAULT_SETTINGS.missMult;
  const missPrize = isItem ? 0 : missMult;
  const missLabel = isItem ? 'x1' : `x${missMult}`;
  const tierLabel = (t) => (isItem ? t.label || `x${t.mult}` : `x${t.mult}`);
  const jackpotLabel = isItem ? settings.jackpotLabel || '잭팟' : `x${settings.jackpotMult}`;

  const e = [margin];
  const guardXBase = [];
  const prizes = [];
  const labels = [];
  // 실제 "당첨칸"인지(win-tier 또는 JACKPOT) 여부 — 꽝 칸은 missMult로 배당이
  // 나가더라도(예: x1 환급) 구조적으로는 항상 꽝이라, 당첨 이펙트(플래시/컨페티/
  // 로그 표시)는 이 값 기준으로 켜야 한다(배당액 자체는 별개로 그대로 지급).
  const isWin = [];

  // isTier: 좌우 당첨 등급 칸이라 가드(바람개비) 기준점이 필요한지. isWinBin:
  // "구조적으로 당첨칸"인지(생략 시 isTier와 동일) — JACKPOT처럼 가드가 따로
  // 있어 isTier는 false지만 당첨칸으로는 취급해야 하는 경우에 명시적으로 넘긴다.
  const addSegment = (width, prize, label, isTier, isWinBin = isTier) => {
    const x0 = e.at(-1);
    e.push(x0 + width);
    if (isTier) guardXBase.push((x0 + e.at(-1)) / 2);
    prizes.push(prize);
    labels.push(label);
    isWin.push(isWinBin);
  };
  const addMiss = (missW) => addSegment(missW, missPrize, missLabel, false);
  // 당첨칸 목록을 순서대로 배치하되, 항목 사이사이에도 꽝 칸을 끼워 넣어 서로
  // 붙어있지 않고 간격이 생기도록 한다. missW는 좌/우가 각자 다를 수 있어 인자로 받는다.
  const addTierList = (list, missW) => {
    list.forEach((t, idx) => {
      addSegment(t.width, t.mult, tierLabel(t), true);
      if (idx < list.length - 1) addMiss(missW);
    });
  };

  addMiss(missWLeft); // 꽝 (바깥, 왼쪽)
  addTierList(leftTiers, missWLeft); // 왼쪽: 저장 순서(바깥→안쪽) 그대로 배치
  addMiss(missWLeft); // 꽝 (안쪽, 왼쪽)
  const jackpotIndex = prizes.length;
  addSegment(settings.jackpotWidth, settings.jackpotMult, jackpotLabel, false, true);
  addMiss(missWRight); // 꽝 (안쪽, 오른쪽)
  addTierList([...rightTiers].reverse(), missWRight); // 오른쪽: 저장은 바깥→안쪽이지만 배치는 안쪽→바깥이라 뒤집는다
  addMiss(missWRight); // 꽝 (바깥, 오른쪽)

  return { edges: e, prizes, labels, isWin, guardXBase, jackpotIndex };
}

const DEFAULT_BINS = computeBinLayout(DEFAULT_SETTINGS);
const BIN_PRIZES = DEFAULT_BINS.prizes;
const BIN_LABELS = DEFAULT_BINS.labels;
const JACKPOT_MULT = DEFAULT_SETTINGS.jackpotMult;

const GUARD_Y = 524;
const GATE_Y = 515; // 잭팟 가드 바람개비 높이 (아주 살짝 아래로 조정)

// 발사 연출: 공은 왼쪽 아래에서 레인을 타고 수욱 올라온 뒤, 위쪽에 도달하는
// 순간 무작위 크기·각도의 "힘"으로 한 번 튕겨 보낸다 — 특정 x로 조준/유도하지
// 않고, 그 다음부터는 전부 중력·못·바람개비 충돌 등 일반 물리에 맡긴다.
// 왼쪽 벽에 붙어 있는 절대 위치라 폭이 늘어나도 그대로 둔다.
const LAUNCH_X = 9;
const LAUNCH_Y = H - 110; // 발사구(시작 위치) — 화면에서 조금 더 위쪽에 보이도록.
const LAUNCH_RISE_SPEED = 900; // px/s (상승 등속)
// 배출(진입) 위치이자 실제 무작위 힘(push)이 적용되는 높이 — 레일 끝과 발사
// 지점을 항상 같은 곳으로 유지한다(별도 하강 연출·순간이동 없음). 이 값을
// 첫 못 줄(y=104)보다 많이 올리면 진입 속도의 수직 성분이 커져서 준-데드락
// 확률과 잭팟 확률이 눈에 띄게 올라간다(몬테카를로 스윕으로 확인) — 다만
// 준-데드락은 아래 STUCK_CHECK_DUR 안전장치가 항상 풀어주므로 "영원히
// 멈춤"은 없고, 잭팟 확률이 다소 올라가는 정도의 트레이드오프만 남는다.
const LAUNCH_LANE_TOP = 46;
// 진입 시 튕겨 보내는 힘의 범위(속도·각도) — 이 안에서 무작위로 골라 한 번만 적용한다.
// 각도를 거의 수평(0~10도)으로 좁힌 이유: 각도를 세우면(수직에 가까우면) 공이
// 첫 번째 못 줄 언저리에서 중력과 못 충돌이 팽팽히 맞서 좀처럼 아래로 못
// 내려가는 준-데드락(무한 왕복)이 생길 확률이 눈에 띄게 올라간다 — 몬테카를로
// 스윕(scratchpad)으로 확인. 얕은 각도 + 빠른 속도가 "막힘 0%에 가까움"을
// 유지하면서도 기존 튜닝값(잭팟 0.2~0.5%, 전체 당첨 3~28%)과 맞는 영역이었다.
const LAUNCH_PUSH_SPEED_MIN = 400;
const LAUNCH_PUSH_SPEED_MAX = 700;
const LAUNCH_PUSH_ANGLE_MIN = (0 * Math.PI) / 180;
const LAUNCH_PUSH_ANGLE_MAX = (10 * Math.PI) / 180;

// 바람개비 (DESIGN_W 기준 x좌표 4개 + 잭팟 가드 1개)
const BASE_WINDMILL_X = [176, 264, 92, 348];
const WINDMILL_LEN = 28;
const WINDMILL_HUB_R = 7; // 중심부 충돌 반지름
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

// 폭 W에 맞춰 중앙(W/2) 기준으로 모든 칸/못/바람개비 위치를 "비율 그대로" 다시 배치한다.
// 각 칸이 전체 폭에서 차지하는 비율(= 당첨 확률)이 폭과 무관하게 그대로 유지되도록,
// 중앙(220) 기준 오프셋에 scale(=width/DESIGN_W)을 곱한다 — 안쪽 칸만 고정폭으로 두면
// 화면이 넓어질수록 상대적으로 좁아져(=당첨 확률이 뚝 떨어져) 버리기 때문.
function layoutForWidth(W, settings) {
  const raw = Math.round(W) || DESIGN_W;
  const width = Math.min(MAX_W, Math.max(DESIGN_W, raw));
  const scale = width / DESIGN_W;
  const cx = width / 2;
  const toX = (baseX) => cx + (baseX - DESIGN_W / 2) * scale;
  const bins = computeBinLayout(settings);
  return {
    width,
    scale,
    binEdges: bins.edges.map(toX),
    binPrizes: bins.prizes,
    binLabels: bins.labels,
    binIsWin: bins.isWin,
    jackpotIndex: bins.jackpotIndex,
    guardX: bins.guardXBase.map(toX),
    windmillX: BASE_WINDMILL_X.map(toX),
    gateX: cx,
  };
}

function createWorld(W, settings) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const L = layoutForWidth(W, cfg);
  const pegs = [];
  const rows = 10;
  const top = 104;
  const gapY = 42;
  const gapX = 54;
  // 좌우 미러 쌍으로 배치해 좌우 대칭을 보장한다.
  const windmills = [
    { x: L.windmillX[0], y: 244, angle: 0.3, omega: -WINDMILL_OMEGA, len: WINDMILL_LEN, wobble: Math.random() * Math.PI * 2 },
    { x: L.windmillX[1], y: 244, angle: -0.3, omega: WINDMILL_OMEGA, len: WINDMILL_LEN, wobble: Math.random() * Math.PI * 2 },
    { x: L.windmillX[2], y: 372, angle: 0.6, omega: WINDMILL_OMEGA, len: WINDMILL_LEN, wobble: Math.random() * Math.PI * 2 },
    { x: L.windmillX[3], y: 372, angle: -0.6, omega: -WINDMILL_OMEGA, len: WINDMILL_LEN, wobble: Math.random() * Math.PI * 2 },
    // JACKPOT 칸 바로 위 — 다가오는 공을 거의 다 쳐낸다.
    // 좌우 편향이 없도록 회전 방향을 주기적으로 뒤집는다.
    {
      x: L.gateX,
      y: GATE_Y,
      angle: 0,
      omega: WINDMILL_OMEGA * 2.1,
      len: GATE_MILL_LEN * L.scale, // 잭팟 칸도 비율대로 넓어지니 가드도 같이 커져야 막는 힘이 유지됨
      guard: true,
      flipEvery: 0.6,
    },
  ];

  // 못 그리드: 폭에 맞춰 열 개수를 다시 계산(중앙 정렬, 짝수 행은 항상 홀수 열).
  const margin = 20;
  const usable = L.width - margin * 2;
  let nCols = Math.round(usable / gapX) + 1;
  if (nCols % 2 === 0) nCols -= 1;
  if (nCols < 3) nCols = 3;
  const span = (nCols - 1) * gapX;
  const start = (L.width - span) / 2;

  const left = WALL_MARGIN;
  const right = L.width - WALL_MARGIN;
  // 벽과 못 사이의 "죽음의 구간" — 공이 벽에 붙어 멈춘 위치(left+BALL_R)에서
  // 이 거리만큼 떨어진 못은 밀어내는 방향이 오히려 벽 쪽이라 무한 진동에 갇힌다.
  // 폭에 따라 못 열이 이 구간에 걸릴 수 있어 매번 검사해서 걸리면 그 못만 건너뛴다.
  const DEAD_LO = BALL_R;
  const DEAD_HI = 2 * BALL_R + PEG_R;
  const inDeadZone = (x) => {
    const dl = x - left;
    const dr = right - x;
    return (dl > DEAD_LO && dl < DEAD_HI) || (dr > DEAD_LO && dr < DEAD_HI);
  };

  for (let r = 0; r < rows; r++) {
    const y = top + r * gapY;
    const even = r % 2 === 0;
    const cols = even ? nCols : nCols - 1;
    const ox = even ? start : start + gapX / 2;
    for (let i = 0; i < cols; i++) {
      const x = ox + i * gapX;
      if (inDeadZone(x)) continue;
      if (windmills.some((m) => Math.hypot(x - m.x, y - m.y) < m.len + 12)) {
        continue;
      }
      pegs.push({ x, y, guard: false });
    }
  }
  // 가드 못은 지키는 칸도 같이 넓어지니 반지름도 비율대로 키워야 막는 힘이 유지된다.
  for (const gx of L.guardX) {
    pegs.push({ x: gx, y: GUARD_Y, guard: true, r: PEG_R * L.scale });
  }

  return {
    width: L.width,
    height: H,
    left,
    right,
    binEdges: L.binEdges,
    binPrizes: L.binPrizes,
    binLabels: L.binLabels,
    binIsWin: L.binIsWin,
    jackpotIndex: L.jackpotIndex,
    costPerBall: cfg.costPerBall,
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
      m.currentOmega = m.omega;
    } else {
      // 일정한 속도로 뺑뺑 도는 대신, 서로 다른 주파수의 사인파를 섞어 빨라졌다
      // 느려졌다(가끔 살짝 멈칫하거나 역방향으로) 불규칙하게 돌도록 만든다.
      const speedFactor =
        1 +
        0.7 * Math.sin(world.t * 0.9 + m.wobble) +
        0.35 * Math.sin(world.t * 2.3 + m.wobble * 1.7);
      m.currentOmega = m.omega * speedFactor;
    }
    m.angle = normAngle(m.angle + m.currentOmega * dt);
  }
}

function binIndexForX(world, x) {
  const edges = world.binEdges;
  const n = world.binPrizes.length;
  for (let i = 0; i < n; i++) {
    if (x >= edges[i] && x < edges[i + 1]) return i;
  }
  return x < edges[0] ? 0 : n - 1;
}

function makeBall(world, id) {
  return {
    x: LAUNCH_X,
    y: LAUNCH_Y,
    vx: 0,
    vy: -LAUNCH_RISE_SPEED * (0.9 + Math.random() * 0.25),
    r: BALL_R,
    done: false,
    binIndex: -1,
    phase: 'rise', // 'rise' → null(정상 물리) — 조준된 목표 없이 무작위 힘으로 진입.
    launchT: 0,
    stuckT: 0,
    stuckY: null,
    id: id == null ? Math.random() : id,
  };
}

// 못 사이에서 영원히 왕복하는 준-데드락 안전장치: STUCK_CHECK_DUR마다 y좌표가
// STUCK_MIN_PROGRESS 이상 움직이지 않았으면 "갇힌 것"으로 보고 무작위 힘을
// 한 번 더 얹어 균형을 깨뜨린다. 정상적으로 튕기며 내려가는 공은 이 정도
// 시간이면 항상 20px 이상 이동하므로 오작동하지 않는다(몬테카를로로 확인).
const STUCK_CHECK_DUR = 2.2;
const STUCK_MIN_PROGRESS = 20;

function kickStuckBall(b) {
  b.vx += (Math.random() - 0.5) * 320;
  b.vy += 220 + Math.random() * 220;
}

// 발사 연출 단계. 정상 물리로 넘어가면 true 반환.
function stepLaunch(b, dt) {
  b.launchT += dt;
  if (b.phase === 'rise') {
    b.x = LAUNCH_X;
    b.y += b.vy * dt;
    if (b.y <= LAUNCH_LANE_TOP || b.launchT > 1.4) {
      // 레일 끝(LAUNCH_X, 순간이동 없음)에서 무작위 크기·각도의 힘을 한 번만
      // 실어 보낸다. 이후는 다음 프레임부터 stepBall의 일반 물리(중력·못·
      // 바람개비·벽 충돌)에 맡긴다.
      const angle = LAUNCH_PUSH_ANGLE_MIN + Math.random() * (LAUNCH_PUSH_ANGLE_MAX - LAUNCH_PUSH_ANGLE_MIN);
      const speed = LAUNCH_PUSH_SPEED_MIN + Math.random() * (LAUNCH_PUSH_SPEED_MAX - LAUNCH_PUSH_SPEED_MIN);
      b.vx = Math.cos(angle) * speed;
      b.vy = -Math.sin(angle) * speed;
      b.phase = null;
      return true;
    }
    return false;
  }
  b.phase = null;
  return true;
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
  // 가드 못은 반지름(p.r)이 커질 수 있어(넓은 화면) 못마다 개별 반지름으로 비교한다.
  let near = null;
  let nearD = 0;
  let nearMin = 0;
  let bestD = Infinity;
  for (const p of pegs) {
    const min = b.r + (p.r || PEG_R);
    const dx = b.x - p.x;
    if (dx > min || dx < -min) continue;
    const dy = b.y - p.y;
    if (dy > min || dy < -min) continue;
    const d = Math.hypot(dx, dy);
    if (d < min && d < bestD) {
      bestD = d;
      near = p;
      nearD = d;
      nearMin = min;
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
  b.x = near.x + nx * nearMin;
  b.y = near.y + ny * nearMin;
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
        m.currentOmega ?? m.omega,
        0.5,
        4
      );
    }
    const hd = Math.hypot(b.x - m.x, b.y - m.y);
    if (hd < b.r + WINDMILL_HUB_R && hd > 1e-6) {
      const nx = (b.x - m.x) / hd;
      const ny = (b.y - m.y) / hd;
      b.x = m.x + nx * (b.r + WINDMILL_HUB_R);
      b.y = m.y + ny * (b.r + WINDMILL_HUB_R);
      reflect(b, nx, ny, 0.5, 30);
    }
  }
}

// 공끼리 충돌 — 발사 애니메이션 중이거나 이미 칸에 안착한 공은 제외하고,
// 낙하 중인 공끼리만 서로 밀어내고(위치 보정) 부딪힌 방향으로 속도를 주고받는다
// (질량이 같다고 가정한 단순 탄성 충돌).
function resolveBallCollisions(balls) {
  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.phase || a.done) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.phase || b.done) continue;
      const minD = a.r + b.r;
      const dx = b.x - a.x;
      if (dx > minD || dx < -minD) continue;
      const dy = b.y - a.y;
      if (dy > minD || dy < -minD) continue;
      const d = Math.hypot(dx, dy);
      if (d >= minD) continue;

      let nx;
      let ny;
      if (d < 1e-6) {
        nx = Math.random() < 0.5 ? -1 : 1;
        ny = 0;
      } else {
        nx = dx / d;
        ny = dy / d;
      }

      // 겹친 만큼 절반씩 밀어내 떨어뜨린다.
      const overlap = minD - d;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      // 서로 다가오는 중일 때만 충돌 반응(이미 멀어지는 중이면 그냥 통과).
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal < 0) {
        const rest = 0.7;
        const imp = (-(1 + rest) * velAlongNormal) / 2;
        a.vx -= imp * nx;
        a.vy -= imp * ny;
        b.vx += imp * nx;
        b.vy += imp * ny;
      }
    }
  }
}

function resolveDividers(world, b) {
  if (b.y + b.r <= BIN_TOP) return;
  const edges = world.binEdges;
  for (let i = 1; i < edges.length - 1; i++) {
    const wx = edges[i];
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
  b.vx *= Math.exp(-AIR_DRAG * dt);
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // vx가 이미 벽에서 멀어지는 방향이면 속도는 그대로 두고 위치만 clamp한다.
  // (예전엔 매 프레임 무조건 반사 처리를 해서, 벽 밖에서 안쪽으로 들어오는 중인
  // 공(발사 직후 등)의 속도가 프레임마다 반복적으로 깎여나가는 버그가 있었다.)
  if (b.x < world.left + b.r) {
    b.x = world.left + b.r;
    if (b.vx < 0) b.vx = -b.vx * RESTITUTION;
  } else if (b.x > world.right - b.r) {
    b.x = world.right - b.r;
    if (b.vx > 0) b.vx = -b.vx * RESTITUTION;
  }

  resolvePegs(b, world.pegs);
  resolveWindmills(world, b);
  resolveDividers(world, b);

  // 준-데드락 안전장치 — STUCK_CHECK_DUR 동안 y가 거의 안 움직였으면 갇힌 것.
  if (b.stuckY == null) b.stuckY = b.y;
  b.stuckT += dt;
  if (b.stuckT >= STUCK_CHECK_DUR) {
    if (Math.abs(b.y - b.stuckY) < STUCK_MIN_PROGRESS) kickStuckBall(b);
    b.stuckT = 0;
    b.stuckY = b.y;
  }

  if (b.y > BIN_BOTTOM - b.r) {
    b.y = BIN_BOTTOM - b.r;
    b.vy = 0;
    b.vx *= Math.exp(-FLOOR_DRAG * dt);
    if (Math.abs(b.vx) < 5) {
      b.done = true;
      b.binIndex = binIndexForX(world, b.x);
    }
  }
}

// 착지 해석: { multiplier, jackpot }. JACKPOT 칸 인덱스는 tiers 개수에 따라
// 달라질 수 있어 world.jackpotIndex(칸 배치 계산 시 함께 정해짐)로 판정한다.
function interpretLanding(world, binIndex) {
  const raw = world.binPrizes[binIndex] || 0;
  return {
    multiplier: Math.max(raw, 0),
    jackpot: binIndex === world.jackpotIndex,
    // 구조적으로 당첨칸인지 — 꽝 칸이 missMult로 배당(예: x1 환급)이 나가도
    // 이건 여전히 false다(당첨 이펙트는 이 값 기준으로 켠다, 배당액은 별개).
    isWin: !!world.binIsWin?.[binIndex],
  };
}

module.exports = {
  H,
  BALL_R,
  PEG_R,
  GRAVITY,
  WALL_MARGIN,
  BIN_TOP,
  BIN_BOTTOM,
  BIN_PRIZES,
  BIN_LABELS,
  JACKPOT_MULT,
  DEFAULT_SETTINGS,
  DESIGN_W,
  MAX_W,
  GUARD_Y,
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
  resolveBallCollisions,
  interpretLanding,
};
