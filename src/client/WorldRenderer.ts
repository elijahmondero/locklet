import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HERO_CLASSES } from '../shared/constants.js';
import type {
  ActiveMode,
  ChamberPublicState,
  HeroClass,
  PropCorner,
  RoomSnapshotMessage,
  TeamId,
} from '../shared/types.js';

interface GlbTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

interface LabelSlot {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  lastKey: string;
}

interface PropVisual {
  group: THREE.Group;
  beaconMat: THREE.MeshStandardMaterial;
  meshHolder: THREE.Group;
  label: LabelSlot;
  corner: PropCorner;
}

interface ChamberRig {
  team: TeamId;
  root: THREE.Group;
  floorGroup: THREE.Group;
  wallMats: THREE.MeshStandardMaterial[];
  floorMat: THREE.MeshStandardMaterial;
  torchMats: THREE.MeshStandardMaterial[];
  doorLeaf: THREE.Group;
  vaultChestGroup: THREE.Group;
  lockCrystalMats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  hazardMesh: THREE.Mesh;
  hazardMat: THREE.MeshStandardMaterial;
  blackoutMesh: THREE.Mesh;
  bridgeTiles: Array<{ L: THREE.MeshStandardMaterial; R: THREE.MeshStandardMaterial }>;
  props: PropVisual[];
  giftLabel: LabelSlot;
  giftRing: THREE.Mesh;
  spotlightHolder: THREE.Group;
  spotlightLabel: LabelSlot;
  spotlightUser: string | null;
  spotlightClass: HeroClass | null;
  spotlightMixer: THREE.AnimationMixer | null;
  spotlightShieldRing: THREE.Mesh;
  queueHolders: THREE.Group[];
  queueWalkers: CrowdWalkerState[];
  queueUsers: Array<string | null>;
  queueMixers: Array<THREE.AnimationMixer | null>;
}

const MAX_CROWD_AVATARS = 24;

interface CrowdWalkerState {
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  speed: number;
  pauseSec: number;
  phase: number;
  visitIdx: number;
}

const CORNER_COORDS: Record<PropCorner, [number, number]> = {
  nw: [-2.15, -2.35],
  ne: [2.15, -2.35],
  mw: [-2.2, -0.55],
  me: [2.2, -0.55],
  sw: [-2.15, 1.2],
  se: [2.15, 1.2],
};

const PROP_CORNERS: readonly PropCorner[] = ['nw', 'ne', 'mw', 'me', 'sw', 'se'];

function pickWalkerTarget(idx: number, seed: number): { x: number; z: number } {
  const hash = ((idx + 1) * 73 + (seed + 1) * 131) >>> 0;
  let x: number;
  let z: number;

  if (seed % 2 === 0) {
    const corner = PROP_CORNERS[(idx + Math.floor(seed / 2)) % PROP_CORNERS.length];
    const [px, pz] = CORNER_COORDS[corner];
    x = px + (px < 0 ? 0.56 : -0.56) + (((hash % 5) - 2) * 0.08);
    z = pz + ((((hash >> 3) % 5) - 2) * 0.14);
  } else if (hash % 3 === 0) {
    // Open forecourt area in front of carpet
    const fracX = ((hash % 100) / 99) * 2 - 1;
    const fracZ = ((hash >> 7) % 100) / 99;
    x = fracX * 2.25;
    z = 1.65 + fracZ * 1.2;
  } else {
    // Left / right side aisles keeping center bridge clear
    const side = (idx + seed) % 2 === 0 ? -1 : 1;
    const fracX = ((hash >> 2) % 100) / 99;
    const fracZ = ((hash >> 9) % 100) / 99;
    x = side * (0.95 + fracX * 1.4);
    z = -1.6 + fracZ * 4.15;
  }

  x = Math.max(-2.45, Math.min(2.45, x));
  z = Math.max(-2.05, Math.min(2.95, z));
  if (Math.abs(x) < 0.72 && z < 0.4) {
    x = x < 0 ? -0.78 : 0.78;
  }
  return { x, z };
}

function pickClip(clips: THREE.AnimationClip[], keywords: string[]): THREE.AnimationClip | undefined {
  for (const kw of keywords) {
    const match = clips.find((c) => c.name.toLowerCase().includes(kw));
    if (match) return match;
  }
  return clips[0];
}

function pickClassForName(name: string): HeroClass {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HERO_CLASSES[h % HERO_CLASSES.length];
}

/**
 * 9:16 3D Cutaway Escape Room Renderer for Locklet.
 * Dynamically swaps between 1 big Co-op Chamber and Twin Red vs. Blue Race Cells,
 * applying rotating theme palettes, rising hazard fluids, trapdoor pits, and KayKit characters.
 */
export class WorldRenderer {
  private readonly container: HTMLElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private lastFrameMs = 0;
  private elapsedSec = 0;
  private disposed = false;

  private readonly disposables: Array<{ dispose: () => void }> = [];
  private skyMat!: THREE.ShaderMaterial;
  private ambientParticles: THREE.Points | null = null;
  private ambientParticleMat: THREE.PointsMaterial | null = null;
  private wallBrickTex: THREE.CanvasTexture | null = null;
  private floorTileTex: THREE.CanvasTexture | null = null;

  private currentMode: ActiveMode = 'coop';
  private currentThemeId = '';
  private latestSnapshot: RoomSnapshotMessage | null = null;
  private readonly camLookAt = new THREE.Vector3(0, 0.45, 0.15);

  private readonly coopRig: ChamberRig;
  private readonly redRig: ChamberRig;
  private readonly blueRig: ChamberRig;

  private readonly classTemplates = new Map<HeroClass, GlbTemplate>();
  private worldPropTemplates: THREE.Group[] = [];

  constructor(container: HTMLElement, options: { width?: number; height?: number } = {}) {
    this.container = container;
    const width = options.width || container.clientWidth || 540;
    const height = options.height || container.clientHeight || 960;

    this.camera = new THREE.PerspectiveCamera(46, 9 / 16, 0.1, 120);
    this.camera.position.set(0, 8.8, 11.4);
    this.camera.lookAt(0, 0.45, 0.15);

    this.initRenderer(width, height);
    this.buildLights();
    this.buildSky();
    this.wallBrickTex = this.createStoneWallTexture();
    this.floorTileTex = this.createFloorTileTexture();

    this.coopRig = this.createChamberRig('coop', 0, -0.85, 0.85);
    this.redRig = this.createChamberRig('red', 0, 1.15, 0.67);
    this.blueRig = this.createChamberRig('blue', 0, -2.35, 0.67);
    this.redRig.root.visible = false;
    this.blueRig.root.visible = false;

    this.scene.add(this.coopRig.root, this.redRig.root, this.blueRig.root);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }

