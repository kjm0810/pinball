const { createWorld, advanceWorld, makeBall, stepBall, BIN_BOTTOM } = require('./pachinkoSim');

function emptyWorld() {
  const world = createWorld();
  world.pegs = [];
  world.windmills = [];
  world.binEdges = [world.left, world.right];
  return world;
}

describe('시간 기준 수평 감속', () => {
  test.each([false, true])('스텝 간격이 달라도 같은 시간 후 속도가 같다 (바닥: %s)', (floor) => {
    const speeds = [120, 240, 360, 720].map((hz) => {
      const world = emptyWorld();
      const ball = { ...makeBall(world), phase: null, x: 220, y: floor ? BIN_BOTTOM - 6 : 200, vx: 100, vy: 0 };
      for (let i = 0; i < hz / 60; i++) stepBall(ball, world, 1 / hz);
      expect(ball.done).toBe(false);
      return ball.vx;
    });
    for (const speed of speeds) expect(speed).toBeCloseTo(speeds[0], 10);
    // 현재 게임의 1/360초 스텝 6회와 동일한 감속을 유지한다.
    expect(speeds[0]).toBeCloseTo(100 * 0.995 ** 6 * (floor ? 0.75 ** 6 : 1), 10);
  });
});

describe('바람개비 순간 각속도', () => {
  test('화면 회전과 충돌에 같은 각속도를 사용하고 가드의 반전을 반영한다', () => {
    const world = createWorld();
    world.t = 0.59;
    for (const mill of world.windmills) {
      mill.angle = 0;
      mill.wobble = 0.8;
    }
    advanceWorld(world, 0.02);
    for (const mill of world.windmills) {
      expect(mill.angle / 0.02).toBeCloseTo(mill.currentOmega, 10);
      if (mill.guard) expect(mill.currentOmega).toBeLessThan(0);
      else expect(mill.currentOmega).not.toBe(mill.omega);
    }
  });

  test.each([-2, 0, 2])('접촉면 속도로 공을 튕긴다 (각속도: %s)', (currentOmega) => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const world = emptyWorld();
      world.windmills = [{ x: 200, y: 200, angle: 0, len: 28, omega: 10, currentOmega }];
      const side = currentOmega < 0 ? -1 : 1;
      const ball = { ...makeBall(world), phase: null, x: 220, y: 200 + side * 8, vx: 0, vy: 0 };
      // 시간 전진 없이 접촉 반응만 분리해 확인한다.
      stepBall(ball, world, 0);
      expect(ball.vy).toBeCloseTo(1.5 * currentOmega * 20, 10);
    } finally {
      random.mockRestore();
    }
  });
});
