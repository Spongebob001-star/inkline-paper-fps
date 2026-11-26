import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const hud = read('../client/hud.mjs');
const main = read('../client/main.mjs');
const page = read('../dev/client.html');

test('赛前收口：常驻 HUD 提示不再暴露 I 无敌，但无敌观测入口保留', () => {
  const hint = hud.match(/<div id="hud-hint">([^<]*)<\/div>/);
  assert.ok(hint, 'hud-hint markup present');
  assert.match(hint[1], /WASD 移动/);
  assert.doesNotMatch(hint[1], /I\s*无敌/);
  assert.match(main, /if \(ev\.code === 'KeyI'\)/);
  assert.match(main, /function toggleGod/);
});

test('赛前收口：移动端/微信提示默认隐藏并在窄屏粗指针或微信内显示', () => {
  assert.ok(page.includes('#env-warn { display:none;'));
  assert.ok(page.includes('#env-warn.on { display:block; }'));
  assert.ok(page.includes('<p id="env-warn" role="note">本作支持手机触屏（建议横屏）。桌面端建议使用 Chrome / Edge 以获得完整体验</p>'));
  assert.ok(main.includes("mq('(pointer: coarse)').matches && mq('(max-width: 900px)').matches"));
  assert.ok(main.includes('MicroMessenger|QQ\\/'));
});

test('赛前收口：无敌观测通关不写入最快撤离纪录，结算仍标注观摩模式', () => {
  assert.ok(main.includes('const isNew = won && !godUsed ? saveBest(match.elapsed) : false;'));
  assert.ok(main.includes('god: godUsed'));
});
