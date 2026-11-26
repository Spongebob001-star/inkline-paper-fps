const STEPS = [
  ['切枪与开火', '左键射击敌人 · 按 1/2/3 或滚轮切换三把文具枪'],
  ['一键速墙挡弹', '按 G 瞬间立墙挡弹幕（或按 Q 两步自定义画墙）'],
  ['橡皮脉冲破甲', '贴近青绿护甲敌人按 E 擦除破甲并眩晕'],
  ['折纸登高与锚点', '靠近折页按 C 翻折 · 前往 A1 按住 F 启动（解锁强化！）'],
  ['智取奶龙 Boss', '奶龙冲锋按 G 立墙撞晕 · 大笑时射肚皮暴击或按 E 打断！'],
];

// Presentation-only progress; main owns events, visibility preference and restart.
export function createGuide({ enabled = true } = {}) {
  let active = Boolean(enabled);
  const achieved = Array(5).fill(false);
  let step = 1;
  let complete = false;
  let remaining = 0;

  function advance() {
    while (step < 5 && achieved[step - 1]) step++;
    if (!complete && step === 5 && achieved[4]) {
      complete = true;
      remaining = 3;
    }
  }

  function onEvent(ev) {
    const data = ev?.data ?? {};
    switch (ev?.type) {
      // Shared combat emits hit only for enemies/Boss; scenery emits impact.
      case 'hit':
        achieved[0] = true;
        if (data.crit === true) achieved[4] = true;
        break;
      case 'wallDraw':
        if (data.owner === 0) achieved[1] = true;
        break;
      case 'erase':
        if (data.owner === 0) achieved[2] = true;
        break;
      case 'anchorDone': achieved[3] = true; break;
      case 'bossStun':
      case 'bossInterrupt':
      case 'bossDown': achieved[4] = true; break;
      default: return;
    }
    advance();
  }

  function weaponChanged() {
    achieved[0] = true;
    advance();
  }

  // dt is seconds. Hidden guides still track achievements and completion time.
  function update(snap, dt = 0) {
    if (complete && Number.isFinite(dt) && dt > 0) {
      remaining = Math.max(0, remaining - dt);
    }
    if (!complete && snap?.boss && !snap.boss.dead) {
      step = 5;
      advance();
    }
  }

  function setEnabled(value) { active = Boolean(value); }

  function reset() {
    achieved.fill(false);
    step = 1;
    complete = false;
    remaining = 0;
  }

  function state() {
    return {
      enabled: active,
      visible: active && (!complete || remaining > 0),
      step,
      title: complete ? '✓ 纸上战术已掌握' : STEPS[step - 1][0],
      text: complete ? '' : STEPS[step - 1][1],
      complete,
    };
  }

  return { onEvent, weaponChanged, update, setEnabled, reset, state };
}
