import { createIcons, Upload, Play, Pause, SkipBack, SkipForward, LockKeyhole, UnlockKeyhole,
  Map, Route, Download, Focus, Mountain, Clock3, Gauge, ArrowUpRight, Plus, Minus,
  CircleHelp, Check, X, SlidersHorizontal, Layers, ChevronDown, FileUp, LoaderCircle } from 'lucide';
import { Viewport } from './viewport.js';
import { clock, fitCamera } from '../shared/scene.mjs';
import { estimateOutputBytes, formatFileSize, formatSizeEstimate } from '../shared/output-size.mjs';
import { appPath } from './app-path.js';
import { enhanceNumberInputs } from './number-input.js';
import './style.css';

const iconSet = { Upload, Play, Pause, SkipBack, SkipForward, LockKeyhole, UnlockKeyhole, Map, Route,
  Download, Focus, Mountain, Clock3, Gauge, ArrowUpRight, Plus, Minus, CircleHelp, Check, X,
  SlidersHorizontal, Layers, ChevronDown, FileUp, LoaderCircle };
const icons = () => createIcons({ icons: iconSet, attrs: { 'stroke-width': 1.6 } });
const $ = selector => document.querySelector(selector);
const PREFERENCES_KEY = 'pudding-track-studio';
const defaults = {
  mode: 'map', basemap: 'grid', format: 'mp4', width: 640, height: 640,
  routeColor: '#91e2bc', trailColor: '#ffbc7a', markerColor: '#ffbc7a', backgroundColor: '#15232c',
  markerStyle: 'dot',
  routeOpacity: 0.85, backgroundOpacity: 1, lineWidth: 4, markerSize: 7,
  showGrid: true, showTrail: false, showEndpoints: true, showHud: false, glow: true,
};
const state = { track: null, tracks: [], plan: null, config: { ...defaults }, camera: null,
  speed: 60, fps: 30, start: 0, end: null, frame: 0, playing: false, locked: true,
  planning: false, planError: null, playQueued: false, importing: false, job: null, jobTimer: null, hevcAlpha: null };
let animation, playToken = 0, planController, planTimer, saveTimer;

