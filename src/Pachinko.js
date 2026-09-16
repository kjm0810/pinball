import { useCallback, useEffect, useRef, useState } from 'react';
import './Pachinko.css';
import {
  W,
  H,
  BALL_R,
  PEG_R,
  LEFT,
  RIGHT,
  BIN_TOP,
  BIN_BOTTOM,
  BIN_EDGES,
  BIN_PRIZES,
  BIN_LABELS,
  LAUNCH_X,
  LAUNCH_Y,
  LAUNCH_LANE_TOP,
  createWorld,
  advanceWorld,
  makeBall,
  stepBall,
  interpretLanding,
} from './pachinkoSim';

const COST = 10; // 구슬 1개 발사 비용
const START_CREDIT = 10000;
const SUBSTEPS = 3;
const DT = 1 / 120;
const SUB_DT = DT / SUBSTEPS;
const MAX_BALLS = 80;

export default function Pachinko() {
  const canvasRef = useRef(null);

  const [credit, setCredit] = useState(() => {
    try {
      const v = Number(localStorage.getItem('pachinko_credit_v2'));
      return Number.isFinite(v) && v >= COST ? v : START_CREDIT;
    } catch {
      return START_CREDIT;
    }
  });
  const [stats, setStats] = useState({ dropped: 0, wins: 0, jackpots: 0, payout: 0 });
  const [log, setLog] = useState([]);
  const [celebrate, setCelebrate] = useState(null); // {kind:'win'|'jackpot', prize, label}
  const [auto, setAuto] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('auto');
    } catch {
      return false;
    }
  });

  const g = useRef({
    world: createWorld(),
    balls: [],
    pending: 0,
    nextDropAt: 0,
    binFlash: BIN_PRIZES.map(() => 0),
    burst: null, // 당첨 순간 캔버스 링 이펙트
    ended: false, // 잭팟 후 게임 종료
    credit,
    auto: false,
    raf: 0,
    last: 0,
    acc: 0,
    time: 0,
  });

  g.current.auto = auto;

  const persistCredit = useCallback((c) => {
    try {
      localStorage.setItem('pachinko_credit_v2', String(Math.round(c)));
    } catch {
      /* ignore */
    }
  }, []);

  const requestDrops = useCallback((n) => {
    const s = g.current;
    const affordable = Math.floor(s.credit / COST);
    s.pending = Math.min(s.pending + n, affordable);
  }, []);

  const resetGame = useCallback(() => {
    const s = g.current;
    s.world = createWorld();
    s.credit = START_CREDIT;
    s.balls = [];
    s.pending = 0;
    s.binFlash = BIN_PRIZES.map(() => 0);
    s.burst = null;
    s.ended = false;
    s.time = 0;
    s.nextDropAt = 0;
    setCredit(START_CREDIT);
    persistCredit(START_CREDIT);
    setStats({ dropped: 0, wins: 0, jackpots: 0, payout: 0 });
    setLog([]);
    setCelebrate(null);
    setAuto(false);
  }, [persistCredit]);

  // 구슬 안착 처리
  const settleBall = useCallback(
    (ball) => {
      const s = g.current;
      const idx = ball.binIndex;
      const res = interpretLanding(idx);

      const prize = res.multiplier * COST;
      if (prize > 0) {
        s.credit += prize;
        setCredit(s.credit);
        persistCredit(s.credit);
        s.binFlash[idx] = 1;
        s.burst = {
          x: (BIN_EDGES[idx] + BIN_EDGES[idx + 1]) / 2,
          y: BIN_BOTTOM - 24,
          t: 0,
          jackpot: res.jackpot,
        };
      }
      if (res.jackpot) {
        // 잭팟 = 게임 끝
        s.ended = true;
        s.auto = false;
        s.pending = 0;
        setAuto(false);
        setCelebrate({ prize, label: BIN_LABELS[idx] });
      }
      setStats((st) => ({
        dropped: st.dropped + 1,
        wins: st.wins + (prize > 0 ? 1 : 0),
        jackpots: st.jackpots + (res.jackpot ? 1 : 0),
        payout: st.payout + prize,
      }));
      if (prize > 0) {
        setLog((l) =>
          [
            {
              id: ball.id,
              label: BIN_LABELS[idx],
              prize,
              kind: res.jackpot ? 'jackpot' : 'win',
            },
            ...l,
          ].slice(0, 9)
        );
      }
    },
    [persistCredit]
  );

  // ---- 시뮬레이션 스텝 ----------------------------------------------------
  const tick = useCallback(() => {
    const s = g.current;
    s.time += DT;

    if (s.burst) {
      s.burst.t += DT;
      if (s.burst.t > 1 && !s.ended) s.burst = null;
    }
    if (s.ended) return; // 잭팟 후 정지

    if (s.auto && s.pending === 0 && s.credit >= COST) s.pending += 1;

    if (s.pending > 0 && s.time >= s.nextDropAt && s.balls.length < MAX_BALLS) {
      if (s.credit >= COST) {
        s.credit -= COST;
        s.balls.push(makeBall(Math.random()));
        s.pending -= 1;
        s.nextDropAt = s.time + (s.auto ? 0.22 : 0.08);
        setCredit(s.credit);
        persistCredit(s.credit);
      } else {
        s.pending = 0;
      }
    }

    for (let i = 0; i < SUBSTEPS; i++) {
      advanceWorld(s.world, SUB_DT);
      for (const b of s.balls) stepBall(b, s.world, SUB_DT);
    }

    const keep = [];
    for (const b of s.balls) {
      if (b.done) {
        if (!b.awarded) {
          b.awarded = true;
          b.restUntil = s.time + 0.5;
          settleBall(b);
        }
        if (s.time < b.restUntil) keep.push(b);
      } else {
        keep.push(b);
      }
    }
    s.balls = keep;

    for (let i = 0; i < s.binFlash.length; i++) {
      if (s.binFlash[i] > 0) s.binFlash[i] = Math.max(0, s.binFlash[i] - DT * 1.5);
    }
  }, [persistCredit, settleBall]);

  // ---- 렌더 ------------------------------------------------------------
  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const s = g.current;
    const world = s.world;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#141033');
    bg.addColorStop(1, '#080615');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 발사 레인 (왼쪽 바깥 채널 + 상단 진입 곡선)
    ctx.strokeStyle = 'rgba(120,200,255,0.4)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(LAUNCH_X - 5, LAUNCH_Y + 6);
    ctx.lineTo(LAUNCH_X - 5, LAUNCH_LANE_TOP - 4);
    ctx.quadraticCurveTo(LAUNCH_X - 5, 26, 60, 24);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(120,200,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(LAUNCH_X + 7, LAUNCH_Y);
    ctx.lineTo(LAUNCH_X + 7, LAUNCH_LANE_TOP + 6);
    ctx.stroke();
    // 발사구
    ctx.fillStyle = '#2b6cb0';
    ctx.fillRect(LAUNCH_X - 6, LAUNCH_Y + 4, 15, 16);

    // 옆벽
    ctx.strokeStyle = 'rgba(120,130,255,0.35)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(LEFT, 40);
    ctx.lineTo(LEFT, BIN_BOTTOM);
    ctx.moveTo(RIGHT, 40);
    ctx.lineTo(RIGHT, BIN_BOTTOM);
    ctx.stroke();

    // 못 — 황동색 (구슬(은색)과 확실히 구분)
    for (const p of world.pegs) {
      const pr = p.guard ? PEG_R + 1 : PEG_R;
      const pg = ctx.createRadialGradient(p.x - 1.5, p.y - 1.5, 0.5, p.x, p.y, pr);
      if (p.guard) {
        pg.addColorStop(0, '#b7c0ff');
        pg.addColorStop(1, '#6b74d8');
      } else {
        pg.addColorStop(0, '#ffe6a8');
        pg.addColorStop(1, '#c8860f');
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
      ctx.fillStyle = pg;
      ctx.fill();
    }

    // 바람개비 (마지막 것은 JACKPOT 가드 — 붉게)
    world.windmills.forEach((m, mi) => {
      const guard = mi === world.windmills.length - 1;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.angle);
      ctx.strokeStyle = guard ? '#ff4d6d' : '#7ce7c8';
      ctx.lineWidth = guard ? 8 : 7;
      ctx.lineCap = 'round';
      if (guard) {
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ff4d6d';
      }
      ctx.beginPath();
      ctx.moveTo(-m.len, 0);
      ctx.lineTo(m.len, 0);
      ctx.moveTo(0, -m.len);
      ctx.lineTo(0, m.len);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(m.x, m.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = guard ? '#c9184a' : '#2a2350';
      ctx.fill();
    });


    // 칸막이
    ctx.strokeStyle = 'rgba(150,160,255,0.5)';
    ctx.lineWidth = 3;
    for (let i = 1; i < BIN_EDGES.length - 1; i++) {
      ctx.beginPath();
      ctx.moveTo(BIN_EDGES[i], BIN_TOP);
      ctx.lineTo(BIN_EDGES[i], BIN_BOTTOM);
      ctx.stroke();
    }

    // 칸 배경 + 라벨
    ctx.textAlign = 'center';
    for (let i = 0; i < BIN_PRIZES.length; i++) {
      const x0 = BIN_EDGES[i];
      const x1 = BIN_EDGES[i + 1];
      const raw = BIN_PRIZES[i];
      const flash = s.binFlash[i];
      let base = '90,100,160';
      let label = '꽝';
      let bright = false;
      if (raw >= 50) {
        base = '255,61,129';
        label = '잭팟';
        bright = true;
      } else if (raw > 0) {
        base = '255,210,63';
        label = 'x' + raw;
        bright = true;
      }
      ctx.fillStyle = `rgba(${base},${0.16 + flash * 0.72})`;
      ctx.fillRect(x0 + 1.5, BIN_TOP, x1 - x0 - 3, BIN_BOTTOM - BIN_TOP);

      ctx.save();
      ctx.translate((x0 + x1) / 2, BIN_BOTTOM - 7);
      if (!bright || x1 - x0 < 26) ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = bright ? '#fff' : 'rgba(255,255,255,0.5)';
      ctx.font = bright ? 'bold 11px system-ui, sans-serif' : '9px system-ui, sans-serif';
      ctx.fillText(label, 0, 3);
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(150,160,255,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(LEFT, BIN_BOTTOM);
    ctx.lineTo(RIGHT, BIN_BOTTOM);
    ctx.stroke();

    // 구슬 — 푸른 은색 (황동색 못과 대비)
    for (const b of s.balls) {
      const gd = ctx.createRadialGradient(b.x - 2, b.y - 2, 0.5, b.x, b.y, BALL_R);
      gd.addColorStop(0, '#ffffff');
      gd.addColorStop(0.45, '#bfe0ff');
      gd.addColorStop(1, '#3f6fa8');
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
      ctx.fillStyle = gd;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 당첨 링 이펙트 (일반 당첨은 1회, 잭팟/게임종료는 계속)
    if (s.burst) {
      const jp = s.burst.jackpot;
      const bt = jp ? s.time * 1.6 : s.burst.t;
      const col = jp ? '255,80,200' : '255,214,90';
      const maxR = jp ? 280 : 150;
      for (let k = 0; k < 3; k++) {
        let p = bt - k * 0.14;
        if (jp) p %= 1;
        if (p <= 0 || p >= 1) continue;
        ctx.beginPath();
        ctx.arc(s.burst.x, s.burst.y, p * maxR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(1 - p) * 0.9})`;
        ctx.lineWidth = 5 * (1 - p) + 1;
        ctx.stroke();
      }
    }
  }, []);

  // ---- 루프 ----------------------------------------------------------
  useEffect(() => {
    const loop = (ts) => {
      const s = g.current;
      if (!s.last) s.last = ts;
      let frame = (ts - s.last) / 1000;
      s.last = ts;
      if (frame > 0.1) frame = 0.1;
      s.acc += frame;
      let guard = 0;
      while (s.acc >= DT && guard < 8) {
        tick();
        s.acc -= DT;
        guard++;
      }
      draw();
      s.raf = requestAnimationFrame(loop);
    };
    const s = g.current;
    s.raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(s.raf);
  }, [tick, draw]);

  const winRate =
    stats.dropped > 0 ? ((stats.wins / stats.dropped) * 100).toFixed(1) : '0.0';
  const net = stats.payout - stats.dropped * COST;
  const broke =
    credit < COST && g.current.balls.length === 0 && g.current.pending === 0;

  return (
    <div className="pk-wrap">
      <h1 className="pk-title">P A C H I N K O</h1>

      <div className="pk-hud">
        <div>
          <span>보유 크레딧</span>
          <strong className={credit < COST ? 'low' : ''}>
            {Math.round(credit).toLocaleString()}
          </strong>
        </div>
        <div>
          <span>발사</span>
          <strong>{stats.dropped.toLocaleString()}</strong>
        </div>
        <div>
          <span>당첨 / 잭팟</span>
          <strong>
            {stats.wins} <em>/ {stats.jackpots}</em>
          </strong>
        </div>
        <div>
          <span>당첨률</span>
          <strong>{winRate}%</strong>
        </div>
        <div>
          <span>손익</span>
          <strong className={net >= 0 ? 'up' : 'down'}>
            {net >= 0 ? '+' : ''}
            {net.toLocaleString()}
          </strong>
        </div>
      </div>

      <div className="pk-stage">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="pk-canvas"
          onPointerDown={() => {
            if (!celebrate) requestDrops(1);
          }}
        />

        {celebrate && (
          <div className="pk-win pk-win-jackpot">
            <span className="pk-win-eyebrow">🎉 J A C K P O T 🎉</span>
            <span className="pk-win-title">당첨!!!</span>
            <span className="pk-win-prize">+{celebrate.prize.toLocaleString()}</span>
            <span className="pk-win-sub">
              최종 크레딧 {Math.round(credit).toLocaleString()} · GAME OVER
            </span>
            <button className="pk-win-again" onClick={resetGame}>
              다시 시작
            </button>
          </div>
        )}

        {broke && !celebrate && (
          <div className="pk-overlay">
            <h2>크레딧 소진</h2>
            <button onClick={resetGame}>
              {START_CREDIT.toLocaleString()} 크레딧으로 재시작
            </button>
          </div>
        )}

        <ul className="pk-log">
          {log.map((r) => (
            <li key={r.id} className={r.kind}>
              {r.label} +{r.prize}
            </li>
          ))}
        </ul>
      </div>

      <div className="pk-controls">
        <button
          onClick={() => requestDrops(1)}
          disabled={credit < COST || !!celebrate}
        >
          발사 <small>-{COST}</small>
        </button>
        <button
          onClick={() => requestDrops(10)}
          disabled={credit < COST || !!celebrate}
        >
          10연발 <small>-{COST * 10}</small>
        </button>
        <button
          className={auto ? 'on' : ''}
          onClick={() => setAuto((a) => !a)}
          disabled={!!celebrate}
        >
          자동 {auto ? 'ON' : 'OFF'}
        </button>
        <button onClick={resetGame} className="ghost">
          리셋
        </button>
      </div>

    </div>
  );
}
