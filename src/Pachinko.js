import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './Pachinko.css';
import {
  H,
  BALL_R,
  PEG_R,
  BIN_TOP,
  BIN_BOTTOM,
  DESIGN_W,
  DEFAULT_SETTINGS,
  LAUNCH_X,
  LAUNCH_Y,
  LAUNCH_LANE_TOP,
  createWorld,
  advanceWorld,
  makeBall,
  stepBall,
  resolveBallCollisions,
  interpretLanding,
} from './pachinkoSim';

// URL 쿼리 파라미터 ↔ 설정 값 변환 — 설정을 저장하면 URL이 바뀌고,
// 그 URL로 다시 접속하면 같은 설정이 그대로 복원된다.
// tiers(당첨 등급 목록)는 개수가 자유롭게 바뀌므로 JSON으로 통째로 저장한다.
const SETTINGS_PARAM_MAP = {
  costPerBall: 'cost',
  jackpotWidth: 'jpw',
  jackpotMult: 'jp',
  missMult: 'mm',
  type: 'type',
  jackpotLabel: 'jpn',
  soundEnabled: 'snd',
  soundVolume: 'vol',
};
const SETTINGS_NUMERIC_KEYS = ['costPerBall', 'jackpotWidth', 'jackpotMult'];
// missMult는 0(진짜 꽝)도 유효한 값이라 ">0" 검사에서 제외한, 0 이상 허용 목록.
const SETTINGS_NONNEGATIVE_NUMERIC_KEYS = ['missMult'];
const SETTINGS_BOOL_KEYS = ['soundEnabled'];
// 0~1 사이 실수(음량) 전용 — 범위를 벗어나면 clamp한다.
const SETTINGS_UNIT_FLOAT_KEYS = ['soundVolume'];
const DEFAULT_SOUND_ENABLED = true;
const DEFAULT_SOUND_VOLUME = 0.6;