$('#app').innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="PuddingTrackStudio 首页"><span class="brand-mark"><i data-lucide="route"></i></span><span>Pudding<span class="brand-light">TrackStudio</span><small>轨迹影像工作台</small></span></a>
    <span class="header-note">把走过的路，放进你的故事。</span>
    <div class="header-actions"><button id="demo" class="button ghost" aria-label="载入示例" title="载入示例"><i data-lucide="mountain"></i>载入示例</button><button id="import-top" class="button secondary"><i data-lucide="upload"></i>导入 KML</button></div>
  </header>
  <main class="workspace">
    <aside class="sidebar left-sidebar">
      <div class="section-heading"><span>轨迹素材</span><span class="eyebrow">01 / SOURCE</span></div>
      <label class="upload-zone" id="dropzone" for="file"><span class="upload-icon"><i data-lucide="file-up"></i></span><strong>拖入你的 KML 文件</strong><span>或点击选择 · 最大 20 MB</span><input id="file" type="file" accept=".kml" /></label>
      <div class="track-card" id="track-card" hidden><div class="track-card-head"><span class="status-dot"></span><span>轨迹已就绪</span><span id="source-kind" class="tag"></span></div><h2 id="track-name"></h2><p id="track-file"></p><select id="track-select" aria-label="选择轨迹" hidden></select><div class="track-stats"><div><i data-lucide="route"></i><span>路线距离</span><strong id="distance">—</strong></div><div><i data-lucide="clock-3"></i><span>实际时长</span><strong id="duration">—</strong></div><div><i data-lucide="layers"></i><span>原始点数</span><strong id="point-count">—</strong></div></div><p id="time-range" class="muted"></p></div>
      <details class="import-details"><summary>无时间信息的 KML <i data-lucide="chevron-down"></i></summary><p>若文件只有路线，可填写实际总时长，按距离匀速推算。它不会还原真实停留。</p><label>实际总时长（秒）<input id="fallback-duration" type="number" min="1" max="604800" placeholder="例如 3600" /></label><button id="reimport" class="button secondary small">使用此时长重新导入</button></details>
      <div id="warnings" class="notice warning" hidden></div>
      <div class="section-heading style-heading"><span>画面风格</span><span class="eyebrow">02 / STYLE</span></div>
      <button class="style-card selected" id="style-map" aria-pressed="true"><div class="style-thumbnail map-thumbnail"><svg viewBox="0 0 100 65" aria-hidden="true"><path d="M15 47L30 43L25 28L48 16L64 24L81 16L86 37L65 48L48 40L40 54Z"/><circle cx="64" cy="24" r="4"/></svg></div><div><strong>地图轨迹</strong><span>空间参照 · 清晰直观</span></div><span class="selected-check"><i data-lucide="check"></i></span></button>
      <button class="style-card" id="style-geometry" aria-pressed="false"><div class="style-thumbnail geometry-thumbnail"><svg viewBox="0 0 100 65" aria-hidden="true"><path d="M17 48L32 43L27 27L47 18L62 26L81 16L85 38L64 48L47 41L39 53"/><circle cx="62" cy="26" r="4"/></svg></div><div><strong>极简几何</strong><span>游戏 HUD · 透明叠加</span></div><span class="selected-check"><i data-lucide="check"></i></span></button>
      <div class="sidebar-tip"><i data-lucide="circle-help"></i><p>先调整地图范围，再锁定视角。<br>播放时地图固定，标记沿轨迹移动。</p></div>
      <div class="sidebar-footer"><span class="status-dot"></span><span id="service-status">正在连接本地服务</span><span>v0.1</span></div>
    </aside>

    <section class="editor">
      <div class="editor-heading"><div><span class="eyebrow">LIVE PREVIEW</span><h1>轨迹预览</h1></div><div class="view-toolbar"><button id="fit" class="icon-button" title="显示完整轨迹" aria-label="显示完整轨迹"><i data-lucide="focus"></i></button><button id="lock" class="button lock-button active"><i data-lucide="lock-keyhole"></i><span>视角已锁定</span></button></div></div>
      <div class="preview-stage" id="preview-stage">
        <div class="stage-corner top-left"></div><div class="stage-corner top-right"></div><div class="stage-corner bottom-left"></div><div class="stage-corner bottom-right"></div>
        <div class="preview" id="preview"><div id="map"></div><canvas id="scene" aria-label="固定视角轨迹动画预览"></canvas><div id="empty-state"><div class="empty-route"><i data-lucide="route"></i></div><h2>你的下一段旅程，从这里开始</h2><p>导入一条轨迹，生成适合视频叠加的小地图。</p><button id="demo-empty" class="button secondary"><i data-lucide="play"></i>Try West Lake Loop</button></div></div>
        <div class="preview-badge"><span class="status-dot"></span><span id="preview-status">等待导入轨迹</span></div><span class="preview-size" id="preview-size">640 × 640</span>
        <div class="zoom-tools"><button id="zoom-in" class="icon-button" aria-label="放大" title="放大（先解锁视角）"><i data-lucide="plus"></i></button><button id="zoom-out" class="icon-button" aria-label="缩小" title="缩小（先解锁视角）"><i data-lucide="minus"></i></button></div>
      </div>
      <div class="timeline-panel"><div class="timeline-header"><span class="eyebrow">PLAYBACK</span><span id="frame-info" class="mono">FRAME 00000 / 00000</span></div><input type="range" id="timeline" aria-label="播放进度" min="0" max="1" value="0" disabled /><div class="timeline-controls"><div class="time-label"><strong id="source-clock" class="mono">00:00:00</strong><span>轨迹时间</span></div><div class="transport"><button id="first" class="icon-button" aria-label="回到第一帧"><i data-lucide="skip-back"></i></button><button id="play" class="play-button" aria-label="播放" disabled><i data-lucide="play"></i></button><button id="last" class="icon-button" aria-label="跳到最后一帧"><i data-lucide="skip-forward"></i></button></div><div class="time-label align-right"><strong id="video-clock" class="mono">00:00:00</strong><span>导出时长 · <b id="speed-label">60×</b></span></div></div></div>
      <div class="editor-caption"><span><i data-lucide="lock-keyhole"></i>固定镜头回放</span><p>预览区域即导出画面，直接叠加在视频左上角。</p><span id="tiles-status">无需网络瓦片</span></div>
      <div id="message" class="notice" role="status" aria-live="polite" hidden></div>
    </section>

    <aside class="sidebar right-sidebar">
      <div class="section-heading"><span>回放设置</span><i data-lucide="sliders-horizontal"></i></div>
      <div class="field"><label for="speed">时间倍率 <span class="subtle">真实时间 / 视频时间</span></label><input id="speed" type="number" min="0.01" max="3600" step="1" value="60" data-unit="×" required /><div class="presets" id="speed-presets"><button data-speed="30">30×</button><button data-speed="60" class="selected">60×</button><button data-speed="120">120×</button><button data-speed="240">240×</button></div></div>
      <details class="clip-details"><summary>截取时间范围 <i data-lucide="chevron-down"></i></summary><div class="two-fields"><label>开始（秒）<input id="clip-start" type="number" value="0" min="0" step="0.1" required /></label><label>结束（秒）<input id="clip-end" type="number" placeholder="轨迹终点" min="0.1" step="0.1" /></label></div></details>
      <div class="divider"></div>
      <div class="section-heading"><span>画面设置</span><span class="eyebrow">APPEARANCE</span></div>
      <div class="field" id="basemap-field"><label for="basemap">底图</label><select id="basemap"><option value="grid">离线坐标网格</option><option value="osm">OpenStreetMap · WGS84</option><option value="gaode">高德地图 · GCJ-02</option></select></div>
      <div class="color-fields"><label>轨迹色<input id="route-color" type="color" value="#91e2bc" /></label><label>标记色<input id="marker-color" type="color" value="#ffbc7a" /></label><label>背景色<input id="background-color" type="color" value="#15232c" /></label></div>
      <div class="two-fields appearance-row"><label for="line-width">轨迹线宽<input id="line-width" type="number" min="1" max="640" step="0.5" value="4" data-unit="px" required /></label><label for="route-opacity">轨迹不透明度<input id="route-opacity" type="number" min="5" max="100" step="1" value="85" data-unit="%" required /></label></div>
      <div class="two-fields appearance-row"><label for="marker-style">标记样式<select id="marker-style"><option value="dot">● 圆点</option><option value="ring">◎ 空心环</option><option value="arrow">➤ 方向箭头</option><option value="pin">⌖ 定位针</option><option value="crosshair">⊕ 准星</option></select></label><label for="marker-size">标记大小<input id="marker-size" type="number" min="4" max="640" step="0.5" value="14" data-unit="px" required /></label></div>
      <div class="field" id="background-opacity-field" hidden><label for="background-opacity">背景不透明度</label><input id="background-opacity" type="number" min="0" max="100" step="1" value="0" data-unit="%" required /></div>
      <div class="toggle-fields"><label><span>已走路径</span><input id="show-trail" type="checkbox" /><span class="switch"></span></label><label class="trail-color-field" id="trail-color-field" hidden><span>已走路径颜色</span><input id="trail-color" type="color" value="#ffbc7a" /></label><label><span>起点 / 终点</span><input id="show-endpoints" type="checkbox" checked /><span class="switch"></span></label><label><span>里程进度 HUD</span><input id="show-hud" type="checkbox" /><span class="switch"></span></label><label id="glow-field" hidden><span>路线辉光</span><input id="glow" type="checkbox" checked /><span class="switch"></span></label></div>
      <div class="divider"></div>
      <div class="section-heading"><span>视频输出</span><span class="eyebrow">03 / EXPORT</span></div>
      <button id="open-export" class="button primary export-button"><i data-lucide="sliders-horizontal"></i><span>视频导出设置</span><i data-lucide="arrow-up-right"></i></button>
      <div id="job-panel" role="status" aria-live="polite" hidden><div class="job-heading"><strong id="job-stage">等待渲染</strong><span id="job-percent" class="mono">0%</span></div><progress id="job-progress" max="1" value="0"></progress><p id="job-detail"></p><p id="job-format-note" class="format-note" hidden></p><div class="job-actions"><button id="cancel-export" class="button ghost small">取消任务</button><a id="download" class="button primary small" hidden download><i data-lucide="download"></i>下载视频</a></div></div>
    </aside>
  </main>
  <dialog id="export-dialog" aria-labelledby="export-title" aria-describedby="export-description">
    <div class="dialog-heading"><div><span class="eyebrow">VIDEO EXPORT</span><h2 id="export-title">视频导出设置</h2></div><button id="close-export" class="icon-button" aria-label="关闭导出设置"><i data-lucide="x"></i></button></div>
    <p id="export-description">设置分辨率、帧率与格式。导出使用当前锁定视角和画面设置。</p>
    <div class="dialog-body">
      <div class="field"><label for="resolution">分辨率</label><select id="resolution"><option value="640x640">640 × 640 · 小地图</option><option value="800x800">800 × 800 · 高清小地图</option><option value="1280x720">1280 × 720 · 720p</option><option value="1920x1080">1920 × 1080 · 1080p</option><option value="3840x2160">3840 × 2160 · 4K</option><option value="custom">自定义尺寸</option></select></div>
      <div class="two-fields" id="custom-resolution" hidden><label>宽度<input id="width" type="number" value="640" min="32" max="3840" step="2" required /></label><label>高度<input id="height" type="number" value="640" min="32" max="3840" step="2" required /></label></div>
      <div class="two-fields output-fields"><label for="fps">帧率<input id="fps" type="number" value="30" min="1" max="120" step="1" data-unit="fps" required /></label><label for="format">导出格式<select id="format"><option value="mp4">MP4 · H.264</option><option value="webm">WebM · VP9 α</option><option value="mov">MOV · ProRes α</option><option value="hevc-alpha">MOV · HEVC Alpha</option></select></label></div>
      <p class="format-note" id="format-note">MP4 适合直接使用；透明叠加请选择 WebM 或 MOV。</p>
      <div class="export-summary"><div><span>预计时长</span><strong id="export-duration" class="mono">—</strong></div><div><span>总帧数</span><strong id="export-frames" class="mono">—</strong></div><div><span>预估文件大小</span><strong id="estimated-size" class="mono">—</strong></div></div>
      <p class="estimate-note">按当前设置粗估，受画面复杂度与透明度影响；实际大小以导出结果为准。</p>
      <p id="export-error" class="notice warning" role="alert" hidden></p>
    </div>
    <div class="dialog-actions"><button id="close-export-footer" class="button secondary">返回预览</button>
      <button id="export" class="button primary export-button" disabled><i data-lucide="download"></i><span>导出视频</span><i data-lucide="arrow-up-right"></i></button>
    </div>
  </dialog>
  <footer class="bottom-bar"><span>PuddingTrackStudio <b>/</b> KML → MINIMAP VIDEO</span><span>本地处理 <b>·</b> 精确逐帧渲染 <b>·</b> 为创作而生</span></footer>`;
icons();
enhanceNumberInputs();

const viewport = new Viewport({ target: $('#map'), canvas: $('#scene'),
  onCamera: camera => { state.camera = camera; persist(); },
  onTiles: status => {
    $('#tiles-status').textContent = ({ offline: '无需网络瓦片', ready: '底图已加载', loading: '正在加载底图…', error: '底图加载失败 · 请换离线网格或检查代理' })[status];
    $('#tiles-status').classList.toggle('tile-error', status === 'error');
  },
});

function notify(message, type = 'info') {
  $('#message').hidden = !message;
  $('#message').textContent = message;
  $('#message').className = `notice ${type}`;
}

async function api(url, options = {}) {
  const response = await fetch(appPath(url), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(payload.detail) ? payload.detail.map(error => error.msg).join('；') : payload.detail;
    const error = new Error(detail || `请求失败 (${response.status})`); error.code = payload.code; throw error;
  }
  return payload;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePreferences, 200);
}

function savePreferences() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ config: state.config, camera: state.camera,
    trackId: state.track?.id, speed: state.speed, fps: state.fps, start: state.start, end: state.end, jobId: state.job?.id })); } catch { /* Storage can be disabled. */ }
}
window.addEventListener('pagehide', savePreferences);

function pause() {
  state.playing = false; state.playQueued = false; playToken += 1;
  cancelAnimationFrame(animation); animation = null;
  $('#play').innerHTML = '<i data-lucide="play"></i>'; $('#play').setAttribute('aria-label', '播放');
  updatePreviewStatus(); icons();
}

function updatePreviewStatus() {
  $('#preview-status').textContent = !state.track ? '等待导入轨迹'
    : state.playing ? '回放中 · 视角固定'
    : state.playQueued ? '等待帧序列 · 将自动播放'
    : state.locked ? '视角锁定 · 仅标记移动' : '视角可调整 · 拖动 / 滚轮缩放';
}

function setLocked(locked) {
  state.locked = locked; viewport.setLocked(locked);
  $('#lock').classList.toggle('active', locked);
  $('#lock').innerHTML = `<i data-lucide="${locked ? 'lock-keyhole' : 'unlock-keyhole'}"></i><span>${locked ? '视角已锁定' : '调整视角'}</span>`;
  $('#zoom-in').disabled = $('#zoom-out').disabled = locked || !state.track;
  updatePreviewStatus(); icons();
}

function updateFrame() {
  if (!state.plan || !Array.isArray(state.plan.frames) || !state.plan.frames.length) return;
  const lastFrame = state.plan.frames.length - 1;
  if (!Number.isInteger(state.frame) || state.frame < 0 || state.frame > lastFrame) {
    state.frame = Math.max(0, Math.min(lastFrame, Number(state.frame) || 0));
  }
  const frame = state.plan.frames[state.frame];
  if (!frame) return;
  viewport.draw(state.frame);
  $('#timeline').value = state.frame;
  $('#timeline').style.setProperty('--progress', `${state.frame / Math.max(1, state.plan.frameCount - 1) * 100}%`);
  $('#frame-info').textContent = `FRAME ${String(state.frame + 1).padStart(5, '0')} / ${String(state.plan.frameCount).padStart(5, '0')}`;
  $('#source-clock').textContent = clock(frame[5]);
}

function renderScene() {
  $('#preview').style.aspectRatio = `${state.config.width} / ${state.config.height}`;
  layoutPreview();
  $('#preview-size').textContent = `${state.config.width} × ${state.config.height}`;
  if (state.track && state.camera) viewport.set({ track: state.track, config: state.config,
    camera: state.camera, plan: state.plan, frameIndex: state.frame });
}

function layoutPreview() {
  const stage = $('#preview-stage');
  const availableWidth = Math.max(100, stage.clientWidth - (window.innerWidth < 650 ? 62 : 82));
  const availableHeight = Math.max(100, stage.clientHeight - 88);
  const scale = Math.min(availableWidth / state.config.width, availableHeight / state.config.height);
  $('#preview').style.width = `${state.config.width * scale}px`;
  $('#preview').style.height = `${state.config.height * scale}px`;
}
new ResizeObserver(layoutPreview).observe($('#preview-stage'));

function fit() {
  if (!state.track) return;
  pause();
  state.camera = fitCamera(state.track.points, state.config.width, state.config.height,
    state.config.mode === 'map' ? state.config.basemap : 'grid');
  renderScene(); persist();
}

function outputError(checkCapability = true) {
  const c = state.config;
  if (!['mp4', 'webm', 'mov', 'hevc-alpha'].includes(c.format)) return '请选择 MP4、WebM、ProRes MOV 或 HEVC Alpha 导出格式。';
  if (!Number.isInteger(c.width) || !Number.isInteger(c.height) || c.width < 32 || c.height < 32 || c.width > 3840 || c.height > 3840 || c.width * c.height > 3840 * 2160) return '宽高须为 32–3840 的整数，总像素数不超过 4K。';
  if (c.format !== 'mov' && (c.width % 2 || c.height % 2)) return 'MP4 / WebM / HEVC Alpha 的宽高须为偶数。';
  if (c.format === 'mp4' && c.mode === 'geometry' && c.backgroundOpacity < 1) return 'MP4 不支持透明通道，请选择 WebM / MOV，或将背景不透明度设为 100%。';
  if (!Number.isFinite(c.lineWidth) || c.lineWidth < 1 || c.lineWidth > 640
    || !Number.isFinite(c.markerSize) || c.markerSize < 2 || c.markerSize > 320) return '线宽与标记大小须为正数，且不能超过画布尺寸。';
  if (!['dot', 'ring', 'arrow', 'pin', 'crosshair'].includes(c.markerStyle)) return '请选择有效的标记样式。';
  if (checkCapability && c.format === 'hevc-alpha' && !state.hevcAlpha?.available) return state.hevcAlpha?.reason || '正在检测 HEVC Alpha 编码器，请稍候。';
  return '';
}

function updateControls() {
  // Keep playback clickable while a plan is being rebuilt. A click during
  // that short window is queued and starts as soon as the new plan arrives.
  $('#play').disabled = !state.track;
  $('#timeline').disabled = !state.plan || state.planning;
  $('#first').disabled = $('#last').disabled = !state.plan || state.planning;
  const activeJob = state.job && ['queued', 'running'].includes(state.job.status);
  $('#export').disabled = !state.plan || state.planning || !!outputError() || activeJob;
  $('#export span').textContent = activeJob ? '正在导出…' : state.planning ? '正在计算帧序列…' : '导出视频';
  const error = outputError() || state.planError;
  $('#export-error').textContent = error || '';
  $('#export-error').hidden = !error;
}

const styleUnit = () => Math.min(state.config.width, state.config.height) / 640;
function setInputValue(id, value) {
  const input = $('#' + id);
  if (document.activeElement !== input) input.value = value;
}

function syncSettings() {
  const c = state.config;
  setInputValue('speed', state.speed); setInputValue('fps', state.fps);
  setInputValue('clip-start', state.start); setInputValue('clip-end', state.end ?? '');
  if (state.track) $('#clip-start').max = $('#clip-end').max = state.track.durationSeconds;
  for (const button of $('#speed-presets').children) button.classList.toggle('selected', Number(button.dataset.speed) === state.speed);
  $('#speed-label').textContent = `${state.speed}×`;
  $('#style-map').classList.toggle('selected', c.mode === 'map');
  $('#style-geometry').classList.toggle('selected', c.mode === 'geometry');
  $('#style-map').setAttribute('aria-pressed', String(c.mode === 'map'));
  $('#style-geometry').setAttribute('aria-pressed', String(c.mode === 'geometry'));
  $('#basemap-field').hidden = c.mode !== 'map';
  $('#background-opacity-field').hidden = $('#glow-field').hidden = c.mode !== 'geometry';
  $('#trail-color-field').hidden = !c.showTrail;
  $('#basemap').value = c.basemap; $('#format').value = c.format;
  $('#marker-style').value = c.markerStyle;
  for (const [id, property] of [['route-color', 'routeColor'], ['trail-color', 'trailColor'], ['marker-color', 'markerColor'], ['background-color', 'backgroundColor']]) $('#' + id).value = c[property];
  const unit = styleUnit();
  $('#line-width').min = unit; $('#marker-size').min = 4 * unit;
  $('#line-width').max = $('#marker-size').max = Math.min(c.width, c.height);
  setInputValue('line-width', Number((c.lineWidth * unit).toFixed(4)));
  setInputValue('marker-size', Number((c.markerSize * unit * 2).toFixed(4)));
  setInputValue('route-opacity', Math.round(c.routeOpacity * 100));
  setInputValue('background-opacity', Math.round(c.backgroundOpacity * 100));
  for (const [id, property] of [['show-trail', 'showTrail'], ['show-endpoints', 'showEndpoints'], ['show-hud', 'showHud'], ['glow', 'glow']]) $('#' + id).checked = c[property];
  const size = `${c.width}x${c.height}`;
  $('#resolution').value = [...$('#resolution').options].some(option => option.value === size) ? size : 'custom';
  setInputValue('width', c.width); setInputValue('height', c.height);
  $('#custom-resolution').hidden = $('#resolution').value !== 'custom';
  $('#format-note').textContent = c.format === 'mp4' ? 'MP4 没有透明通道，适合直接使用。透明叠加请选择 WebM 或 MOV。'
    : c.format === 'webm' ? 'VP9 保留透明度。部分剪辑软件不支持 WebM，可选 ProRes MOV。'
    : c.format === 'hevc-alpha'
      ? '注意：此 MOV 含 HEVC 辅助 Alpha 透明图层，仅用于支持 HEVC Alpha 的视频剪辑。普通播放器或网盘无法可靠地直接预览，可能出现线条变粗、颜色异常或标记抖动，这不代表视频导出有误。请导入剪辑软件查看透明叠加效果；直接播放请选择 MP4。'
    : 'ProRes 4444 保留透明度，适合专业剪辑；文件通常较大。';
  $('#format-note').classList.toggle('codec-warning', c.format === 'hevc-alpha');
  updateEstimatedSize();
  updateControls();
}

function planSettings() { return { speed: state.speed, fps: state.fps, start: state.start, end: state.end }; }

function updateEstimatedSize() {
  const estimate = outputError() ? null : estimateOutputBytes({ ...state.config, frameCount: state.plan?.frameCount ?? 0 });
  $('#estimated-size').textContent = formatSizeEstimate(estimate);
}

async function replan() {
  clearTimeout(planTimer); planController?.abort(); pause();
  state.planError = null;
  if (!state.track) { updateEstimatedSize(); return; }
  const controller = new AbortController(); planController = controller;
  state.planning = true; state.plan = null; updateControls(); updateEstimatedSize();
  try {
    const plan = await api(`api/tracks/${state.track.id}/plan`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(planSettings()), signal: controller.signal });
    if (controller.signal.aborted) return;
    state.plan = plan; state.frame = 0;
    $('#timeline').max = plan.frameCount - 1;
    $('#video-clock').textContent = clock(plan.videoDurationSeconds);
    $('#export-duration').textContent = `${plan.videoDurationSeconds.toFixed(2)} s`;
    $('#export-frames').textContent = plan.frameCount.toLocaleString();
    updateEstimatedSize();
    notify(outputError(), outputError() ? 'warning' : 'info');
    renderScene(); updateFrame(); persist();
    if (state.playQueued && state.plan === plan) {
      state.playQueued = false;
      // The finally block flips planning off and refreshes disabled states.
      // Queue the actual start after this async turn so play() cannot observe
      // the old planning flag.
      queueMicrotask(() => { if (state.plan === plan && !state.planning) play(); });
    }
  } catch (error) {
    if (error.name !== 'AbortError') { state.planError = error.message; state.playQueued = false; notify(error.message, 'error'); $('#export-duration').textContent = $('#export-frames').textContent = '—'; }
  } finally {
    if (planController === controller) { state.planning = false; updateControls(); }
  }
}

function setTrack(track, restoreCamera = false) {
  pause(); state.track = track; state.plan = null; state.start = 0; state.end = null; state.frame = 0;
  $('#empty-state').hidden = true; $('#track-card').hidden = false;
  $('#track-name').textContent = track.name; $('#track-file').textContent = track.filename;
  $('#source-kind').textContent = track.timingDerived ? '分段时间' : (track.synthetic ? '推算时间' : '含时间');
  $('#distance').textContent = `${(track.distanceMeters / 1000).toFixed(2)} km`;
  $('#duration').textContent = clock(track.durationSeconds);
  $('#point-count').textContent = track.pointCount.toLocaleString();
  $('#time-range').textContent = track.startTime
    ? new Date(track.startTime).toLocaleString('zh-CN') + ' 开始'
    : (track.timingDerived ? '按 COROS 分段时长插值 · 无逐点时间戳' : '匀速推算 · 非原始时间记录');
  $('#warnings').textContent = track.warnings.join('\n'); $('#warnings').hidden = !track.warnings.length;
  $('#track-select').hidden = state.tracks.length <= 1;
  $('#track-select').replaceChildren(...state.tracks.map(t => new Option(t.name, t.id, false, t.id === track.id)));
  if (!restoreCamera || !state.camera) state.camera = fitCamera(track.points, state.config.width, state.config.height, state.config.mode === 'map' ? state.config.basemap : 'grid');
  syncSettings(); renderScene(); setLocked(true); replan();
}

async function importTrack(file) {
  if (!file || state.importing) return;
  state.importing = true; $('#import-top').disabled = $('#demo').disabled = true;
  notify('正在解析轨迹…');
  const form = new FormData(); form.append('file', file);
  if ($('#fallback-duration').value) form.append('duration_seconds', $('#fallback-duration').value);
  try {
    const result = await api('api/tracks', { method: 'POST', body: form });
    state.tracks = result.tracks; setTrack(result.tracks[0]);
  } catch (error) {
    notify(error.message, 'error');
    if (error.code === 'missing_time') $('.import-details').open = true;
  } finally { state.importing = false; $('#import-top').disabled = $('#demo').disabled = false; }
}

async function demo() {
  if (state.importing) return;
  state.importing = true; $('#demo').disabled = $('#demo-empty').disabled = true;
  notify('正在载入示例轨迹…');
  try { const result = await api('api/demo', { method: 'POST' }); state.tracks = result.tracks; setTrack(result.tracks[0]); }
  catch (error) { notify(error.message, 'error'); }
  finally { state.importing = false; $('#demo').disabled = $('#demo-empty').disabled = false; }
}

function play() {
  if (!state.track) return;
  if (!state.plan || state.planning) {
    state.playQueued = !state.playQueued;
    updatePreviewStatus();
    return;
  }
  if (state.playing) { pause(); return; }
  setLocked(true);
  const lastFrame = Math.max(0, Number(state.plan.frameCount) - 1);
  if (!Number.isInteger(state.frame) || state.frame < 0 || state.frame > lastFrame) state.frame = 0;
  if (state.frame >= lastFrame) state.frame = 0;
  const plan = state.plan;
  const runToken = ++playToken;
  state.playing = true;
  $('#play').innerHTML = '<i data-lucide="pause"></i>'; $('#play').setAttribute('aria-label', '暂停');
  updatePreviewStatus(); icons();
  const startFrame = state.frame, startClock = performance.now();
  const tick = now => {
    // cancelAnimationFrame cannot retract a callback already queued by the
    // browser. The token prevents an old playback loop from drawing into a
    // newly calculated plan after a settings change or a seek.
    if (!state.playing || runToken !== playToken || state.plan !== plan) return;
    state.frame = Math.min(plan.frameCount - 1, startFrame + Math.floor((now - startClock) * plan.fps / 1000));
    updateFrame();
    if (state.frame === plan.frameCount - 1) pause();
    else animation = requestAnimationFrame(tick);
  };
  animation = requestAnimationFrame(tick);
}

function changeConfig(update, refit = false) {
  pause(); const previous = state.config;
  state.config = { ...previous, ...update };
  const error = outputError();
  // Invalid dimensions are displayed for correction without allocating giant/invalid canvases.
  if (!Number.isInteger(state.config.width) || !Number.isInteger(state.config.height) || state.config.width < 32 || state.config.height < 32 || state.config.width > 3840 || state.config.height > 3840 || state.config.width * state.config.height > 3840 * 2160) {
    notify(error, 'warning'); updateControls(); updateEstimatedSize(); return;
  }
  syncSettings();
  if (refit) fit(); else renderScene();
  notify(error, error ? 'warning' : 'info'); persist();
}

function showJob(job) {
  state.job = job; $('#job-panel').hidden = false;
  const labels = { queued: '等待渲染', starting: '准备渲染', tiles: '加载固定底图', rendering: '逐帧渲染', encoding: '完成视频编码', done: '视频已就绪', failed: '导出失败', cancelled: '任务已取消' };
  $('#job-stage').textContent = labels[job.stage] || '正在导出';
  $('#job-percent').textContent = `${Math.round(job.progress * 100)}%`;
  $('#job-progress').value = job.progress;
  $('#job-detail').textContent = job.status === 'done' ? `${job.width} × ${job.height} · ${job.fps} fps · ${formatFileSize(job.sizeBytes)}` : job.error || `${job.renderedFrames.toLocaleString()} / ${job.frameCount.toLocaleString()} 帧`;
  $('#job-format-note').hidden = job.encoding !== 'hevc-alpha';
  $('#job-format-note').textContent = job.encoding === 'hevc-alpha'
    ? 'HEVC MOV 为透明剪辑素材。播放器预览失真并非导出失败，请在支持 HEVC Alpha 的剪辑软件中查看。' : '';
  $('#download').hidden = job.status !== 'done';
  if (job.downloadUrl) $('#download').href = appPath(job.downloadUrl);
  $('#cancel-export').hidden = !['queued', 'running'].includes(job.status);
  updateControls(); persist();
}

async function pollJob(jobId) {
  clearTimeout(state.jobTimer);
  try {
    const job = await api(`api/exports/${jobId}`); showJob(job);
    if (['queued', 'running'].includes(job.status)) state.jobTimer = setTimeout(() => pollJob(jobId), 800);
  } catch (error) { notify(`读取任务状态失败：${error.message}`, 'error'); state.jobTimer = setTimeout(() => pollJob(jobId), 3000); }
}

$('#export').addEventListener('click', async () => {
  if (!state.plan || outputError()) return;
  pause(); setLocked(true); $('#export').disabled = true;
  notify('');
  try {
    const job = await api('api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: state.track.id, plan: planSettings(), config: state.config, camera: state.camera }) });
    $('#export-dialog').close(); showJob(job); pollJob(job.id);
  } catch (error) {
    notify(error.message, 'error'); updateControls();
    $('#export-error').textContent = error.message; $('#export-error').hidden = false;
  }
});
$('#open-export').addEventListener('click', () => { pause(); syncSettings(); $('#export-dialog').showModal(); });
for (const id of ['close-export', 'close-export-footer']) $('#' + id).addEventListener('click', () => $('#export-dialog').close());
$('#export-dialog').addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
});
$('#cancel-export').addEventListener('click', async () => {
  if (!state.job) return;
  try { showJob(await api(`api/exports/${state.job.id}`, { method: 'DELETE' })); clearTimeout(state.jobTimer); }
  catch (error) { notify(error.message, 'error'); }
});
$('#import-top').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', event => importTrack(event.target.files[0]));
$('#reimport').addEventListener('click', () => importTrack($('#file').files[0]));
$('#dropzone').addEventListener('dragover', event => { event.preventDefault(); $('#dropzone').classList.add('dragover'); });
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragover');
  if (event.dataTransfer.files.length) { $('#file').files = event.dataTransfer.files; importTrack(event.dataTransfer.files[0]); } });
$('#demo').addEventListener('click', demo); $('#demo-empty').addEventListener('click', demo);
$('#track-select').addEventListener('change', event => setTrack(state.tracks.find(t => t.id === event.target.value)));
$('#fit').addEventListener('click', fit);
$('#lock').addEventListener('click', () => { pause(); setLocked(!state.locked); });
$('#zoom-in').addEventListener('click', () => viewport.zoom(0.8));
$('#zoom-out').addEventListener('click', () => viewport.zoom(1.25));
$('#play').addEventListener('click', play);
$('#first').addEventListener('click', () => { pause(); state.frame = 0; updateFrame(); });
$('#last').addEventListener('click', () => { pause(); state.frame = state.plan.frameCount - 1; updateFrame(); });
$('#timeline').addEventListener('input', event => { pause(); state.frame = Number(event.target.value); updateFrame(); });
for (const id of ['speed', 'fps', 'clip-start', 'clip-end']) $('#' + id).addEventListener('change', () => {
  state.speed = Number($('#speed').value); state.fps = Number($('#fps').value);
  state.start = Number($('#clip-start').value); state.end = $('#clip-end').value ? Number($('#clip-end').value) : null;
  syncSettings(); replan();
});
for (const button of $('#speed-presets').children) button.addEventListener('click', () => { state.speed = Number(button.dataset.speed); syncSettings(); replan(); });
$('#style-map').addEventListener('click', () => changeConfig({ mode: 'map', format: 'mp4', backgroundOpacity: 1, showEndpoints: true }, state.config.mode !== 'map'));
$('#style-geometry').addEventListener('click', () => changeConfig({ mode: 'geometry', format: 'webm', backgroundOpacity: 0, showEndpoints: false, showHud: false }, state.config.mode !== 'geometry'));
$('#basemap').addEventListener('change', event => changeConfig({ basemap: event.target.value }, true));
$('#format').addEventListener('change', event => changeConfig({ format: event.target.value }));
$('#marker-style').addEventListener('change', event => changeConfig({ markerStyle: event.target.value }));
$('#resolution').addEventListener('change', event => {
  if (event.target.value === 'custom') { $('#custom-resolution').hidden = false; return; }
  const [width, height] = event.target.value.split('x').map(Number); changeConfig({ width, height });
});
for (const id of ['width', 'height']) $('#' + id).addEventListener('change', () => changeConfig({ width: Number($('#width').value), height: Number($('#height').value) }));
for (const [id, property] of [['route-color', 'routeColor'], ['trail-color', 'trailColor'], ['marker-color', 'markerColor'], ['background-color', 'backgroundColor']]) $('#' + id).addEventListener('input', event => changeConfig({ [property]: event.target.value }));
for (const [id, property, convert] of [['line-width', 'lineWidth', value => value / styleUnit()],
  ['marker-size', 'markerSize', value => value / (styleUnit() * 2)],
  ['route-opacity', 'routeOpacity', value => value / 100], ['background-opacity', 'backgroundOpacity', value => value / 100]]) {
  $('#' + id).addEventListener('input', event => {
    const input = event.target, value = input.valueAsNumber;
    if (Number.isFinite(value) && value >= Number(input.min) && value <= Number(input.max)) changeConfig({ [property]: convert(value) });
  });
}
for (const [id, property] of [['show-trail', 'showTrail'], ['show-endpoints', 'showEndpoints'], ['show-hud', 'showHud'], ['glow', 'glow']]) $('#' + id).addEventListener('change', event => changeConfig({ [property]: event.target.checked }));
document.addEventListener('keydown', event => {
  if (!$('#export-dialog').open && event.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(event.target.tagName)) { event.preventDefault(); play(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

async function initialize() {
  syncSettings(); setLocked(true);
  try {
    const health = await api('api/health');
    state.hevcAlpha = health.hevcAlpha || { available: false, reason: '当前后端未提供 HEVC Alpha，请更新并安装编码器。' };
    syncSettings(); $('#service-status').textContent = '本地渲染服务在线';
    let saved;
    // Read previous releases' key once; subsequent saves use the project name.
    try { saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || localStorage.getItem('trace-studio') || 'null'); } catch { /* Ignore damaged preferences. */ }
    if (saved?.trackId) {
      try {
        const track = await api(`api/tracks/${saved.trackId}`);
        state.config = { ...defaults, ...Object.fromEntries(Object.entries(saved.config || {}).filter(([key]) => key in defaults)) };
        if (outputError(false)) state.config = { ...defaults };
        state.camera = saved.camera && Array.isArray(saved.camera.center) && saved.camera.center.every(Number.isFinite) && Number.isFinite(saved.camera.span) && saved.camera.span >= 20 ? saved.camera : null;
        state.speed = saved.speed || 60; state.fps = saved.fps || 30; state.tracks = [track];
        setTrack(track, true);
        state.start = saved.start || 0; state.end = saved.end ?? null; syncSettings(); await replan();
      } catch { notify('上次轨迹已不可用，请重新导入或载入示例。', 'warning'); }
    }
    if (saved?.jobId) pollJob(saved.jobId);
  } catch { $('#service-status').textContent = '本地服务未连接'; notify('后端未启动。请在项目目录运行 npm run dev。', 'error'); }
}
initialize();
