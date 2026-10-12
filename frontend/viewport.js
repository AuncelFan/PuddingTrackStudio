import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import XYZ from 'ol/source/XYZ.js';
import { defaults as interactions } from 'ol/interaction/defaults.js';
import DragPan from 'ol/interaction/DragPan.js';
import { createScene } from '../shared/scene.mjs';
import { appPath } from './app-path.js';

const makeCanvas = (width, height) => {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas;
};

export class Viewport {
  constructor({ target, canvas, onCamera, onTiles }) {
    this.canvas = canvas;
    this.onCamera = onCamera;
    this.onTiles = onTiles;
    this.layer = new TileLayer();
    this.map = new Map({
      target, controls: [], layers: [this.layer],
      interactions: interactions({ altShiftDragRotate: false, pinchRotate: false, dragPan: false }).extend([new DragPan()]),
      view: new View({ center: [0, 0], zoom: 12, maxZoom: 24, enableRotation: false }),
    });
    this.map.on('moveend', () => {
      if (!this.camera || !this.config || !this.track) return;
      if (this.locked) return;
      const size = this.map.getSize();
      if (!size?.[0]) return;
      const center = this.map.getView().getCenter();
      const span = this.map.getView().getResolution() * size[0];
      if (Math.abs(span - this.camera.span) < 0.0001 && center.every((value, i) => Math.abs(value - this.camera.center[i]) < 0.0001)) return;
      this.camera = { center: [...center], span };
      this.rebuild();
      this.onCamera(this.camera);
    });
    this.observer = new ResizeObserver(() => {
      this.map.updateSize();
      this.applyCamera();
    });
    this.observer.observe(target);
    this.setLocked(true);
  }

  setLocked(locked) {
    if (locked) {
      const view = this.map.getView();
      view.cancelAnimations();
      const size = this.map.getSize();
      if (this.camera && size?.[0]) {
        // Freeze the view the user sees now, even if a wheel/zoom animation is in flight.
        this.camera = { center: [...view.getCenter()], span: view.getResolution() * size[0] };
        this.rebuild(); this.onCamera(this.camera);
      }
    }
    this.locked = locked;
    this.map.getInteractions().forEach(interaction => interaction.setActive(!locked));
    this.map.getTargetElement().style.cursor = locked ? 'default' : 'grab';
  }

  set({ track, config, camera, plan, frameIndex }) {
    this.track = track; this.config = config; this.camera = camera;
    this.plan = plan; this.frameIndex = frameIndex;
    this.canvas.width = config.width; this.canvas.height = config.height;
    const provider = config.mode === 'map' ? config.basemap : 'grid';
    this.layer.setVisible(provider !== 'grid');
    if (provider !== this.provider) {
      this.provider = provider;
      if (provider !== 'grid') {
        let pending = 0, failed = false;
        const source = new XYZ({ url: appPath(`api/tiles/${provider}/{z}/{x}/{y}.png`), maxZoom: 18,
          crossOrigin: 'anonymous', wrapX: true, transition: 0 });
        const status = () => {
          if (this.provider === provider) this.onTiles(failed ? 'error' : pending > 0 ? 'loading' : 'ready');
        };
        source.on('tileloadstart', () => { pending++; status(); });
        source.on('tileloadend', () => { pending = Math.max(0, pending - 1); status(); });
        source.on('tileloaderror', () => { pending = Math.max(0, pending - 1); failed = true; status(); });
        this.layer.setSource(source);
      } else {
        this.layer.setSource(null); this.onTiles('offline');
      }
    }
    this.map.updateSize();
    this.applyCamera();
    this.rebuild();
  }

  applyCamera() {
    if (!this.camera) return;
    const size = this.map.getSize();
    if (!size?.[0]) return;
    this.map.getView().setCenter(this.camera.center);
    this.map.getView().setResolution(this.camera.span / size[0]);
  }

  rebuild() {
    if (!this.track || !this.camera) return;
    this.scene = createScene({ createCanvas: makeCanvas, track: this.track,
      config: this.config, camera: this.camera, overlay: true });
    this.draw(this.frameIndex || 0);
  }

  draw(index) {
    if (!this.plan || !this.scene) return;
    const last = this.plan.frames.length - 1;
    const safeIndex = Math.max(0, Math.min(last, Number.isInteger(index) ? index : 0));
    this.frameIndex = safeIndex;
    const frame = this.plan.frames[safeIndex];
    if (frame) this.scene.draw(this.canvas, frame, safeIndex, this.plan);
  }

  zoom(factor) {
    if (!this.camera || this.locked) return;
    this.map.getView().setResolution(this.map.getView().getResolution() * factor);
  }
}