function parseTiersJSON(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => Number.isFinite(t.width) && Number.isFinite(t.mult))) {
      return parsed.map((t) => ({
        width: t.width,
        mult: t.mult,
        label: typeof t.label === 'string' ? t.label : '',
      }));
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readSettingsFromURL() {
  // soundEnabled/soundVolume은 pachinkoSim의 DEFAULT_SETTINGS에 없는(물리와
  // 무관한) 필드라 여기서 기본값을 직접 얹어준다.
  const cfg = { ...DEFAULT_SETTINGS, soundEnabled: DEFAULT_SOUND_ENABLED, soundVolume: DEFAULT_SOUND_VOLUME };
  try {
    const p = new URLSearchParams(window.location.search);
    for (const key of Object.keys(SETTINGS_PARAM_MAP)) {
      const raw = p.get(SETTINGS_PARAM_MAP[key]);
      if (raw == null) continue;
      if (SETTINGS_NUMERIC_KEYS.includes(key)) {
        const v = Number(raw);
        if (Number.isFinite(v) && v > 0) cfg[key] = v;
      } else if (SETTINGS_NONNEGATIVE_NUMERIC_KEYS.includes(key)) {
        const v = Number(raw);
        if (Number.isFinite(v) && v >= 0) cfg[key] = v;
      } else if (SETTINGS_BOOL_KEYS.includes(key)) {
        cfg[key] = raw === 'true';
      } else if (SETTINGS_UNIT_FLOAT_KEYS.includes(key)) {
        const v = Number(raw);
        if (Number.isFinite(v)) cfg[key] = Math.max(0, Math.min(1, v));
      } else if (key === 'type') {
        if (raw === 'contribution' || raw === 'item') cfg.type = raw;
      } else {
        cfg[key] = raw;
      }
    }
    const leftTiers = parseTiersJSON(p.get('lt'));
    if (leftTiers) cfg.leftTiers = leftTiers;
    const rightTiers = parseTiersJSON(p.get('rt'));
    if (rightTiers) cfg.rightTiers = rightTiers;
  } catch {
    /* ignore */
  }
  return cfg;
}

function settingsToSearch(cfg) {
  const p = new URLSearchParams();
  for (const key of Object.keys(SETTINGS_PARAM_MAP)) {
    p.set(SETTINGS_PARAM_MAP[key], String(cfg[key]));
  }
  p.set('lt', JSON.stringify(cfg.leftTiers));
  p.set('rt', JSON.stringify(cfg.rightTiers));
  return p.toString();
}

const SUBSTEPS = 3;
const DT = 1 / 120;
const SUB_DT = DT / SUBSTEPS;
const MAX_BALLS = 80;
const TRAIL_LEN = 7;

// 아트 에셋 (public/assets/image) — 못/범퍼/배당칸 질감에 쓰는 정적 이미지.
const ASSET_BASE = '/assets/image';
function loadImage(name) {
  const img = new Image();
  img.src = `${ASSET_BASE}/${name}`;
  return img;
}
const PEG_IMG = loadImage('6.png'); // 금색 구슬 못
const BUMPER_IMG = loadImage('4.png'); // 청록 크리스탈 범퍼
const BUMPER_GUARD_IMG = loadImage('5.png'); // 마젠타 크리스탈 범퍼 (잭팟 가드)
const BIN_PANEL_IMG = loadImage('B.png'); // 당첨칸 패널 배경(성운 이미지) — 위에 어두운 필터를 덧씌워서 쓴다.
const FRAME_IMG_URL = `${ASSET_BASE}/A.png`; // 프레임 + 배경 통짜 이미지 (CSS 배경으로 사용)
const BIN_PANEL_IMG_URL = `${ASSET_BASE}/B.png`; // 캔버스 CSS 배경(인라인 style)으로도 재사용

// 이미지를 잘라내지 않고 찌그러뜨리지도 않으면서(object-fit: cover와 동일한
// 방식) 목표 사각형을 꽉 채운다 — 세로로 긴 이미지를 가로로 넓고 얕은
// 당첨칸 패널에 맞출 때 씀.
function drawImageCover(ctx, img, dx, dy, dw, dh) {
  const ir = img.width / img.height;
  const tr = dw / dh;
  let sx;
  let sy;
  let sw;
  let sh;
  if (ir > tr) {
    sh = img.height;
    sw = sh * tr;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = sw / tr;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// 효과음 재생 — 겹쳐서(여러 공이 동시에 부딪혀도) 재생되도록 매번 새 Audio
// 인스턴스를 만든다(재생 끝나면 GC됨). 자동재생 정책으로 거절돼도 무시.
// playbackRate를 무작위로 살짝 바꿔서 재생 길이·음높이를 다르게 한다 —
// 브라우저가 기본으로 켜두는 "피치 보정"(preservesPitch)을 꺼야 실제로
// 음높이가 같이 바뀐다(안 끄면 속도만 달라지고 음색은 그대로라 거의
// 똑같이 들린다). 범위를 너무 넓히면 음높이가 확 낮아져 오싹하게 들리므로
// 미세한 변주 정도로만 좁게 잡는다.
// 모든 효과음의 기준 음량을 하나로 통일해서 파일마다 소리 크기가 들쭉날쭉하지
// 않게 한다 — 실제 사용자 음량(soundEnabled/soundVolume, 설정 패널)은 매
// 호출마다 곱해서 적용한다.
const SFX_BASE_VOLUME = 0.5;
function playSfx(url, { rateMin = 0.92, rateMax = 1.12, enabled = true, volumeMul = 1 } = {}) {
  if (!enabled || volumeMul <= 0) return;
  try {
    const a = new Audio(url);
    a.volume = Math.max(0, Math.min(1, SFX_BASE_VOLUME * volumeMul));
    a.preservesPitch = false;
    a.mozPreservesPitch = false;
    a.webkitPreservesPitch = false;
    a.playbackRate = rateMin + Math.random() * (rateMax - rateMin);
    a.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

const PEG_HIT_SOUND_URL = '/assets/sound/ting.mp3';
function playPegHitSound(enabled, volumeMul) {
  playSfx(PEG_HIT_SOUND_URL, { enabled, volumeMul });
}

const LAUNCH_SOUND_URL = '/assets/sound/swoosh.mp3';
function playLaunchSound(enabled, volumeMul) {
  // 무작위 변주 없이 항상 2배속으로 고정 재생. 다른 효과음보다 더 자주(2발에
  // 1번) 겹쳐 울리는 편이라 기준 음량 대비 살짝 낮춘다.
  playSfx(LAUNCH_SOUND_URL, { rateMin: 2, rateMax: 2, enabled, volumeMul: volumeMul * 0.55 });
}

const WIN_SOUND_URL = '/assets/sound/win_01.mp3'; // 일반 당첨
const JACKPOT_SOUND_URL = '/assets/sound/win_02.mp3'; // 잭팟
function playWinSound(enabled, volumeMul) {
  // 음악적인 스팅어라 피치를 흔들면 안 어울려서 원래 속도 그대로 재생.
  playSfx(WIN_SOUND_URL, { rateMin: 1, rateMax: 1, enabled, volumeMul });
}
function playJackpotSound(enabled, volumeMul) {
  playSfx(JACKPOT_SOUND_URL, { rateMin: 1, rateMax: 1, enabled, volumeMul });
}

// 캔버스(게임판, DESIGN_W x H) 둘레에 프레임 아트가 들어갈 여백.
// PAD_X를 늘리면 캔버스 자체(물리 해상도 DESIGN_W는 그대로)는 좌우로 더
// 좁아지고, 그만큼 양옆에 프레임 여백이 더 넓게 보인다 — fit은 프레임
// 전체(FRAME_W)에 맞춰 균일하게 스케일되므로 원이 찌그러지는 왜곡은 없다.
// 프레임 이미지(A.png)는 .pk-frame-art에서 background-size: cover로 그려서
// 이 비율이 A.png 원본 비율(994x1582)과 달라져도 늘어나거나 찌그러지지 않는다.
const PAD_X = 68;
const PAD_TOP = 53;
const PAD_BOTTOM = 58;
const FRAME_W = DESIGN_W + PAD_X * 2;
const FRAME_H = H + PAD_TOP + PAD_BOTTOM;

function makeEmbers(width) {
  const n = Math.round((width / DESIGN_W) * 16);
  const embers = [];
  for (let i = 0; i < n; i++) {
    embers.push({
      x: Math.random() * width,
      y: H + Math.random() * 120,
      speed: 18 + Math.random() * 28,
      drift: (Math.random() - 0.5) * 10,
      r: 1 + Math.random() * 2.2,
      hue: Math.random() < 0.5 ? 320 : 45,
    });
  }
  return embers;
}

function spawnConfetti(list, cx, cy) {
  for (let i = 0; i < 46; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 130 + Math.random() * 300;
    list.push({
      x: cx,
      y: cy,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 120,
      life: 0,
      max: 1.1 + Math.random() * 0.7,
      hue: Math.random() * 360,
      size: 2 + Math.random() * 3.2,
    });
  }
}

export default function Pachinko() {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const costRef = useRef(null);
  const jpwRef = useRef(null);
  const jpRef = useRef(null);
  const missMultRef = useRef(null);
  const jackpotLabelRef = useRef(null);
  const donorNameRef = useRef(null);
  const donorAmountRef = useRef(null);
  const donorChatRef = useRef(null);
  const donationIdRef = useRef(0);
  // 캔버스(게임판)는 항상 DESIGN_W x H 고정 해상도.
  const [dims] = useState({ w: DESIGN_W, h: H });
  // 화면에 실제로 입힐 배율(fit) — 프레임(캔버스+테두리 여백) 전체가 화면에
  // 맞도록 균일하게 확대/축소만 한다(레터박스).
  const [fit, setFit] = useState(1);

  // 잭팟 순간 화면을 화려하게 만드는 연출용 플래그(배너 없이 배경 플래시만).
  const [jackpotFlash, setJackpotFlash] = useState(false);
  // 시작/정지 — 정지 상태에서도 후원은 그대로 접수되어 대기열에 쌓이지만,
  // 실제 구슬 발사(tick()의 스폰 단계)만 멈춘다. 시작을 다시 누르면 쌓여있던
  // 순서대로 이어서 발사된다. 스트리머가 잠깐 멈춰두고 싶을 때 사용.
  const [running, setRunning] = useState(true);
  const [auto] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).has('auto');
    } catch {
      return false;
    }
  });
  // 당첨칸 크기/배당, 구슬당 비용 설정 — URL 쿼리 파라미터로 저장/복원된다.
  const [settings, setSettings] = useState(() => readSettingsFromURL());
  // 설정 패널 안에서 편집 중인 임시 값들 — 패널을 열 때마다 현재 settings로
  // 초기화된다. 좌/우 당첨칸은 독립적으로 추가/삭제할 수 있어 별도 state로 관리.
  const [draftType, setDraftType] = useState(settings.type);
  const [draftLeftTiers, setDraftLeftTiers] = useState(settings.leftTiers);
  const [draftRightTiers, setDraftRightTiers] = useState(settings.rightTiers);
  const [draftSoundEnabled, setDraftSoundEnabled] = useState(settings.soundEnabled);
  const [draftSoundVolume, setDraftSoundVolume] = useState(settings.soundVolume);

  const updateTier = useCallback((side, i, key, value) => {
    const setter = side === 'left' ? setDraftLeftTiers : setDraftRightTiers;
    setter((list) => list.map((t, idx) => (idx === i ? { ...t, [key]: value } : t)));
  }, []);
  const removeTier = useCallback((side, i) => {
    const setter = side === 'left' ? setDraftLeftTiers : setDraftRightTiers;
    setter((list) => list.filter((_, idx) => idx !== i));
  }, []);
  // "+" 누를 때마다 한쪽에 칸을 1개만 추가한다 — 개수가 더 적은 쪽에 추가해서
  // 자연스럽게 좌우를 번갈아 채우되(같으면 왼쪽 먼저), 완전 비대칭도 허용한다.
  const addTier = useCallback(() => {
    if (draftLeftTiers.length <= draftRightTiers.length) {
      setDraftLeftTiers((list) => [...list, { width: 20, mult: 2, label: '' }]);
    } else {
      setDraftRightTiers((list) => [...list, { width: 20, mult: 2, label: '' }]);
    }
  }, [draftLeftTiers.length, draftRightTiers.length]);
  // log 항목 종류: {kind:'ball', id,label,multiplier,payout} (일반 발사 당첨)
  // {kind:'donation-contribution', id,nickname,chat,payout,count} (기여도 후원 집계)
  // {kind:'donation-item', id,nickname,chat,itemCounts,missCount,count} (아이템 추첨 후원 집계)
  const [log, setLog] = useState([]);
  // 아직 안 끝난 후원 건들의 실시간 상태 — [{id,nickname,chat,total,spawned,settled}]
  const [donationStatus, setDonationStatus] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDonation, setShowDonation] = useState(false);

  const initialWorld = createWorld(DESIGN_W, settings);
  const g = useRef({
    world: initialWorld,
    balls: [],
    spawnQueue: [], // 발사 대기열 — 각 항목 {donationId: null|number}
    donations: new Map(), // 진행 중인 후원 집계: id -> {nickname, chat, remaining, ...}
    nextDropAt: 0,
    binFlash: new Array(initialWorld.binPrizes.length).fill(0),
    burst: null, // 당첨 순간 캔버스 링 이펙트
    confetti: [],
    embers: makeEmbers(DESIGN_W),
    auto: false,
    running: true,
    lastPegSoundT: -1,
    settings,
    raf: 0,
    last: 0,
    acc: 0,
    time: 0,
  });

  g.current.auto = auto;
  g.current.running = running;
  g.current.settings = settings;

  // s.donations(진행 중인 후원 집계)의 현재 스냅샷을 React state로 반영해서
  // "당첨 결과" 패널에 대기중/진행중 목록이 실시간으로 보이게 한다.
  const syncDonationStatus = useCallback(() => {
    const s = g.current;
    const list = [];
    for (const [id, d] of s.donations) {
      list.push({
        id,
        nickname: d.nickname,
        chat: d.chat,
        total: d.total,
        spawned: d.spawned,
        settled: d.total - d.remaining,
      });
    }
    setDonationStatus(list);
  }, []);

  // 후원 한 건을 큐에 올린다 — 구슬이 전부 안착할 때까지의 결과를 한 건으로
  // 모아서 "당첨 결과"에 표시한다. 정지 상태여도 후원 자체(집계 레코드 +
  // spawnQueue)는 그대로 쌓인다 — 실제로 큐를 비워서 구슬을 발사하는 건
  // tick()의 스폰 단계이고, 거기서 running을 체크하므로 정지 중엔 대기만
  // 하다가 시작을 누르면 쌓여있던 순서대로 이어서 발사된다.
  const launchDonationBatch = useCallback(
    ({ nickname, chat, amount, ballCount }) => {
      const s = g.current;
      if (ballCount <= 0) return;
      const id = ++donationIdRef.current;
      s.donations.set(id, {
        nickname,
        chat,
        amount,
        remaining: ballCount,
        total: ballCount,
        spawned: 0,
        payout: 0,
        itemCounts: {},
        missCount: 0,
      });
      for (let i = 0; i < ballCount; i++) s.spawnQueue.push({ donationId: id });
      syncDonationStatus();
    },
    [syncDonationStatus]
  );

  // 시청자 후원 이벤트 — 닉네임/금액/채팅. 아직 실제 후원 알림 서비스 연동은 없어서
  // 수동 입력 폼(후원 테스트 패널)에서 호출한다. 발사할 구슬 수 = 후원 금액 ÷
  // 구슬 1개당 비용.
  const requestDonation = useCallback(
    ({ nickname, amount, chat }) => {
      const s = g.current;
      const costPerBall = s.world.costPerBall;
      const ballCount = Math.floor(amount / costPerBall);
      launchDonationBatch({ nickname, chat, amount, ballCount });
    },
    [launchDonationBatch]
  );

  // "10연발" — 테스트용으로 후원과 똑같은 방식(집계된 결과 한 건 + 구슬에 이니셜
  // 표시)으로 10개를 바로 쏴본다. 정지 상태면 launchDonationBatch에서 막힌다.
  const requestTenBurst = useCallback(() => {
    launchDonationBatch({ nickname: '테스트', chat: '가즈아 ㄱㄱ', amount: 0, ballCount: 10 });
  }, [launchDonationBatch]);

  // 보드 비율은 DESIGN_W:H(440:700) 고정, 프레임(=캔버스+테두리 여백)은
  // FRAME_W:FRAME_H 고정 — 화면에는 이 비율을 지킨 채 균일하게 확대/축소만
  // 한다(레터박스). 프레임 이미지(A.png)에 맞춘 비율이라 폭을 따로 늘리지 않는다.
  const measureAndBuild = useCallback((rebuild) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    setFit(Math.min(rect.width / FRAME_W, rect.height / FRAME_H));
    if (rebuild) {
      const s = g.current;
      const w = DESIGN_W;
      s.world = createWorld(w, s.settings);
      s.balls = [];
      s.spawnQueue = [];
      s.donations = new Map();
      s.binFlash = new Array(s.world.binPrizes.length).fill(0);
      s.embers = makeEmbers(w);
      setDonationStatus([]);
    }
  }, []);


  // 설정 저장 — state·URL·현재 판을 한번에 갱신한다.
  const saveSettings = useCallback(
    (nextCfg) => {
      setSettings(nextCfg);
      try {
        const url = `${window.location.pathname}?${settingsToSearch(nextCfg)}`;
        window.history.replaceState(null, '', url);
      } catch {
        /* ignore */
      }
      // 진행 중인 구슬/발사 대기열/후원 집계는 그대로 두고 판(레이아웃)만 바꿔
      // 끼운다 — 저장했다고 화면이 통째로 리셋되는 느낌이 들지 않게.
      const s = g.current;
      s.settings = nextCfg;
      s.world = createWorld(dims.w, nextCfg);
      const oldFlash = s.binFlash;
      s.binFlash = new Array(s.world.binPrizes.length)
        .fill(0)
        .map((v, i) => oldFlash[i] || v);
      setShowSettings(false);
    },
    [dims.w]
  );

  const onSaveSettings = useCallback(() => {
    const num = (ref, fallback) => {
      const v = Number(ref.current?.value);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const numNonNeg = (ref, fallback) => {
      const v = Number(ref.current?.value);
      return Number.isFinite(v) && v >= 0 ? v : fallback;
    };
    const isItem = draftType === 'item';
    const cleanTiers = (list) =>
      list.map((t) => ({
        width: Number.isFinite(t.width) && t.width > 0 ? t.width : 20,
        mult: Number.isFinite(t.mult) && t.mult > 0 ? t.mult : 1,
        label: isItem ? t.label || '' : '',
      }));
    saveSettings({
      costPerBall: num(costRef, settings.costPerBall),
      jackpotWidth: num(jpwRef, settings.jackpotWidth),
      jackpotMult: num(jpRef, settings.jackpotMult),
      missMult: numNonNeg(missMultRef, settings.missMult),
      type: draftType,
      jackpotLabel: isItem ? jackpotLabelRef.current?.value || '' : '',
      leftTiers: cleanTiers(draftLeftTiers),
      rightTiers: cleanTiers(draftRightTiers),
      soundEnabled: draftSoundEnabled,
      soundVolume: draftSoundVolume,
    });
  }, [saveSettings, settings, draftType, draftLeftTiers, draftRightTiers, draftSoundEnabled, draftSoundVolume]);

  // 구슬 안착 처리 — 일반 구슬은 착지 즉시 결과를 하나씩 기록하고,
  // 후원으로 발사된 구슬은 s.donations에 모았다가 그 후원 건 구슬이 전부
  // 안착하면 한 번에 집계된 결과 하나를 "당첨 결과"에 남긴다.
  const settleBall = useCallback(
    (ball) => {
      const s = g.current;
      const idx = ball.binIndex;
      const res = interpretLanding(s.world, idx);
      const label = s.world.binLabels[idx];

      // 당첨 이펙트(플래시/버스트)는 "구조적 당첨칸"(win-tier·JACKPOT) 여부로만
      // 켠다 — 꽝 칸이 missMult로 배당(예: x1 환급)이 나가도 여전히 꽝이라 효과는 없다.
      if (res.isWin) {
        s.binFlash[idx] = 1;
        const edges = s.world.binEdges;
        s.burst = {
          x: (edges[idx] + edges[idx + 1]) / 2,
          y: BIN_BOTTOM - 24,
          t: 0,
          jackpot: res.jackpot,
        };
        if (res.jackpot) {
          playJackpotSound(s.settings.soundEnabled, s.settings.soundVolume);
        } else {
          playWinSound(s.settings.soundEnabled, s.settings.soundVolume);
        }
      }
      if (res.jackpot) {
        // 잭팟 — 창을 띄우지 않고 화면(컨페티 + 링 이펙트 + 배경 플래시)만 화려하게.
        spawnConfetti(s.confetti, s.burst.x, s.burst.y);
        setJackpotFlash(true);
        clearTimeout(s.jackpotFlashTimer);
        s.jackpotFlashTimer = setTimeout(() => setJackpotFlash(false), 3000);
      }

      const donation = ball.donationId != null ? s.donations.get(ball.donationId) : null;
      if (donation) {
        donation.remaining -= 1;
        // 배당액(payout)은 실제 돈이라 꽝의 missMult 환급도 그대로 합산하지만,
        // 아이템 당첨/꽝 집계(itemCounts vs missCount)는 구조적 당첨 여부(isWin)로
        // 나눈다 — 꽝은 환급이 있어도 "당첨한 아이템"으로 세지 않는다.
        if (res.multiplier > 0) {
          donation.payout += res.multiplier * s.world.costPerBall;
        }
        if (res.isWin) {
          donation.itemCounts[label] = (donation.itemCounts[label] || 0) + 1;
        } else {
          donation.missCount += 1;
        }
        if (donation.remaining <= 0) {
          s.donations.delete(ball.donationId);
          const isItem = s.settings.type === 'item';
          const entry = isItem
            ? {
                id: `d${ball.donationId}`,
                kind: 'donation-item',
                nickname: donation.nickname,
                chat: donation.chat,
                itemCounts: donation.itemCounts,
                missCount: donation.missCount,
                total: donation.total,
              }
            : {
                id: `d${ball.donationId}`,
                kind: 'donation-contribution',
                nickname: donation.nickname,
                chat: donation.chat,
                payout: donation.payout,
                total: donation.total,
              };
          setLog((l) => [entry, ...l]);
        }
        syncDonationStatus();
      } else if (res.isWin) {
        setLog((l) => [
          { id: ball.id, kind: 'ball', label, multiplier: res.multiplier, payout: res.multiplier * s.world.costPerBall },
          ...l,
        ]);
      }
    },
    [syncDonationStatus]
  );

  // ---- 시뮬레이션 스텝 ----------------------------------------------------
  const tick = useCallback(() => {
    const s = g.current;
    s.time += DT;

    if (s.burst) {
      s.burst.t += DT;
      // 잭팟 링 이펙트는 더 오래(3초) 화려하게 반복되다가 사라진다.
      const maxT = s.burst.jackpot ? 3 : 1;
      if (s.burst.t > maxT) s.burst = null;
    }

    for (const em of s.embers) {
      em.y -= em.speed * DT;
      em.x += em.drift * DT;
      if (em.y < -10) {
        em.y = H + 10;
        em.x = Math.random() * s.world.width;
      }
    }
    if (s.confetti.length) {
      const keep = [];
      for (const c of s.confetti) {
        c.life += DT;
        if (c.life >= c.max) continue;
        c.vy += 480 * DT;
        c.x += c.vx * DT;
        c.y += c.vy * DT;
        keep.push(c);
      }
      s.confetti = keep;
    }

    if (s.auto && s.spawnQueue.length === 0) s.spawnQueue.push({ donationId: null });

    // 정지 상태면 대기열은 그대로 두고(후원은 계속 쌓임) 실제 발사만 멈춘다.
    if (s.running && s.spawnQueue.length > 0 && s.time >= s.nextDropAt && s.balls.length < MAX_BALLS) {
      const req = s.spawnQueue.shift();
      const ball = makeBall(s.world, Math.random());
      ball.donationId = req.donationId;
      if (req.donationId != null) {
        const d = s.donations.get(req.donationId);
        if (d) {
          d.spawned += 1;
          ball.donorInitial = (d.nickname || '').trim().charAt(0) || '?';
          syncDonationStatus();
        }
      }
      s.balls.push(ball);
      s.nextDropAt = s.time + (s.auto ? 0.22 : 0.08);
      // 구슬이 발사구에서 출발하는 순간 swoosh 효과음 — 너무 잦으면 시끄러워서
      // 두 발에 한 번만 재생한다.
      s.launchCount = (s.launchCount || 0) + 1;
      if (s.launchCount % 2 === 0) playLaunchSound(s.settings.soundEnabled, s.settings.soundVolume);
    }

    for (let i = 0; i < SUBSTEPS; i++) {
      advanceWorld(s.world, SUB_DT);
      for (const b of s.balls) stepBall(b, s.world, SUB_DT);
      resolveBallCollisions(s.balls);
    }

    // 못에 부딪힌 공마다 ting 효과음 — 한 프레임(여러 서브스텝) 안에 여러 번
    // 부딪혀도 프레임당 한 번만 울리게 b.hit을 체크 즉시 꺼둔다. 다만 아주
    // 짧은 시간에 너무 많이 겹치면 음이 뭉개지므로 살짝 스로틀한다.
    for (const b of s.balls) {
      if (b.hit) {
        b.hit = false;
        if (s.time - s.lastPegSoundT > 0.025) {
          playPegHitSound(s.settings.soundEnabled, s.settings.soundVolume);
          s.lastPegSoundT = s.time;
        }
      }
    }

    for (const b of s.balls) {
      if (!b.trail) b.trail = [];
      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > TRAIL_LEN) b.trail.shift();
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
  }, [settleBall, syncDonationStatus]);

  // ---- 렌더 ------------------------------------------------------------
  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const s = g.current;
    const world = s.world;
    const left = world.left;
    const right = world.right;
    const fever = !!(s.burst && s.burst.jackpot);

    // 캔버스 비트맵 자체는 매 프레임 투명하게 지운다 — 실제 배경은 .pk-canvas의
    // CSS background(불투명한 보라색 그라데이션)가 담당해서, 캔버스 영역이
    // .pk-frame 뒤쪽 성운 이미지에 가려지지 않고 항상 앞에 보인다.
    ctx.clearRect(0, 0, world.width, H);

    // 위로 떠오르는 불티
    for (const em of s.embers) {
      ctx.beginPath();
      ctx.arc(em.x, em.y, em.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${em.hue}, 95%, 65%, 0.55)`;
      ctx.fill();
    }

    // 발사 레인 (왼쪽 바깥 채널 + 상단 진입 곡선), 흐르는 빛
    const laneGlow = 0.3 + 0.25 * Math.sin(s.time * 4);
    ctx.strokeStyle = `rgba(140,215,255,${0.5 + laneGlow})`;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#7fd8ff';
    ctx.beginPath();
    ctx.moveTo(LAUNCH_X - 5, LAUNCH_Y + 6);
    ctx.lineTo(LAUNCH_X - 5, LAUNCH_LANE_TOP - 4);
    ctx.quadraticCurveTo(LAUNCH_X - 20, LAUNCH_LANE_TOP - 122, 100, 0);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(120,200,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(LAUNCH_X + 7, LAUNCH_Y);
    ctx.lineTo(LAUNCH_X + 7, LAUNCH_LANE_TOP + 6);
    ctx.stroke();
    // 발사구
    const lg = ctx.createLinearGradient(0, LAUNCH_Y, 0, LAUNCH_Y + 20);
    lg.addColorStop(0, '#5fc8ff');
    lg.addColorStop(1, '#1a4d8a');
    ctx.fillStyle = lg;
    ctx.fillRect(LAUNCH_X - 6, LAUNCH_Y + 4, 15, 16);

    // 옆벽 — 네온 이중선
    ctx.strokeStyle = 'rgba(150,170,255,0.5)';
    ctx.lineWidth = 4;
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#7a8cff';
    ctx.beginPath();
    ctx.moveTo(left, 110);
    ctx.lineTo(left, BIN_BOTTOM);
    ctx.moveTo(right, 40);
    ctx.lineTo(right, BIN_BOTTOM);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 못 — 금색 구슬 스프라이트, 은은한 반짝임(크기 펄스).
    // 금색 글로우로 배경과 분리해서 도드라지게 한다(뒤쪽 어두운 그림자는 제거).
    // 충돌 반경(p.r/PEG_R)은 그대로 두고 그림만 더 크게(drawR) 그린다.
    if (PEG_IMG.complete) {
      for (const p of world.pegs) {
        const sparkle = 0.88 + 0.14 * Math.sin(s.time * 2.4 + p.x * 0.04 + p.y * 0.03);
        const pr = (p.guard ? (p.r || PEG_R) + 1.2 : PEG_R) * sparkle;
        const drawR = pr * 1.3;
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(255,205,90,0.95)';
        ctx.drawImage(PEG_IMG, p.x - drawR, p.y - drawR, drawR * 2, drawR * 2);
        ctx.shadowBlur = 0;
      }
    }

    // 바람개비 (마지막 것은 JACKPOT 가드 — 마젠타 크리스탈 범퍼).
    // 색 글로우로 배경과 분리해서 잘 보이게 한다(뒤쪽 어두운 그림자는 제거).
    world.windmills.forEach((m, mi) => {
      const guard = mi === world.windmills.length - 1;
      const img = guard ? BUMPER_GUARD_IMG : BUMPER_IMG;
      if (!img.complete) return;
      const size = m.len * 2.7; // 이미지 여백을 고려해 날개 길이보다 조금 크게
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.angle);
      ctx.shadowBlur = guard ? 18 : 14;
      ctx.shadowColor = guard ? '#ff2d78' : '#2fd9a8';
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.shadowBlur = 0;
      ctx.restore();
    });

    // 배당칸 패널 배경 — B.png(성운 이미지)를 깔고, 텍스트 가독성을 위해
    // 그 위에 어두운 필터를 덧씌운다. 이미지가 아직 안 불러와졌으면(초기 로드
    // 중) 어두운 필터만 깔아서 빈 패널로 보이지 않게 한다.
    const binEdges = world.binEdges;
    if (BIN_PANEL_IMG.complete) {
      drawImageCover(ctx, BIN_PANEL_IMG, left, BIN_TOP, right - left, BIN_BOTTOM - BIN_TOP);
    }
    ctx.fillStyle = 'rgba(6,5,14,0.6)';
    ctx.fillRect(left, BIN_TOP, right - left, BIN_BOTTOM - BIN_TOP);

    // 칸막이
    ctx.strokeStyle = 'rgba(160,175,255,0.55)';
    ctx.lineWidth = 3;
    for (let i = 1; i < binEdges.length - 1; i++) {
      ctx.beginPath();
      ctx.moveTo(binEdges[i], BIN_TOP);
      ctx.lineTo(binEdges[i], BIN_BOTTOM);
      ctx.stroke();
    }

    // 칸 배경 + 라벨 — 당첨칸(잭팟 제외)마다 다른 색을 항상 은은하게 깔아두고,
    // 당첨될 때만 그 색이 잠깐 확 밝아진다(flash). 색상은 당첨 등급 칸 개수만큼
    // 색상환을 고르게 나눠 배정 — 잭팟 색(핑크/레드)과 안 겹치도록 0~300도만 쓴다.
    ctx.textAlign = 'center';
    const binPrizes = world.binPrizes;
    const winTierIndices = [];
    for (let i = 0; i < binPrizes.length; i++) {
      if (i !== world.jackpotIndex && world.binIsWin[i]) winTierIndices.push(i);
    }
    for (let i = 0; i < binPrizes.length; i++) {
      const x0 = binEdges[i];
      const x1 = binEdges[i + 1];
      const flash = s.binFlash[i];
      const label = world.binLabels[i];
      let base = '90,100,160';
      let bright = false;
      let hue = null;
      if (i === world.jackpotIndex) {
        base = '255,61,129';
        bright = true;
      } else if (world.binIsWin[i]) {
        bright = true;
        const idx = winTierIndices.indexOf(i);
        hue = winTierIndices.length > 1 ? Math.round((idx / winTierIndices.length) * 300) : 45;
      }
      const colorStr = (alpha) => (hue != null ? `hsla(${hue},85%,60%,${alpha})` : `rgba(${base},${alpha})`);
      if (bright) {
        ctx.fillStyle = colorStr(0.16 + flash * 0.5);
        ctx.fillRect(x0 + 1.5, BIN_TOP, x1 - x0 - 3, BIN_BOTTOM - BIN_TOP);
        ctx.strokeStyle = colorStr(0.55 + flash * 0.45);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 2, BIN_TOP + 2, x1 - x0 - 4, BIN_BOTTOM - BIN_TOP - 4);
      }

      ctx.save();
      // 라벨은 칸 아래쪽이 아니라 위쪽에 둔다 — 안착한 구슬들이 칸 바닥에
      // 쌓이면서(BIN_BOTTOM 근처) 아래쪽 라벨을 가려버리는 문제가 있었다.
      ctx.translate((x0 + x1) / 2, BIN_TOP + 17);
      if (bright) {
        ctx.shadowBlur = 8;
        ctx.shadowColor = colorStr(0.9);
      }
      ctx.fillStyle = bright ? '#fff' : 'rgba(255,255,255,0.5)';
      // 칸 폭이 좁거나(잭팟) 이름이 길면(아이템 추첨) 글자를 줄여서 가로로 맞춘다.
      const maxTextW = x1 - x0 - 4;
      let fontSize = bright ? 13 : 11;
      ctx.font = `${bright ? 'bold ' : ''}${fontSize}px system-ui, sans-serif`;
      while (fontSize > 6 && ctx.measureText(label).width > maxTextW) {
        fontSize -= 1;
        ctx.font = `${bright ? 'bold ' : ''}${fontSize}px system-ui, sans-serif`;
      }
      ctx.fillText(label, 0, 3);
      ctx.shadowBlur = 0;
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(160,175,255,0.6)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(left, BIN_BOTTOM);
    ctx.lineTo(right, BIN_BOTTOM);
    ctx.stroke();

    // 구슬 — 꼬리(트레일) + 발광 글래스 오브 본체
    for (const b of s.balls) {
      if (b.trail) {
        for (let i = 0; i < b.trail.length; i++) {
          const t = b.trail[i];
          const a = ((i + 1) / (b.trail.length + 1)) * 0.3;
          ctx.beginPath();
          ctx.arc(t.x, t.y, BALL_R * 0.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(160,230,255,${a})`;
          ctx.fill();
        }
      }
      // 배경과 분리되는 어두운 후광 + 외곽 글로우
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R * 1.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fill();
      const halo = ctx.createRadialGradient(b.x, b.y, BALL_R * 0.4, b.x, b.y, BALL_R * 2.3);
      halo.addColorStop(0, 'rgba(170,225,255,0.6)');
      halo.addColorStop(1, 'rgba(150,220,255,0)');
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R * 2.3, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();
      // 유리구슬 본체
      const gd = ctx.createRadialGradient(b.x - 2, b.y - 2.5, 0.6, b.x, b.y, BALL_R);
      gd.addColorStop(0, '#f2feff');
      gd.addColorStop(0.35, '#8fe0ff');
      gd.addColorStop(0.72, '#3d7ae0');
      gd.addColorStop(1, '#1c2f78');
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
      ctx.fillStyle = gd;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // 스페큘러 하이라이트
      ctx.beginPath();
      ctx.ellipse(b.x - BALL_R * 0.32, b.y - BALL_R * 0.4, BALL_R * 0.32, BALL_R * 0.18, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
      // 후원 구슬이면 닉네임 첫 글자를 가운데에 표시해서 누구 건지 알아보게 한다.
      if (b.donorInitial) {
        ctx.save();
        ctx.font = `bold ${BALL_R * 1.45}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowBlur = 3;
        ctx.shadowColor = 'rgba(0,20,50,0.9)';
        ctx.fillStyle = '#fff';
        ctx.fillText(b.donorInitial, b.x, b.y + 0.5);
        ctx.restore();
      }
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

    // 잭팟 컨페티
    for (const c of s.confetti) {
      const a = Math.max(0, 1 - c.life / c.max);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.life * 6 + c.hue);
      ctx.fillStyle = `hsla(${c.hue}, 95%, 65%, ${a})`;
      ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 1.6);
      ctx.restore();
    }

    // 화면 가장자리 네온 프레임(살짝 숨쉬듯 깜빡임)
    const framePulse = 0.35 + 0.25 * Math.sin(s.time * 2.6);
    ctx.strokeStyle = fever
      ? `rgba(255,90,190,${0.5 + framePulse})`
      : `rgba(120,150,255,${0.25 + framePulse * 0.5})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(2.5, 2.5, world.width - 5, H - 5);
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

  // 화면 크기 실측: 처음 그려지기 전에(깜빡임 없이) 레터박스 크기를 맞추고,
  // 창 크기가 바뀌면 크기만 다시 맞춘다(비율이 고정이라 판을 새로 짤 필요는 없음).
  useLayoutEffect(() => {
    measureAndBuild(true);
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => measureAndBuild(false));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [measureAndBuild]);

  return (
    <div className={'pk-wrap' + (jackpotFlash ? ' pk-wrap-jackpot' : '')}>
      <h1 className="pk-title">
        <span>P</span>
        <span>I</span>
        <span>N</span>
        <span>B</span>
        <span>A</span>
        <span>L</span>
        <span>L</span>
      </h1>

      <div className="pk-stage" ref={stageRef}>
        <div
          className="pk-frame"
          style={{
            width: FRAME_W * fit,
            height: FRAME_H * fit,
          }}
        >
          <canvas
            ref={canvasRef}
            width={dims.w}
            height={dims.h}
            className="pk-canvas"
            style={{
              left: PAD_X * fit,
              top: PAD_TOP * fit,
              width: DESIGN_W * fit,
              height: H * fit,
              backgroundImage: `url(${BIN_PANEL_IMG_URL})`,
            }}
          />

          <div className="pk-frame-art" style={{ backgroundImage: `url(${FRAME_IMG_URL})` }} />

          {showLog && (
            <div className="pk-panel">
              <div className="pk-panel-header">
                <h3>당첨 결과</h3>
                <button className="pk-panel-close" onClick={() => setShowLog(false)} aria-label="닫기">
                  ✕
                </button>
              </div>
              {donationStatus.length > 0 && (
                <>
                  <h4 className="pk-subhead">진행 중인 후원</h4>
                  <ul className="pk-log-list pk-status-list">
                  {donationStatus.map((d) => (
                    <li key={d.id} className="pk-log-donation pk-status-row">
                      <div className="pk-log-donor">
                        <span className={'pk-status-badge' + (d.spawned === 0 ? ' pk-status-waiting' : '')}>
                          {d.spawned === 0 ? '대기중' : '진행중'}
                        </span>
                        <span className="pk-log-label">{d.nickname}</span>
                        <span className="pk-log-payout">
                          {d.settled}/{d.total}
                        </span>
                      </div>
                    </li>
                  ))}
                  </ul>
                </>
              )}
              {log.length > 0 && <h4 className="pk-subhead">당첨 내역</h4>}
              {log.length === 0 ? (
                donationStatus.length === 0 && (
                  <p className="pk-panel-empty">아직 당첨 기록이 없습니다.</p>
                )
              ) : (
                <ul className="pk-log-list">
                  {log.map((r) => {
                    if (r.kind === 'donation-contribution') {
                      return (
                        <li key={r.id} className="pk-log-donation">
                          <div className="pk-log-donor">
                            <span className="pk-log-label">{r.nickname}</span>
                            <span className="pk-log-payout">
                              {r.payout.toLocaleString()}원 획득 (구슬 {r.total}개)
                            </span>
                          </div>
                          {r.chat && <div className="pk-log-chat">{r.chat}</div>}
                        </li>
                      );
                    }
                    if (r.kind === 'donation-item') {
                      const items = Object.entries(r.itemCounts);
                      return (
                        <li key={r.id} className="pk-log-donation">
                          <div className="pk-log-donor">
                            <span className="pk-log-label">{r.nickname}</span>
                            <span className="pk-log-payout">구슬 {r.total}개</span>
                          </div>
                          <div className="pk-log-items">
                            {items.map(([name, count]) => (
                              <span key={name} className="pk-log-item-chip">
                                {name} ×{count}
                              </span>
                            ))}
                            {r.missCount > 0 && (
                              <span className="pk-log-item-chip pk-log-item-miss">
                                꽝 ×{r.missCount}
                              </span>
                            )}
                          </div>
                          {r.chat && <div className="pk-log-chat">{r.chat}</div>}
                        </li>
                      );
                    }
                    return (
                      <li key={r.id}>
                        <span className="pk-log-label">{r.label}</span>
                        <span className="pk-log-mult">×{r.multiplier}</span>
                        <span className="pk-log-payout">
                          {r.payout.toLocaleString()}원
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {showSettings && (
            <div className="pk-panel">
              <div className="pk-panel-header">
                <h3>설정</h3>
                <button className="pk-panel-close" onClick={() => setShowSettings(false)} aria-label="닫기">
                  ✕
                </button>
              </div>
              <div className="pk-settings-section">
                <h4 className="pk-subhead">사운드</h4>
                <label className="pk-field pk-field-row">
                  <span>효과음</span>
                  <input
                    type="checkbox"
                    checked={draftSoundEnabled}
                    onChange={(e) => setDraftSoundEnabled(e.target.checked)}
                  />
                </label>
                <label className="pk-field">
                  음량 ({Math.round(draftSoundVolume * 100)}%)
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    disabled={!draftSoundEnabled}
                    value={draftSoundVolume}
                    onChange={(e) => setDraftSoundVolume(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="pk-settings-section">
                <h4 className="pk-subhead">기본 설정</h4>
                <label className="pk-field">
                  타입
                  <select value={draftType} onChange={(e) => setDraftType(e.target.value)}>
                    <option value="contribution">기여도 (배수로 표시)</option>
                    <option value="item">아이템 추첨 (이름으로 표시)</option>
                  </select>
                </label>
                <label className="pk-field">
                  구슬 1개당 비용(원)
                  <input type="number" min="1" defaultValue={settings.costPerBall} ref={costRef} />
                </label>

                {draftType === 'contribution' && (
                  <label className="pk-field">
                    꽝 배당 배수 (0 = 진짜 꽝, 1 이상이면 꽝도 배당이 나감)
                    <input type="number" min="0" defaultValue={settings.missMult} ref={missMultRef} />
                  </label>
                )}
              </div>

              <div className="pk-settings-section">
              <h4 className="pk-subhead">왼쪽 당첨칸 (자유롭게 추가/삭제)</h4>
              {draftLeftTiers.map((t, i) => (
                <div className="pk-tier-row" key={i}>
                  <label className="pk-field pk-tier-field">
                    칸 폭
                    <input
                      type="number"
                      min="4"
                      value={t.width}
                      onChange={(e) => updateTier('left', i, 'width', Number(e.target.value))}
                    />
                  </label>
                  {draftType === 'contribution' && (
                    <label className="pk-field pk-tier-field">
                      배당 배수
                      <input
                        type="number"
                        min="1"
                        value={t.mult}
                        onChange={(e) => updateTier('left', i, 'mult', Number(e.target.value))}
                      />
                    </label>
                  )}
                  {draftType === 'item' && (
                    <label className="pk-field pk-tier-field pk-tier-field-name">
                      이름
                      <input
                        type="text"
                        placeholder="예: 아메리카노"
                        value={t.label}
                        onChange={(e) => updateTier('left', i, 'label', e.target.value)}
                      />
                    </label>
                  )}
                  <button className="ghost pk-tier-remove" onClick={() => removeTier('left', i)}>
                    삭제
                  </button>
                </div>
              ))}

              <h4 className="pk-subhead">오른쪽 당첨칸 (자유롭게 추가/삭제)</h4>
              {draftRightTiers.map((t, i) => (
                <div className="pk-tier-row" key={i}>
                  <label className="pk-field pk-tier-field">
                    칸 폭
                    <input
                      type="number"
                      min="4"
                      value={t.width}
                      onChange={(e) => updateTier('right', i, 'width', Number(e.target.value))}
                    />
                  </label>
                  {draftType === 'contribution' && (
                    <label className="pk-field pk-tier-field">
                      배당 배수
                      <input
                        type="number"
                        min="1"
                        value={t.mult}
                        onChange={(e) => updateTier('right', i, 'mult', Number(e.target.value))}
                      />
                    </label>
                  )}
                  {draftType === 'item' && (
                    <label className="pk-field pk-tier-field pk-tier-field-name">
                      이름
                      <input
                        type="text"
                        placeholder="예: 아메리카노"
                        value={t.label}
                        onChange={(e) => updateTier('right', i, 'label', e.target.value)}
                      />
                    </label>
                  )}
                  <button className="ghost pk-tier-remove" onClick={() => removeTier('right', i)}>
                    삭제
                  </button>
                </div>
              ))}
              <button className="ghost" onClick={addTier}>
                + 칸 추가
              </button>
              </div>

              <div className="pk-settings-section">
              <h4 className="pk-subhead">JACKPOT 칸</h4>
              <label className="pk-field">
                JACKPOT 칸 폭
                <input type="number" min="8" max="60" defaultValue={settings.jackpotWidth} ref={jpwRef} />
              </label>
              {draftType === 'contribution' && (
                <label className="pk-field">
                  JACKPOT 배당 배수
                  <input type="number" min="1" defaultValue={settings.jackpotMult} ref={jpRef} />
                </label>
              )}
              {draftType === 'item' && (
                <label className="pk-field">
                  JACKPOT 칸 이름
                  <input
                    type="text"
                    placeholder="예: 치킨 기프티콘"
                    defaultValue={settings.jackpotLabel}
                    ref={jackpotLabelRef}
                  />
                </label>
              )}
              </div>
              <div className="pk-panel-actions">
                <button onClick={onSaveSettings}>저장</button>
                <button className="ghost" onClick={() => setShowSettings(false)}>
                  닫기
                </button>
              </div>
            </div>
          )}

          {showDonation && (
            <div className="pk-panel">
              <h3>후원 발사 (테스트 입력)</h3>
              <p className="pk-panel-empty">
                실제 후원 알림 연동 전까지, 여기서 닉네임/금액/채팅을 직접 입력해서
                후원 발사를 테스트할 수 있습니다.
              </p>
              <label className="pk-field">
                닉네임
                <input type="text" placeholder="예: 김덕배" ref={donorNameRef} />
              </label>
              <label className="pk-field">
                후원 금액(원)
                <input type="number" min="1" placeholder="예: 10000" ref={donorAmountRef} />
              </label>
              <label className="pk-field">
                채팅
                <input type="text" placeholder="예: 채팅1234" ref={donorChatRef} />
              </label>
              <div className="pk-panel-actions">
                <button
                  onClick={() => {
                    const nickname = donorNameRef.current?.value.trim() || '익명';
                    const amount = Number(donorAmountRef.current?.value);
                    const chat = donorChatRef.current?.value || '';
                    if (!Number.isFinite(amount) || amount <= 0) return;
                    requestDonation({ nickname, amount, chat });
                    if (donorAmountRef.current) donorAmountRef.current.value = '';
                    if (donorChatRef.current) donorChatRef.current.value = '';
                    setShowDonation(false);
                  }}
                >
                  발사
                </button>
                <button className="ghost" onClick={() => setShowDonation(false)}>
                  닫기
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="pk-controls">
        <button
          className={running ? '' : 'warn'}
          onClick={() => setRunning((v) => !v)}
        >
          {running ? '정지' : '시작'}
        </button>
        <button onClick={() => setShowDonation((v) => !v)}>후원</button>
        <button onClick={requestTenBurst}>10연발</button>
        <button onClick={() => setShowLog((v) => !v)}>당첨 결과</button>
        <button
          onClick={() => {
            setDraftType(settings.type);
            setDraftLeftTiers(settings.leftTiers);
            setDraftRightTiers(settings.rightTiers);
            setDraftSoundEnabled(settings.soundEnabled);
            setDraftSoundVolume(settings.soundVolume);
            setShowSettings((v) => !v);
          }}
        >
          설정
        </button>
      </div>
    </div>
  );
}
