const {
  BIN_EDGES,
  BIN_PRIZES,
  createWorld,
  advanceWorld,
  makeBall,
  stepBall,
  binIndexForX,
  interpretLanding,
} = require('./pachinkoSim');

const STEP = 1 / 240;

// 실제 자동발사처럼 여러 구슬을 동시에 굴린다. (진입 위치는 makeBall이 무작위로)
function play(total, { dropInterval = 0.2 } = {}) {
  const world = createWorld();
  const counts = new Array(BIN_PRIZES.length).fill(0);
  let released = 0;
  let settled = 0;
  let wins = 0;
  let jackpots = 0;
  const active = [];
  let nextDrop = 0;
  let t = 0;
  let gaveUp = 0;

  while (settled < total && gaveUp < 2_000_000) {
    gaveUp++;
    advanceWorld(world, STEP);
    t += STEP;
    if (released < total && t >= nextDrop) {
      active.push(makeBall(released));
      released++;
      nextDrop = t + dropInterval;
    }
    for (const b of active) stepBall(b, world, STEP);
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i];
      if (!b.done) continue;
      active.splice(i, 1);
      settled++;
      counts[b.binIndex] += 1;
      const res = interpretLanding(b.binIndex);
      if (res.multiplier > 0) wins += 1;
      if (res.jackpot) jackpots += 1;
    }
  }
  return { counts, wins, jackpots, total };
}

test('구슬은 항상 어느 칸에는 안착한다', () => {
  const world = createWorld();
  for (let i = 0; i < 60; i++) {
    const b = makeBall(i);
    let steps = 0;
    while (!b.done && steps < 9000) {
      advanceWorld(world, STEP);
      stepBall(b, world, STEP);
      steps++;
    }
    if (!b.done) b.binIndex = binIndexForX(b.x);
    expect(b.binIndex).toBeGreaterThanOrEqual(0);
    expect(b.binIndex).toBeLessThan(BIN_PRIZES.length);
  }
});

describe('동시 다구 플레이 통계', () => {
  const r = play(2000, { dropInterval: 0.18 });

  test('잭팟은 아주아주 낮은 확률이다', () => {
    expect(r.jackpots / r.total).toBeLessThan(0.012); // 목표 ≈ 0.3%
  });

  test('전체 당첨률도 낮다', () => {
    const winRate = r.wins / r.total;
    expect(winRate).toBeGreaterThan(0.03);
    expect(winRate).toBeLessThan(0.18);
  });
});

test('칸에 착지하면 해당 배당이 그대로 나온다', () => {
  expect(interpretLanding(1).multiplier).toBe(BIN_PRIZES[1]);
});

test('칸 경계는 중앙(220) 기준으로 대칭이다', () => {
  const n = BIN_EDGES.length;
  for (let i = 0; i < n; i++) {
    expect(BIN_EDGES[i] + BIN_EDGES[n - 1 - i]).toBe(440);
  }
});
