// 组装脚本：把 CSS、内联引擎、模型数据、游戏逻辑拼进 HTML 模板，产出单文件可玩版本
// 用法：node src/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

const tpl = read('./index.template.html');
const css = read('./style.css');
const game = read('./game.js');
const engine = read('./three/three.min.js');

// 模型 JSON（Blender 导出，毫米坐标 + 每面颜色）→ 注入为全局常量
const MODEL_FILES = { fold: 'fold', eraser: 'er', plane: 'pl', bottle: 'bo', tape: 'ta', boss: 'bs' };
const modelData = {};
for (const [key, file] of Object.entries(MODEL_FILES)) {
  modelData[key] = JSON.parse(read('./models/' + file + '.json'));
}

// 使用函数替换，避免替换内容中的 $ 序列被当作特殊模式
const out = tpl
  .replace('/*{{CSS}}*/', () => css)
  .replace('/*{{THREE_ENGINE}}*/', () => engine)
  .replace('/*{{MODEL_DATA}}*/', () => 'window.__INKLINE_MODELS__=' + JSON.stringify(modelData) + ';')
  .replace('/*{{GAME_JS}}*/', () => game);

writeFileSync(new URL('../墨线突围.html', import.meta.url), out, 'utf8');
console.log('built OK, bytes =', out.length);