    this.startLoop();
    if (this.renderer) {
      void this.loadKayKitAssets();
    }
  }

  public isWebGLActive(): boolean {
    return this.renderer !== null;
  }

  public getVisibleChamberCount(): number {
    return (
      (this.coopRig.root.visible ? 1 : 0) +
      (this.redRig.root.visible ? 1 : 0) +
      (this.blueRig.root.visible ? 1 : 0)
    );
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private initRenderer(width: number, height: number): void {
    if (typeof document === 'undefined') return;
    try {
      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height, false);
      if (renderer.shadowMap) renderer.shadowMap.enabled = false;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      this.container.appendChild(renderer.domElement);
      this.renderer = renderer;
    } catch {
      this.renderer = null;
    }
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 1.5);
    const key = new THREE.DirectionalLight(0xfffbeb, 1.7);
    key.position.set(5, 13, 11);
    const rim = new THREE.DirectionalLight(0x93c5fd, 0.7);
    rim.position.set(-7, 6, 4);
    this.scene.add(hemi, key, rim);
  }

  private createStoneWallTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return null;

    ctx.fillStyle = '#64748b';
    ctx.fillRect(0, 0, 256, 256);

    const rows = 8;
    const rowH = 256 / rows;
    const cols = 4;
    const colW = 256 / cols;
    const tones = ['#cbd5e1', '#dde5ef', '#b6c2d2', '#d2dce8'];

    for (let r = 0; r < rows; r++) {
      const offset = r % 2 === 1 ? colW * 0.5 : 0;
      for (let c = -1; c <= cols; c++) {
        const bx = c * colW + offset + 3;
        const by = r * rowH + 3;
        const bw = colW - 6;
        const bh = rowH - 6;
        ctx.fillStyle = tones[(r * 3 + c + 4) % tones.length];
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(bx, by, bw, 3);
        ctx.fillStyle = '#475569';
        ctx.fillRect(bx, by + bh - 3, bw, 3);
      }
    }

    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private createFloorTileTexture(): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return null;

    ctx.fillStyle = '#475569';
    ctx.fillRect(0, 0, 256, 256);

    const grid = 4;
    const step = 256 / grid;
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        const tx = c * step + 3;
        const ty = r * step + 3;
        const size = step - 6;
        ctx.fillStyle = (r + c) % 2 === 0 ? '#d1d9e6' : '#bcc6d6';
        ctx.fillRect(tx, ty, size, size);
        ctx.strokeStyle = '#eef2f7';
        ctx.lineWidth = 2;
        ctx.strokeRect(tx + 2, ty + 2, size - 4, size - 4);
      }
    }

    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildSky(): void {
    this.skyMat = this.track(
      new THREE.ShaderMaterial({
        depthWrite: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x082f49) },
          uBottom: { value: new THREE.Color(0x0284c7) },
          uAccent: { value: new THREE.Color(0x38bdf8) },
          uTime: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uTop;
          uniform vec3 uBottom;
          uniform vec3 uAccent;
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            vec3 grad = mix(uBottom, uTop, vUv.y);
            float dist = length(vUv - vec2(0.5, 0.48));
            float halo = smoothstep(0.65, 0.0, dist);
            float ray = 0.5 + 0.5 * sin((vUv.x * 11.0 + vUv.y * 4.5) - uTime * 0.45);
            float vignette = smoothstep(0.92, 0.25, length(vUv - vec2(0.5, 0.5)));
            vec3 col = grad * (0.42 + 0.58 * vignette) + uAccent * (halo * 0.24 + ray * halo * 0.08);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
    );
    const sky = new THREE.Mesh(this.track(new THREE.PlaneGeometry(55, 45)), this.skyMat);
    sky.position.set(0, 4, -15);
    this.scene.add(sky);

    // Floating atmospheric ember / dust motes around the dungeon
    const particleCount = 70;
    const positions = new Float32Array(particleCount * 3);
    for (let i = 0; i < particleCount; i++) {
      const h1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin((i + 17) * 78.233) * 43758.5453) % 1;
      const h3 = Math.abs(Math.sin((i + 53) * 39.346) * 43758.5453) % 1;
      positions[i * 3] = (h1 - 0.5) * 9.0;
      positions[i * 3 + 1] = -3.5 + h2 * 8.0;
      positions[i * 3 + 2] = -4.0 + h3 * 7.5;
    }
    const pGeo = this.track(new THREE.BufferGeometry());
    pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.ambientParticleMat = this.track(
      new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.11, transparent: true, opacity: 0.65 })
    );
    this.ambientParticles = new THREE.Points(pGeo, this.ambientParticleMat);
    this.scene.add(this.ambientParticles);
  }

  private createLabelSlot(scaleX: number, scaleY: number): LabelSlot {
    const canvas =
      typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
    canvas.width = 512;
    canvas.height = 128;
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    const texture = this.track(new THREE.CanvasTexture(canvas));
    texture.minFilter = THREE.LinearFilter;
    const mat = this.track(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(scaleX, scaleY, 1);
    sprite.renderOrder = 25;
    return { sprite, canvas, ctx, texture, lastKey: '' };
  }

  private drawLabelSlot(slot: LabelSlot, text: string, bg: string, border = '#ffffff66'): void {
    const key = `${text}|${bg}|${border}`;
    if (slot.lastKey === key || !slot.ctx) return;
    slot.lastKey = key;

    const { ctx, canvas } = slot;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 30px "Segoe UI", system-ui, sans-serif';
    const clippedText = text.slice(0, 24);
    const measured = typeof ctx.measureText === 'function' ? ctx.measureText(clippedText).width : 260;
    const pillW = Math.min(canvas.width - 24, Math.max(170, measured + 52));
    const pillX = (canvas.width - pillW) / 2;
    const pillY = 22;
    const pillH = canvas.height - 44;

    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 4;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 22);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(pillX, pillY, pillW, pillH);
      ctx.strokeRect(pillX, pillY, pillW, pillH);
    }

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clippedText, canvas.width / 2, canvas.height / 2, pillW - 28);
    slot.texture.needsUpdate = true;
  }

  private createChamberRig(team: TeamId, offsetX: number, offsetY: number, scale: number): ChamberRig {
    const root = new THREE.Group();
    root.position.set(offsetX, offsetY, 0);
    root.scale.setScalar(scale);

    const floorGroup = new THREE.Group();
    root.add(floorGroup);

    const wallMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x164e63,
        roughness: 0.78,
        ...(this.wallBrickTex ? { map: this.wallBrickTex } : {}),
      })
    );
    const trimMat = this.track(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 }));
    const brassMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.35, roughness: 0.4 })
    );
    const floorMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0e7490,
        roughness: 0.85,
        ...(this.floorTileTex ? { map: this.floorTileTex } : {}),
      })
    );

    // Floor slab + recessed carpet + brass edge runners
    const slab = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.4, 0.35, 7.2)), floorMat);
    slab.position.y = -0.18;
    const carpetMat = this.track(
      new THREE.MeshStandardMaterial({
        color: team === 'blue' ? 0x2563eb : team === 'red' ? 0xdc2626 : 0xb45309,
        roughness: 0.8,
      })
    );
    const carpet = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.5, 0.04, 5.2)), carpetMat);
    carpet.position.set(0, 0.02, 0.8);
    const runnerGeo = this.track(new THREE.BoxGeometry(0.08, 0.045, 5.2));
    const runnerL = new THREE.Mesh(runnerGeo, brassMat);
    runnerL.position.set(-0.76, 0.022, 0.8);
    const runnerR = new THREE.Mesh(runnerGeo, brassMat);
    runnerR.position.set(0.76, 0.022, 0.8);
    floorGroup.add(slab, carpet, runnerL, runnerR);

    // Cutaway under-floor foundation & trap pit anchored to root
    const pitMat = this.track(new THREE.MeshStandardMaterial({ color: 0x020617, roughness: 0.9 }));
    const pitBottom = new THREE.Mesh(this.track(new THREE.BoxGeometry(5.9, 0.18, 7.0)), pitMat);
    pitBottom.position.set(0, -0.82, 0);
    const pillarL = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.32, 0.72, 7.2)), trimMat);
    pillarL.position.set(-3.04, -0.48, 0);
    const pillarR = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.32, 0.72, 7.2)), trimMat);
    pillarR.position.set(3.04, -0.48, 0);
    const fasciaColor = team === 'red' ? 0xe11d48 : team === 'blue' ? 0x0284c7 : 0xd97706;
    const frontFascia = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(6.44, 0.26, 0.24)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: fasciaColor,
          emissive: fasciaColor,
          emissiveIntensity: 0.35,
          roughness: 0.4,
        })
      )
    );
    frontFascia.position.set(0, -0.18, 3.55);
    root.add(pitBottom, pillarL, pillarR, frontFascia);

    // Cutaway back & side walls + architectural crown cornices, wainscot, corner pillars & ribs
    const backWall = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.4, 3.0, 0.32)), wallMat);
    backWall.position.set(0, 1.48, -3.45);
    const sideL = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.3, 3.0, 7.2)), wallMat);
    sideL.position.set(-3.05, 1.48, 0);
    const sideR = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.3, 3.0, 7.2)), wallMat);
    sideR.position.set(3.05, 1.48, 0);
    floorGroup.add(backWall, sideL, sideR);

    // Top crown cornices & lower wainscot baseboards
    const crownBack = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.56, 0.22, 0.44)), trimMat);
    crownBack.position.set(0, 3.02, -3.45);
    const crownSideGeo = this.track(new THREE.BoxGeometry(0.44, 0.22, 7.3));
    const crownL = new THREE.Mesh(crownSideGeo, trimMat);
    crownL.position.set(-3.05, 3.02, 0);
    const crownR = new THREE.Mesh(crownSideGeo, trimMat);
    crownR.position.set(3.05, 3.02, 0);

    const baseBack = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.3, 0.28, 0.38)), trimMat);
    baseBack.position.set(0, 0.14, -3.43);
    const baseSideGeo = this.track(new THREE.BoxGeometry(0.38, 0.28, 7.1));
    const baseL = new THREE.Mesh(baseSideGeo, trimMat);
    baseL.position.set(-3.03, 0.14, 0);
    const baseR = new THREE.Mesh(baseSideGeo, trimMat);
    baseR.position.set(3.03, 0.14, 0);
    floorGroup.add(crownBack, crownL, crownR, baseBack, baseL, baseR);

    // 4 Corner Stone Columns + Capital Caps
    const colGeo = this.track(new THREE.BoxGeometry(0.46, 3.28, 0.46));
    const capGeo = this.track(new THREE.BoxGeometry(0.58, 0.18, 0.58));
    for (const [cx, cz] of [
      [-3.05, -3.45],
      [3.05, -3.45],
      [-3.05, 3.48],
      [3.05, 3.48],
    ]) {
      const col = new THREE.Mesh(colGeo, trimMat);
      col.position.set(cx, 1.56, cz);
      const cap = new THREE.Mesh(capGeo, trimMat);
      cap.position.set(cx, 3.22, cz);
      floorGroup.add(col, cap);
    }

    // Vertical wall buttresses (2 back wall, 2 left wall, 2 right wall)
    const backRibGeo = this.track(new THREE.BoxGeometry(0.24, 2.8, 0.18));
    for (const bx of [-1.75, 1.75]) {
      const rib = new THREE.Mesh(backRibGeo, trimMat);
      rib.position.set(bx, 1.5, -3.32);
      floorGroup.add(rib);
    }
    const sideRibGeo = this.track(new THREE.BoxGeometry(0.18, 2.8, 0.24));
    for (const sx of [-2.92, 2.92]) {
      for (const sz of [-1.15, 1.15]) {
        const rib = new THREE.Mesh(sideRibGeo, trimMat);
        rib.position.set(sx, 1.5, sz);
        floorGroup.add(rib);
      }
    }

    // 4 Flickering Wall Torches
    const torchMats: THREE.MeshStandardMaterial[] = [];
    const bracketGeo = this.track(new THREE.BoxGeometry(0.12, 0.32, 0.12));
    const flameGeo = this.track(new THREE.OctahedronGeometry(0.14, 0));
    for (const [tx, ty, tz] of [
      [-1.28, 1.65, -3.22],
      [1.28, 1.65, -3.22],
      [-2.84, 1.65, 0.1],
      [2.84, 1.65, 0.1],
    ]) {
      const bracket = new THREE.Mesh(bracketGeo, trimMat);
      bracket.position.set(tx, ty, tz);
      const flameMat = this.track(
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0xf97316,
          emissiveIntensity: 1.4,
          roughness: 0.3,
        })
      );
      const flame = new THREE.Mesh(flameGeo, flameMat);
      flame.position.set(tx, ty + 0.24, tz);
      floorGroup.add(bracket, flame);
      torchMats.push(flameMat);
    }

    // Vault Door Frame + Lintel + Dark Vault Backing + Hidden Golden Treasure Chest + Swinging Door + Wheel
    const frame = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.8, 2.22, 0.28)), trimMat);
    frame.position.set(0, 1.11, -3.2);
    const lintel = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.15, 0.24, 0.38)), trimMat);
    lintel.position.set(0, 2.26, -3.18);
    const vaultBacking = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.44, 1.92, 0.05)),
      this.track(new THREE.MeshBasicMaterial({ color: 0x020617 }))
    );
    vaultBacking.position.set(0, 1.02, -3.24);
    floorGroup.add(frame, lintel, vaultBacking);

    const vaultChestGroup = new THREE.Group();
    vaultChestGroup.position.set(0, 0.22, -3.08);
    const chestBase = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.62, 0.36, 0.3)), brassMat);
    const chestLid = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.64, 0.18, 0.32)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0xd97706,
          emissiveIntensity: 0.65,
          roughness: 0.35,
        })
      )
    );
    chestLid.position.y = 0.25;
    const chestClasp = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.12, 0.16, 0.34)),
      this.track(new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfacc15, emissiveIntensity: 0.5 }))
    );
    chestClasp.position.y = 0.18;
    vaultChestGroup.add(chestBase, chestLid, chestClasp);
    floorGroup.add(vaultChestGroup);

    const doorLeaf = new THREE.Group();
    doorLeaf.position.set(-0.74, 1.02, -2.92);
    const doorMesh = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.48, 1.94, 0.12)),
      this.track(new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.45, roughness: 0.35 }))
    );
    doorMesh.position.set(0.74, 0, 0);
    const doorWheel = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.24, 0.04, 8, 16)), brassMat);
    doorWheel.position.set(0.74, 0, 0.08);
    doorLeaf.add(doorMesh, doorWheel);
    floorGroup.add(doorLeaf);

    const lockCrystalMats: [
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
    ] = [
      this.track(new THREE.MeshStandardMaterial({ color: 0xf43f5e, emissive: 0xe11d48, emissiveIntensity: 0.9 })),
      this.track(new THREE.MeshStandardMaterial({ color: 0xf43f5e, emissive: 0xe11d48, emissiveIntensity: 0.9 })),
      this.track(new THREE.MeshStandardMaterial({ color: 0xf43f5e, emissive: 0xe11d48, emissiveIntensity: 0.9 })),
    ];
    const crystalGeo = this.track(new THREE.OctahedronGeometry(0.18, 0));
    for (let i = 0; i < 3; i++) {
      const cry = new THREE.Mesh(crystalGeo, lockCrystalMats[i]);
      cry.position.set(-0.48 + i * 0.48, 2.42, -3.05);
      floorGroup.add(cry);
    }

    // 4-Step L/R Memory Bridge Tiles in front of the Vault Door
    const bridgeTiles: Array<{ L: THREE.MeshStandardMaterial; R: THREE.MeshStandardMaterial }> = [];
    const tileGeo = this.track(new THREE.BoxGeometry(0.56, 0.08, 0.42));
    for (let step = 0; step < 4; step++) {
      const matL = this.track(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5 }));
      const matR = this.track(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5 }));
      const tileL = new THREE.Mesh(tileGeo, matL);
      const tileR = new THREE.Mesh(tileGeo, matR);
      const tz = -0.55 - step * 0.56;
      tileL.position.set(-0.46, 0.06, tz);
      tileR.position.set(0.46, 0.06, tz);
      floorGroup.add(tileL, tileR);
      bridgeTiles.push({ L: matL, R: matR });
    }

    // 6 Searchable Props with Beacons & Floating Labels
    const corners: PropCorner[] = ['nw', 'ne', 'mw', 'me', 'sw', 'se'];
    const props: PropVisual[] = corners.map((corner, idx) => {
      const [px, pz] = CORNER_COORDS[corner];
      const pGroup = new THREE.Group();
      pGroup.position.set(px, 0.02, pz);

      const pedMat = this.track(
        new THREE.MeshStandardMaterial({
          color: 0xfbbf24,
          emissive: 0xd97706,
          emissiveIntensity: 0.45,
          roughness: 0.4,
        })
      );
      const ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.36, 0.045, 8, 24)), pedMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05;

      const meshHolder = new THREE.Group();
      const fallbackCrate = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(0.42, 0.42, 0.42)),
        this.track(
          new THREE.MeshStandardMaterial({
            color: idx % 2 === 0 ? 0xd97706 : 0x7c3aed,
            roughness: 0.65,
          })
        )
      );
      fallbackCrate.position.y = 0.22;
      meshHolder.add(fallbackCrate);

      const label = this.createLabelSlot(1.3, 0.32);
      label.sprite.position.set(0, 0.98, 0);
      pGroup.add(ring, meshHolder, label.sprite);
      floorGroup.add(pGroup);
      return { group: pGroup, beaconMat: pedMat, meshHolder, label, corner };
    });

    // Spotlight Hero standing at the lock
    const spotlightHolder = new THREE.Group();
    spotlightHolder.position.set(0, 0.04, 0.25);
    const shieldRingMat = this.track(
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    const spotlightShieldRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(0.18, 0.25, 24)),
      shieldRingMat
    );
    spotlightShieldRing.rotation.x = -Math.PI / 2;
    spotlightShieldRing.position.y = 0.04;
    spotlightShieldRing.visible = false;

    const spotlightLabel = this.createLabelSlot(1.25, 0.3);
    spotlightLabel.sprite.position.set(0, 0.82, 0);
    spotlightHolder.add(spotlightShieldRing, spotlightLabel.sprite);
    this.mountFallbackHeroMesh(spotlightHolder, 0xfbbf24);
    floorGroup.add(spotlightHolder);

    const giftLabel = this.createLabelSlot(1.65, 0.38);
    giftLabel.sprite.visible = false;
    const giftRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(0.22, 0.34, 24)),
      this.track(
        new THREE.MeshBasicMaterial({
          color: 0xfbbf24,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
        })
      )
    );
    giftRing.rotation.x = -Math.PI / 2;
    giftRing.visible = false;
    floorGroup.add(giftLabel.sprite, giftRing);

    // 24 Tiny Roaming Crowd Adventurers
    const queueHolders: THREE.Group[] = [];
    const queueWalkers: CrowdWalkerState[] = [];
    for (let i = 0; i < MAX_CROWD_AVATARS; i++) {
      const qh = new THREE.Group();
      const startPos = pickWalkerTarget(i, 1);
      const nextTarget = pickWalkerTarget(i, 2);
      qh.position.set(startPos.x, 0.04, startPos.z);
      qh.scale.setScalar(1.0);
      qh.visible = false;
      this.mountFallbackHeroMesh(qh, 0x60a5fa);
      floorGroup.add(qh);
      queueHolders.push(qh);
      queueWalkers.push({
        x: startPos.x,
        z: startPos.z,
        targetX: nextTarget.x,
        targetZ: nextTarget.z,
        speed: 1.05 + (i % 5) * 0.16,
        pauseSec: (i % 4) * 0.25,
        phase: i * 1.37,
        visitIdx: 3,
      });
    }

    // Rising Hazard Fluid Plane (Water / Lava / Mist)
    const hazardMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0ea5e9,
        emissive: 0x0369a1,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.58,
        roughness: 0.2,
      })
    );
    const hazardMesh = new THREE.Mesh(this.track(new THREE.PlaneGeometry(6.1, 6.9)), hazardMat);
    hazardMesh.rotation.x = -Math.PI / 2;
    hazardMesh.position.set(0, -0.32, 0);
    root.add(hazardMesh);

    // Rival Blackout Curtain
    const blackoutMesh = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(6.3, 3.1, 7.1)),
      this.track(
        new THREE.MeshBasicMaterial({
          color: 0x020617,
          transparent: true,
          opacity: 0.82,
        })
      )
    );
    blackoutMesh.position.set(0, 1.5, 0);
    blackoutMesh.visible = false;
    root.add(blackoutMesh);

    return {
      team,
      root,
      floorGroup,
      wallMats: [wallMat],
      floorMat,
      torchMats,
      doorLeaf,
      vaultChestGroup,
      lockCrystalMats,
      hazardMesh,
      hazardMat,
      blackoutMesh,
      bridgeTiles,
      props,
      giftLabel,
      giftRing,
      spotlightHolder,
      spotlightLabel,
      spotlightUser: null,
      spotlightClass: null,
      spotlightMixer: null,
      spotlightShieldRing,
      queueHolders,
      queueWalkers,
      queueUsers: Array(MAX_CROWD_AVATARS).fill(null) as Array<string | null>,
      queueMixers: Array(MAX_CROWD_AVATARS).fill(null) as Array<THREE.AnimationMixer | null>,
    };
  }

  private mountFallbackHeroMesh(holder: THREE.Group, bodyColor: number): void {
    const tagMesh = holder.children.find((c) => c.userData?.isHeroModel);
    if (tagMesh) holder.remove(tagMesh);

    const g = new THREE.Group();
    g.userData.isHeroModel = true;
    g.scale.setScalar(0.32);
    const body = new THREE.Mesh(
      this.track(new THREE.CapsuleGeometry(0.18, 0.28, 6, 12)),
      this.track(new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.6 }))
    );
    body.position.y = 0.32;
    const head = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.22, 14, 12)),
      this.track(new THREE.MeshStandardMaterial({ color: 0xfde6d8, roughness: 0.55 }))
    );
    head.position.y = 0.72;
    g.add(body, head);
    holder.add(g);
  }

  private async loadKayKitAssets(): Promise<void> {
    const loader = new GLTFLoader();
    const safeLoad = async (url: string) => {
      try {
        const gltf = await loader.loadAsync(url);
        if (this.disposed) return null;
        gltf.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            m.castShadow = false;
            m.receiveShadow = false;
            this.track(m.geometry);
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              if (!mat) continue;
              this.track(mat);
              const std = mat as THREE.MeshStandardMaterial;
              if (std.map) {
                std.map.colorSpace = THREE.SRGBColorSpace;
                this.track(std.map);
              }
            }
          }
        });
        return gltf;
      } catch {
        return null;
      }
    };

    const [knight, wizard, rogue, bard, market, smith, tavern, rock] = await Promise.all([
      safeLoad('/models/characters/Knight.glb'),
      safeLoad('/models/characters/Mage.glb'),
      safeLoad('/models/characters/Rogue_Hooded.glb'),
      safeLoad('/models/characters/Barbarian.glb'),
      safeLoad('/models/world/building_market_blue.gltf'),
      safeLoad('/models/world/building_blacksmith_blue.gltf'),
      safeLoad('/models/world/building_tavern_blue.gltf'),
      safeLoad('/models/world/rock_single_A.gltf'),
    ]);
    if (this.disposed) return;

    if (knight) this.classTemplates.set('knight', { scene: knight.scene, animations: knight.animations });
    if (wizard) this.classTemplates.set('wizard', { scene: wizard.scene, animations: wizard.animations });
    if (rogue) this.classTemplates.set('rogue', { scene: rogue.scene, animations: rogue.animations });
    if (bard) this.classTemplates.set('bard', { scene: bard.scene, animations: bard.animations });

    this.worldPropTemplates = [market?.scene, smith?.scene, tavern?.scene, rock?.scene].filter(
      (g): g is THREE.Group => Boolean(g)
    );

    if (this.worldPropTemplates.length > 0) {
      for (const rig of [this.coopRig, this.redRig, this.blueRig]) {
        rig.props.forEach((pv, idx) => {
          const tpl = this.worldPropTemplates[idx % this.worldPropTemplates.length];
          pv.meshHolder.clear();
          const clone = tpl.clone(true);
          clone.scale.setScalar(0.38);
          pv.meshHolder.add(clone);
        });
      }
    }

    // Re-sync current heroes with freshly loaded .glb rigs
    if (this.latestSnapshot) {
      this.applySnapshotModels(this.latestSnapshot);
    }
  }

  private swapHeroModel(
    holder: THREE.Group,
    cls: HeroClass,
    scale: number,
    prevMixer: THREE.AnimationMixer | null,
    preferWalkClip = false
  ): THREE.AnimationMixer | null {
    prevMixer?.stopAllAction();
    const existing = holder.children.find((c) => c.userData?.isHeroModel);
    if (existing) holder.remove(existing);

    const tpl = this.classTemplates.get(cls) ?? this.classTemplates.values().next().value;
    if (!tpl) {
      this.mountFallbackHeroMesh(holder, 0x38bdf8);
      return null;
    }

    const clone = SkeletonUtils.clone(tpl.scene);
    clone.userData.isHeroModel = true;
    clone.scale.setScalar(scale);
    clone.rotation.y = Math.PI; // Face toward the back Vault Door / lock!
    holder.add(clone);

    const clip = pickClip(
      tpl.animations,
      preferWalkClip
        ? ['running_a', 'walking_a', 'run', 'walk', 'idle_a', 'idle']
        : ['idle_a', 'idle']
    );
    if (!clip) return null;
    const mixer = new THREE.AnimationMixer(clone);
    mixer.clipAction(clip).play();
    return mixer;
  }

  public updateSnapshot(snapshot: RoomSnapshotMessage): void {
    this.latestSnapshot = snapshot;

    // 1. Switch single vs twin-room layout
    if (this.currentMode !== snapshot.activeMode) {
      this.currentMode = snapshot.activeMode;
      const isCoop = snapshot.activeMode === 'coop';
      this.coopRig.root.visible = isCoop;
      this.redRig.root.visible = !isCoop;
      this.blueRig.root.visible = !isCoop;
      if (isCoop) {
        this.camera.position.set(0, 8.8, 11.4);
        this.camera.lookAt(0, 0.45, 0.15);
      } else {
        this.camera.position.set(0, 3.8, 16.4);
        this.camera.lookAt(0, -0.05, 0);
      }
    }

    // 2. Apply rotating room theme palette
    if (this.currentThemeId !== snapshot.theme.id) {
      this.currentThemeId = snapshot.theme.id;
      this.skyMat.uniforms.uTop.value.setHex(snapshot.theme.ambientSkyTop);
      this.skyMat.uniforms.uBottom.value.setHex(snapshot.theme.ambientSkyBottom);
      this.skyMat.uniforms.uAccent.value.setHex(snapshot.theme.hazardColor);
      this.ambientParticleMat?.color.setHex(snapshot.theme.hazardColor);
      for (const rig of [this.coopRig, this.redRig, this.blueRig]) {
        for (const wm of rig.wallMats) wm.color.setHex(snapshot.theme.wallColor);
        rig.floorMat.color.setHex(snapshot.theme.floorColor);
        rig.hazardMat.color.setHex(snapshot.theme.hazardColor);
        rig.hazardMat.emissive.setHex(snapshot.theme.hazardColor);
      }
    }

    this.applySnapshotModels(snapshot);
  }

  private applySnapshotModels(snapshot: RoomSnapshotMessage): void {
    this.updateChamberRig(this.coopRig, snapshot.chambers.coop, snapshot);
    this.updateChamberRig(this.redRig, snapshot.chambers.red, snapshot);
    this.updateChamberRig(this.blueRig, snapshot.chambers.blue, snapshot);
  }

  private updateChamberRig(
    rig: ChamberRig,
    state: ChamberPublicState | undefined,
    snapshot: RoomSnapshotMessage
  ): void {
    if (!state) return;

    // Vault locks & door open state
    for (let i = 0; i < 3; i++) {
      const unlocked = snapshot.phase === 'getaway' || state.lockStage > i + 1;
      rig.lockCrystalMats[i].color.setHex(unlocked ? 0x34d399 : 0xf43f5e);
      rig.lockCrystalMats[i].emissive.setHex(unlocked ? 0x10b981 : 0xe11d48);
    }

    // Bridge revealed safe tiles (emerald) & active run progress (sky blue)
    for (let s = 0; s < 4; s++) {
      const safe = state.revealedSteps[s];
      if (safe === 'L' || safe === 'R') {
        rig.bridgeTiles[s].L.color.setHex(safe === 'L' ? 0x34d399 : 0x64748b);
        rig.bridgeTiles[s].R.color.setHex(safe === 'R' ? 0x34d399 : 0x64748b);
      } else if (s < state.bridgeStep) {
        rig.bridgeTiles[s].L.color.setHex(0x38bdf8);
        rig.bridgeTiles[s].R.color.setHex(0x38bdf8);
      } else {
        rig.bridgeTiles[s].L.color.setHex(0x64748b);
        rig.bridgeTiles[s].R.color.setHex(0x64748b);
      }
    }

    // Shuffled 6 props + trap/clue/UV glowing beacon status
    for (let i = 0; i < Math.min(rig.props.length, state.props.length); i++) {
      const pv = rig.props[i];
      const propData = state.props[i];
      const [px, pz] = CORNER_COORDS[propData.corner];
      pv.group.position.set(px, 0.02, pz);
      const found = Boolean(propData.searchedBy);
      if (found && propData.isTrap) {
        pv.beaconMat.color.setHex(0xf43f5e);
        pv.beaconMat.emissive.setHex(0xe11d48);
        this.drawLabelSlot(pv.label, `${propData.emoji} TRAP!`, 'rgba(127, 29, 29, 0.92)', '#fb7185');
      } else if (found) {
        pv.beaconMat.color.setHex(0x34d399);
        pv.beaconMat.emissive.setHex(0x10b981);
        this.drawLabelSlot(pv.label, `${propData.emoji} CLUE`, 'rgba(6, 78, 59, 0.9)', '#34d399');
      } else {
        pv.beaconMat.color.setHex(propData.uvOnly ? 0xc084fc : 0xfbbf24);
        pv.beaconMat.emissive.setHex(propData.uvOnly ? 0x9333ea : 0xd97706);
        this.drawLabelSlot(
          pv.label,
          `${propData.emoji} ${propData.name.toUpperCase()}`,
          'rgba(15, 23, 42, 0.9)',
          propData.uvOnly ? '#c084fc' : '#fbbf24'
        );
      }
    }

    // Spotlight character
    if (state.spotlightPlayer) {
      rig.spotlightHolder.visible = true;
      const cls = state.spotlightClass || pickClassForName(state.spotlightPlayer);
      if (rig.spotlightUser !== state.spotlightPlayer || rig.spotlightClass !== cls) {
        rig.spotlightUser = state.spotlightPlayer;
        rig.spotlightClass = cls;
        rig.spotlightMixer = this.swapHeroModel(rig.spotlightHolder, cls, 0.24, rig.spotlightMixer, true);
      }
      const shielded = state.shieldedPlayers.includes(state.spotlightPlayer);
      rig.spotlightShieldRing.visible = shielded;
      this.drawLabelSlot(
        rig.spotlightLabel,
        shielded ? `🛡️ ${state.spotlightPlayer}` : `🎯 ${state.spotlightPlayer}`,
        'rgba(180, 83, 9, 0.94)',
        '#fde047'
      );
    } else {
      rig.spotlightHolder.visible = false;
    }

    // 24 Tiny Roaming Crowd Gallery
    for (let q = 0; q < MAX_CROWD_AVATARS; q++) {
      const qUser = state.upNext[q] ?? null;
      const qh = rig.queueHolders[q];
      if (!qUser) {
        qh.visible = false;
        continue;
      }
      qh.visible = true;
      if (rig.queueUsers[q] !== qUser) {
        rig.queueUsers[q] = qUser;
        rig.queueMixers[q] = this.swapHeroModel(
          qh,
          pickClassForName(qUser),
          0.18,
          rig.queueMixers[q],
          true
        );
      }
    }

    // Blackout overlay
    rig.blackoutMesh.visible = state.blackoutUntilMs > Date.now();
  }

  public resize(explicitW?: number, explicitH?: number): void {
    const w = explicitW ?? (this.container.clientWidth || 540);
    const h = explicitH ?? (this.container.clientHeight || 960);
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h, false);
  }

  private startLoop(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    this.lastFrameMs = performance.now();

    const tick = (rafNow: number) => {
      if (this.disposed) return;
      const dtSec = Math.min(0.05, Math.max(0, (rafNow - this.lastFrameMs) / 1000));
      this.lastFrameMs = rafNow;
      this.elapsedSec += dtSec;

      this.animateScene(dtSec);
      this.renderer?.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private animateScene(dtSec: number): void {
    const t = this.elapsedSec;
    const snap = this.latestSnapshot;
    const nowMs = Date.now();

    const anyWin =
      snap?.phase === 'getaway' ||
      (snap?.winnerTeam !== null && snap?.winnerTeam !== undefined);
    this.skyMat.uniforms.uTime.value = t;
    if (this.ambientParticles) {
      this.ambientParticles.rotation.y = t * (anyWin ? 0.35 : 0.08);
      this.ambientParticles.position.y = Math.sin(t * (anyWin ? 1.8 : 0.5)) * 0.25;
      if (anyWin) {
        this.ambientParticleMat?.color.setHex(0xfbbf24);
      } else if (snap?.theme) {
        this.ambientParticleMat?.color.setHex(snap.theme.hazardColor);
      }
    }

    let giftFocusX = 0;
    let giftFocusY = 0;
    let giftFocusZ = 0;
    let hasGiftFocus = false;
    let latestGiftAt = 0;

    for (const rig of [this.coopRig, this.redRig, this.blueRig]) {
      if (!rig.root.visible) continue;
      rig.spotlightMixer?.update(dtSec);
      for (const qm of rig.queueMixers) qm?.update(dtSec);

      const chamber =
        rig.team === 'coop'
          ? snap?.chambers.coop
          : rig.team === 'red'
            ? snap?.chambers.red
            : snap?.chambers.blue;

      const isChamberWin =
        snap?.phase === 'getaway' || (snap?.winnerTeam !== null && snap?.winnerTeam === rig.team);
      const isChamberLoss =
        snap?.loserPitTeam === rig.team || (snap?.phase === 'round_over' && snap?.winnerTeam === null);

      // Slow turntable rotation & gentle 3D sway/tilt on the room diorama
      const phaseOffset = rig.team === 'blue' ? 0.85 : 0;
      rig.root.rotation.y = Math.sin(t * 0.48 + phaseOffset) * 0.18;
      rig.root.rotation.x = Math.cos(t * 0.36 + phaseOffset) * 0.045;
      rig.root.rotation.z = Math.sin(t * 0.3 + phaseOffset) * 0.024;

      // Flickering dungeon wall torches (crimson on loss, emerald/gold on win)
      rig.torchMats.forEach((tm, idx) => {
        tm.color.setHex(isChamberLoss ? 0xf43f5e : isChamberWin ? 0x34d399 : 0xfbbf24);
        tm.emissive.setHex(isChamberLoss ? 0xe11d48 : isChamberWin ? 0x10b981 : 0xf97316);
        tm.emissiveIntensity = (isChamberLoss ? 1.55 : 1.15) + Math.sin(t * 14 + idx * 2.1) * 0.35;
      });

      // Gentle float on unsearched prop meshes
      rig.props.forEach((pv, i) => {
        pv.meshHolder.rotation.y = Math.sin(t * 0.9 + i) * 0.12;
      });

      // Door swings open to reveal Golden Treasure Chest on Getaway or Victory!
      const targetDoorRot = isChamberWin ? -1.45 : 0;
      rig.doorLeaf.rotation.y += (targetDoorRot - rig.doorLeaf.rotation.y) * Math.min(1, dtSec * 8);
      rig.vaultChestGroup.rotation.y = Math.sin(t * 2.5) * 0.25;
      rig.vaultChestGroup.position.y = isChamberWin ? 0.26 + Math.abs(Math.sin(t * 6)) * 0.08 : 0.22;

      // Trapdoor pit collapse on Loss / losing Versus room
      const targetFloorY = isChamberLoss ? -0.82 : 0;
      rig.floorGroup.position.y += (targetFloorY - rig.floorGroup.position.y) * Math.min(1, dtSec * 6);

      // Calibrated rising hazard fluid plane (full flood on Loss)
      const ratio = isChamberLoss ? 1.0 : (snap?.hazardRatio ?? 0);
      rig.hazardMesh.position.y =
        -0.24 + ratio * 0.42 + Math.pow(ratio, 3) * 0.36 + Math.sin(t * 2.5) * 0.015;

      // Identify active gifter inside this chamber
      const activeGift =
        Boolean(chamber?.lastGiftPlayer) && nowMs - (chamber?.lastGiftAtMs ?? 0) < 2200;
      let giftHolder: THREE.Group | null = null;
      if (activeGift && chamber?.lastGiftPlayer) {
        if (rig.spotlightUser === chamber.lastGiftPlayer && rig.spotlightHolder.visible) {
          giftHolder = rig.spotlightHolder;
        } else {
          const qIdx = rig.queueUsers.findIndex((u, i) => u === chamber.lastGiftPlayer && rig.queueHolders[i]?.visible);
          giftHolder = qIdx >= 0 ? rig.queueHolders[qIdx] : rig.spotlightHolder.visible ? rig.spotlightHolder : null;
        }
      }

      // Spotlight hero animation (lock glance, bridge step, win cheer, loss tumble, gift highlight)
      const isZapped = chamber?.lastEffect === 'zap' && nowMs - chamber.lastEffectAtMs < 650;
      let spotTargetX = Math.sin(t * 2.2) * 0.22;
      let spotTargetZ = 0.2 + Math.cos(t * 1.8) * 0.08;
      if (isChamberWin) {
        spotTargetX = 0;
        spotTargetZ = -1.8;
      } else if (chamber?.lockStage === 3 && chamber.bridgeStep > 0) {
        spotTargetX = 0;
        spotTargetZ = -0.55 - (chamber.bridgeStep - 1) * 0.56;
      }
      const spotLerp = Math.min(1, dtSec * 5);
      const prevSpotX = rig.spotlightHolder.position.x;
      rig.spotlightHolder.position.x += (spotTargetX - prevSpotX) * spotLerp;
      rig.spotlightHolder.position.z += (spotTargetZ - rig.spotlightHolder.position.z) * spotLerp;

      if (giftHolder === rig.spotlightHolder) {
        rig.spotlightHolder.scale.setScalar(1.42);
        rig.spotlightHolder.rotation.set(0, Math.PI, 0);
        rig.spotlightHolder.position.y = 0.14 + Math.abs(Math.sin(t * 15)) * 0.14;
      } else {
        rig.spotlightHolder.scale.setScalar(1.0);
        if (isChamberLoss) {
          rig.spotlightHolder.rotation.x = -1.25;
          rig.spotlightHolder.rotation.z = Math.sin(t * 6) * 0.35;
          rig.spotlightHolder.position.y = 0.18 + Math.sin(t * 4) * 0.04;
        } else if (isChamberWin) {
          rig.spotlightHolder.rotation.set(0, Math.PI + Math.sin(t * 4) * 0.2, 0);
          rig.spotlightHolder.position.y = 0.08 + Math.abs(Math.sin(t * 13)) * 0.14;
        } else {
          rig.spotlightHolder.rotation.x = 0;
          rig.spotlightHolder.rotation.z = 0;
          const lookAtCamera = Math.sin(t * 1.45) > 0.3;
          const targetSpotYaw = lookAtCamera ? Math.PI * 0.88 : (spotTargetX - prevSpotX) * -0.8;
          rig.spotlightHolder.rotation.y +=
            (targetSpotYaw - rig.spotlightHolder.rotation.y) * Math.min(1, dtSec * 6);
          rig.spotlightHolder.position.y = isZapped
            ? 0.35 + Math.abs(Math.sin(t * 28)) * 0.45
            : 0.04 + Math.abs(Math.sin(t * 9)) * 0.04;
        }
      }

      // 24 Tiny Crowd Walkers: roaming, front-facing pauses, gift pop, win jump & loss tumble
      for (let q = 0; q < rig.queueHolders.length; q++) {
        const qh = rig.queueHolders[q];
        if (!qh.visible) continue;
        const w = rig.queueWalkers[q];

        if (giftHolder === qh) {
          qh.scale.setScalar(1.42);
          qh.rotation.set(0, Math.PI, 0);
          qh.position.set(w.x, 0.14 + Math.abs(Math.sin(t * 15)) * 0.14, w.z);
          continue;
        }
        qh.scale.setScalar(1.0);

        if (isChamberLoss) {
          qh.rotation.x = -1.25;
          qh.rotation.z = Math.sin(t * 6 + q) * 0.35;
          qh.position.set(w.x, 0.18 + Math.sin(t * 4 + q) * 0.04, w.z);
          continue;
        }

        if (isChamberWin) {
          const celebRot = Math.PI + Math.sin(t * 5 + q) * 0.25;
          qh.rotation.x = 0;
          qh.rotation.z = 0;
          qh.rotation.y += (celebRot - qh.rotation.y) * Math.min(1, dtSec * 8);
          qh.position.set(w.x, 0.08 + Math.abs(Math.sin(t * 13 + q * 0.7)) * 0.14, w.z);
          continue;
        }

        qh.rotation.x = 0;

        if (w.pauseSec > 0) {
          w.pauseSec -= dtSec;
          qh.rotation.z = 0;
          if ((q + w.visitIdx) % 3 !== 0) {
            const frontYaw = Math.PI + Math.sin(t * 3 + w.phase) * 0.22;
            qh.rotation.y += (frontYaw - qh.rotation.y) * Math.min(1, dtSec * 8);
            qh.position.set(w.x, 0.04 + Math.abs(Math.sin(t * 8 + w.phase)) * 0.045, w.z);
          } else {
            qh.position.set(w.x, 0.04 + Math.sin(t * 4 + w.phase) * 0.015, w.z);
          }
          continue;
        }

        const dx = w.targetX - w.x;
        const dz = w.targetZ - w.z;
        const dist = Math.hypot(dx, dz);

        if (dist < 0.1) {
          w.pauseSec = 0.45 + ((q * 7 + w.visitIdx) % 10) * 0.09;
          w.visitIdx++;
          const nextPt = pickWalkerTarget(q, w.visitIdx);
          w.targetX = nextPt.x;
          w.targetZ = nextPt.z;
          continue;
        }

        const moveStep = Math.min(dist, w.speed * dtSec);
        w.x += (dx / dist) * moveStep;
        w.z += (dz / dist) * moveStep;

        // Gentle personal-space separation from neighbors
        for (let other = 0; other < rig.queueHolders.length; other++) {
          if (other === q || !rig.queueHolders[other].visible) continue;
          const ow = rig.queueWalkers[other];
          const sx = w.x - ow.x;
          const sz = w.z - ow.z;
          const d2 = sx * sx + sz * sz;
          if (d2 > 0.0001 && d2 < 0.1024) {
            const d = Math.sqrt(d2);
            const push = (0.32 - d) * 0.45;
            w.x += (sx / d) * push;
            w.z += (sz / d) * push;
          }
        }

        w.x = Math.max(-2.5, Math.min(2.5, w.x));
        w.z = Math.max(-2.1, Math.min(3.05, w.z));
        if (Math.abs(w.x) < 0.72 && w.z < 0.38) {
          w.x = w.x < 0 ? -0.76 : 0.76;
          if (w.targetX * w.x < 0 && w.targetZ < 0.5) {
            w.targetZ = 1.65 + (q % 4) * 0.25;
          }
        }

        qh.position.set(w.x, 0.04 + Math.abs(Math.sin(t * 11 + w.phase)) * 0.055, w.z);
        qh.rotation.y = Math.atan2(-dx, -dz);
        qh.rotation.z = Math.sin(t * 11 + w.phase) * 0.07;
      }

      // Gift Halo & Floating Label
      if (activeGift && giftHolder && chamber?.lastGiftPlayer) {
        rig.giftRing.visible = true;
        rig.giftRing.position.set(giftHolder.position.x, 0.05, giftHolder.position.z);
        rig.giftLabel.sprite.visible = true;
        rig.giftLabel.sprite.position.set(
          giftHolder.position.x,
          giftHolder.position.y + 0.78,
          giftHolder.position.z
        );
        const tierLabel = (chamber.lastGiftTier ?? 'GIFT').replace('_', ' ').toUpperCase();
        this.drawLabelSlot(
          rig.giftLabel,
          `🎁 ${chamber.lastGiftPlayer} · ${tierLabel}!`,
          'rgba(109, 40, 217, 0.94)',
          '#fde047'
        );

        if (!isChamberLoss && (chamber.lastGiftAtMs ?? 0) >= latestGiftAt) {
          latestGiftAt = chamber.lastGiftAtMs ?? nowMs;
          hasGiftFocus = true;
          giftFocusX = rig.root.position.x + giftHolder.position.x * rig.root.scale.x;
          giftFocusY = rig.root.position.y + giftHolder.position.y * rig.root.scale.y;
          giftFocusZ = rig.root.position.z + giftHolder.position.z * rig.root.scale.z;
        }
      } else {
        rig.giftRing.visible = false;
        rig.giftLabel.sprite.visible = false;
      }
    }

    // Camera animation: Gift focus zoom vs smooth orbital sway, unlock zoom & zap shake
    const isCoop = this.currentMode === 'coop';
    const baseY = isCoop ? 8.8 : 3.8;
    const baseZ = isCoop ? 11.4 : 16.4;
    const lookY = isCoop ? 0.45 : -0.05;
    const lookZ = isCoop ? 0.15 : 0;

    const orbitX = Math.sin(t * 0.42) * (isCoop ? 0.85 : 0.75);
    const tiltY = Math.cos(t * 0.34) * 0.42;
    let zoomZ = Math.sin(t * 0.55) * (isCoop ? 0.78 : 0.65);

    const activeCh = isCoop ? snap?.chambers.coop : snap?.chambers.red;
    const recentUnlock =
      activeCh?.lastEffect === 'unlock' && nowMs - activeCh.lastEffectAtMs < 1300;
    if (snap?.phase === 'getaway' || recentUnlock) {
      zoomZ -= isCoop ? 1.25 : 0.9;
    }

    const anyZap = [snap?.chambers.coop, snap?.chambers.red, snap?.chambers.blue].some(
      (c) => c?.lastEffect === 'zap' && nowMs - c.lastEffectAtMs < 550
    );
    const shakeX = anyZap ? Math.sin(t * 58) * 0.16 : 0;
    const shakeY = anyZap ? Math.cos(t * 52) * 0.12 : 0;

    let targetCamX = orbitX + shakeX;
    let targetCamY = baseY + tiltY + shakeY;
    let targetCamZ = baseZ + zoomZ;
    let targetLookX = orbitX * 0.18;
    let targetLookY = lookY + tiltY * 0.15;
    let targetLookZ = lookZ;

    if (hasGiftFocus) {
      targetCamX = targetCamX * 0.3 + giftFocusX * 0.7;
      targetCamY = targetCamY * 0.3 + (giftFocusY + (isCoop ? 3.2 : 2.3)) * 0.7;
      targetCamZ = targetCamZ * 0.3 + (giftFocusZ + (isCoop ? 5.6 : 6.4)) * 0.7;
      targetLookX = giftFocusX * 0.65;
      targetLookY = giftFocusY + 0.25;
      targetLookZ = giftFocusZ * 0.65;
    }

    const camBlend = Math.min(1, dtSec * (hasGiftFocus ? 4.8 : 6.5));
    this.camera.position.x += (targetCamX - this.camera.position.x) * camBlend;
    this.camera.position.y += (targetCamY - this.camera.position.y) * camBlend;
    this.camera.position.z += (targetCamZ - this.camera.position.z) * camBlend;
    this.camLookAt.x += (targetLookX - this.camLookAt.x) * camBlend;
    this.camLookAt.y += (targetLookY - this.camLookAt.y) * camBlend;
    this.camLookAt.z += (targetLookZ - this.camLookAt.z) * camBlend;
    this.camera.lookAt(this.camLookAt);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();

    for (const rig of [this.coopRig, this.redRig, this.blueRig]) {
      rig.spotlightMixer?.stopAllAction();
      for (const qm of rig.queueMixers) qm?.stopAllAction();
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;

    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentElement === this.container) {
        this.renderer.domElement.remove();
      }
      this.renderer = null;
    }
  }
}
