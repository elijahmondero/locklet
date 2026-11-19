import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HERO_CLASSES } from '../shared/constants.js';
import type {
  ActiveMode,
  ChamberPublicState,
  HeroClass,
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
  corner: 'nw' | 'ne' | 'sw' | 'se';
}

interface ChamberRig {
  team: TeamId;
  root: THREE.Group;
  floorGroup: THREE.Group;
  wallMats: THREE.MeshStandardMaterial[];
  floorMat: THREE.MeshStandardMaterial;
  doorLeaf: THREE.Group;
  lockCrystalMats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  hazardMesh: THREE.Mesh;
  hazardMat: THREE.MeshStandardMaterial;
  blackoutMesh: THREE.Mesh;
  bridgeTiles: Array<{ L: THREE.MeshStandardMaterial; R: THREE.MeshStandardMaterial }>;
  props: PropVisual[];
  spotlightHolder: THREE.Group;
  spotlightLabel: LabelSlot;
  spotlightUser: string | null;
  spotlightClass: HeroClass | null;
  spotlightMixer: THREE.AnimationMixer | null;
  spotlightShieldRing: THREE.Mesh;
  queueHolders: THREE.Group[];
  queueUsers: Array<string | null>;
  queueMixers: Array<THREE.AnimationMixer | null>;
}

const CORNER_COORDS: Record<'nw' | 'ne' | 'sw' | 'se', [number, number]> = {
  nw: [-2.15, -1.65],
  ne: [2.15, -1.65],
  sw: [-2.25, 1.35],
  se: [2.25, 1.35],
};

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

  private currentMode: ActiveMode = 'coop';
  private currentThemeId = '';
  private latestSnapshot: RoomSnapshotMessage | null = null;

  private readonly coopRig: ChamberRig;
  private readonly redRig: ChamberRig;
  private readonly blueRig: ChamberRig;

  private readonly classTemplates = new Map<HeroClass, GlbTemplate>();
  private worldPropTemplates: THREE.Group[] = [];

  constructor(container: HTMLElement, options: { width?: number; height?: number } = {}) {
    this.container = container;
    const width = options.width || container.clientWidth || 540;
    const height = options.height || container.clientHeight || 960;

    this.camera = new THREE.PerspectiveCamera(48, 9 / 16, 0.1, 120);
    this.camera.position.set(0, 7.6, 15.8);
    this.camera.lookAt(0, 0.85, 0);

    this.initRenderer(width, height);
    this.buildLights();
    this.buildSky();

    this.coopRig = this.createChamberRig('coop', 0, 1.0);
    this.redRig = this.createChamberRig('red', -2.65, 0.62);
    this.blueRig = this.createChamberRig('blue', 2.65, 0.62);
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

  private buildSky(): void {
    this.skyMat = this.track(
      new THREE.ShaderMaterial({
        depthWrite: false,
        uniforms: {
          uTop: { value: new THREE.Color(0x082f49) },
          uBottom: { value: new THREE.Color(0x0284c7) },
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
          varying vec2 vUv;
          void main() {
            gl_FragColor = vec4(mix(uBottom, uTop, vUv.y), 1.0);
          }
        `,
      })
    );
    const sky = new THREE.Mesh(this.track(new THREE.PlaneGeometry(55, 45)), this.skyMat);
    sky.position.set(0, 4, -15);
    this.scene.add(sky);
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
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 5;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(12, 16, canvas.width - 24, canvas.height - 32, 26);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(12, 16, canvas.width - 24, canvas.height - 32);
      ctx.strokeRect(12, 16, canvas.width - 24, canvas.height - 32);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 26), canvas.width / 2, canvas.height / 2, canvas.width - 48);
    slot.texture.needsUpdate = true;
  }

  private createChamberRig(team: TeamId, offsetX: number, scale: number): ChamberRig {
    const root = new THREE.Group();
    root.position.set(offsetX, 0, 0);
    root.scale.setScalar(scale);

    const floorGroup = new THREE.Group();
    root.add(floorGroup);

    const wallMat = this.track(new THREE.MeshStandardMaterial({ color: 0x164e63, roughness: 0.78 }));
    const trimMat = this.track(new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 }));
    const floorMat = this.track(new THREE.MeshStandardMaterial({ color: 0x0e7490, roughness: 0.85 }));

    // Floor slab + recessed carpet
    const slab = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.4, 0.35, 5.8)), floorMat);
    slab.position.y = -0.18;
    const carpetMat = this.track(
      new THREE.MeshStandardMaterial({
        color: team === 'blue' ? 0x2563eb : team === 'red' ? 0xdc2626 : 0xb45309,
        roughness: 0.8,
      })
    );
    const carpet = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.4, 0.04, 3.8)), carpetMat);
    carpet.position.set(0, 0.02, 0.6);
    floorGroup.add(slab, carpet);

    // Cutaway back & side walls
    const backWall = new THREE.Mesh(this.track(new THREE.BoxGeometry(6.4, 3.4, 0.32)), wallMat);
    backWall.position.set(0, 1.68, -2.75);
    const sideL = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.3, 3.4, 5.6)), wallMat);
    sideL.position.set(-3.05, 1.68, 0);
    const sideR = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.3, 3.4, 5.6)), wallMat);
    sideR.position.set(3.05, 1.68, 0);
    floorGroup.add(backWall, sideL, sideR);

    // Vault Door Frame + Swinging Vault Door + 3 Lock Crystals
    const frame = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.75, 2.35, 0.25)), trimMat);
    frame.position.set(0, 1.18, -2.55);
    floorGroup.add(frame);

    const doorLeaf = new THREE.Group();
    doorLeaf.position.set(-0.72, 1.1, -2.42);
    const doorMesh = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(1.42, 2.05, 0.14)),
      this.track(new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.45, roughness: 0.35 }))
    );
    doorMesh.position.set(0.72, 0, 0);
    doorLeaf.add(doorMesh);
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
      cry.position.set(-0.46 + i * 0.46, 2.6, -2.35);
      floorGroup.add(cry);
    }

    // 3-Step L/R Bridge Tiles in front of the Vault Door
    const bridgeTiles: Array<{ L: THREE.MeshStandardMaterial; R: THREE.MeshStandardMaterial }> = [];
    const tileGeo = this.track(new THREE.BoxGeometry(0.54, 0.08, 0.42));
    for (let step = 0; step < 3; step++) {
      const matL = this.track(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5 }));
      const matR = this.track(new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5 }));
      const tileL = new THREE.Mesh(tileGeo, matL);
      const tileR = new THREE.Mesh(tileGeo, matR);
      const tz = -0.3 - step * 0.55;
      tileL.position.set(-0.42, 0.06, tz);
      tileR.position.set(0.42, 0.06, tz);
      floorGroup.add(tileL, tileR);
      bridgeTiles.push({ L: matL, R: matR });
    }

    // 4 Corner Searchable Props with Beacons & Floating Labels
    const corners: Array<'nw' | 'ne' | 'sw' | 'se'> = ['nw', 'ne', 'sw', 'se'];
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
      const ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.42, 0.05, 8, 24)), pedMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.05;

      const meshHolder = new THREE.Group();
      const fallbackCrate = new THREE.Mesh(
        this.track(new THREE.BoxGeometry(0.55, 0.55, 0.55)),
        this.track(
          new THREE.MeshStandardMaterial({
            color: idx % 2 === 0 ? 0xd97706 : 0x7c3aed,
            roughness: 0.65,
          })
        )
      );
      fallbackCrate.position.y = 0.3;
      meshHolder.add(fallbackCrate);

      const label = this.createLabelSlot(2.15, 0.54);
      label.sprite.position.set(0, 1.32, 0);
      pGroup.add(ring, meshHolder, label.sprite);
      floorGroup.add(pGroup);
      return { group: pGroup, beaconMat: pedMat, meshHolder, label, corner };
    });

    // Spotlight Hero standing at the lock
    const spotlightHolder = new THREE.Group();
    spotlightHolder.position.set(0, 0.04, 0.45);
    const shieldRingMat = this.track(
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    const spotlightShieldRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(0.52, 0.68, 24)),
      shieldRingMat
    );
    spotlightShieldRing.rotation.x = -Math.PI / 2;
    spotlightShieldRing.position.y = 0.04;
    spotlightShieldRing.visible = false;

    const spotlightLabel = this.createLabelSlot(2.5, 0.62);
    spotlightLabel.sprite.position.set(0, 1.95, 0);
    spotlightHolder.add(spotlightShieldRing, spotlightLabel.sprite);
    this.mountFallbackHeroMesh(spotlightHolder, 0xfbbf24);
    floorGroup.add(spotlightHolder);

    // 4 Queue Adventurers behind Spotlight
    const queueHolders: THREE.Group[] = [];
    for (let i = 0; i < 4; i++) {
      const qh = new THREE.Group();
      const row = Math.floor(i / 2);
      const col = i % 2 === 0 ? -0.58 : 0.58;
      qh.position.set(col, 0.04, 1.35 + row * 0.72);
      qh.scale.setScalar(0.75);
      qh.visible = false;
      this.mountFallbackHeroMesh(qh, 0x60a5fa);
      floorGroup.add(qh);
      queueHolders.push(qh);
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
    const hazardMesh = new THREE.Mesh(this.track(new THREE.PlaneGeometry(6.1, 5.5)), hazardMat);
    hazardMesh.rotation.x = -Math.PI / 2;
    hazardMesh.position.set(0, -0.1, 0);
    root.add(hazardMesh);

    // Rival Blackout Curtain
    const blackoutMesh = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(6.3, 3.6, 5.7)),
      this.track(
        new THREE.MeshBasicMaterial({
          color: 0x020617,
          transparent: true,
          opacity: 0.82,
        })
      )
    );
    blackoutMesh.position.set(0, 1.7, 0);
    blackoutMesh.visible = false;
    root.add(blackoutMesh);

    return {
      team,
      root,
      floorGroup,
      wallMats: [wallMat],
      floorMat,
      doorLeaf,
      lockCrystalMats,
      hazardMesh,
      hazardMat,
      blackoutMesh,
      bridgeTiles,
      props,
      spotlightHolder,
      spotlightLabel,
      spotlightUser: null,
      spotlightClass: null,
      spotlightMixer: null,
      spotlightShieldRing,
      queueHolders,
      queueUsers: [null, null, null, null],
      queueMixers: [null, null, null, null],
    };
  }

  private mountFallbackHeroMesh(holder: THREE.Group, bodyColor: number): void {
    const tagMesh = holder.children.find((c) => c.userData?.isHeroModel);
    if (tagMesh) holder.remove(tagMesh);

    const g = new THREE.Group();
    g.userData.isHeroModel = true;
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
          clone.scale.setScalar(0.55);
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
    prevMixer: THREE.AnimationMixer | null
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

    const clip = pickClip(tpl.animations, ['idle_a', 'idle']);
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
    }

    // 2. Apply rotating room theme palette
    if (this.currentThemeId !== snapshot.theme.id) {
      this.currentThemeId = snapshot.theme.id;
      this.skyMat.uniforms.uTop.value.setHex(snapshot.theme.ambientSkyTop);
      this.skyMat.uniforms.uBottom.value.setHex(snapshot.theme.ambientSkyBottom);
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

    // Bridge revealed safe tiles
    for (let s = 0; s < 3; s++) {
      const safe = state.revealedSteps[s];
      rig.bridgeTiles[s].L.color.setHex(safe === 'L' ? 0x34d399 : 0x64748b);
      rig.bridgeTiles[s].R.color.setHex(safe === 'R' ? 0x34d399 : 0x64748b);
    }

    // Shuffled 4 corner props + glowing beacon status
    for (let i = 0; i < Math.min(rig.props.length, state.props.length); i++) {
      const pv = rig.props[i];
      const propData = state.props[i];
      const [px, pz] = CORNER_COORDS[propData.corner];
      pv.group.position.set(px, 0.02, pz);
      const found = Boolean(propData.searchedBy);
      pv.beaconMat.color.setHex(found ? 0x34d399 : 0xfbbf24);
      pv.beaconMat.emissive.setHex(found ? 0x10b981 : 0xd97706);
      const labelText = found
        ? `${propData.emoji} DONE`
        : `${propData.emoji} ${propData.name.toUpperCase()}`;
      this.drawLabelSlot(
        pv.label,
        labelText,
        found ? 'rgba(6, 78, 59, 0.9)' : 'rgba(15, 23, 42, 0.9)',
        found ? '#34d399' : '#fbbf24'
      );
    }

    // Spotlight character
    if (state.spotlightPlayer) {
      rig.spotlightHolder.visible = true;
      const cls = state.spotlightClass || pickClassForName(state.spotlightPlayer);
      if (rig.spotlightUser !== state.spotlightPlayer || rig.spotlightClass !== cls) {
        rig.spotlightUser = state.spotlightPlayer;
        rig.spotlightClass = cls;
        rig.spotlightMixer = this.swapHeroModel(rig.spotlightHolder, cls, 0.72, rig.spotlightMixer);
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

    // Up-Next Queue models
    for (let q = 0; q < 4; q++) {
      const qUser = state.upNext[q] ?? null;
      const qh = rig.queueHolders[q];
      if (!qUser) {
        qh.visible = false;
        continue;
      }
      qh.visible = true;
      if (rig.queueUsers[q] !== qUser) {
        rig.queueUsers[q] = qUser;
        rig.queueMixers[q] = this.swapHeroModel(qh, pickClassForName(qUser), 0.7, rig.queueMixers[q]);
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

    for (const rig of [this.coopRig, this.redRig, this.blueRig]) {
      if (!rig.root.visible) continue;
      rig.spotlightMixer?.update(dtSec);
      for (const qm of rig.queueMixers) qm?.update(dtSec);

      // Gentle float on unsearched prop meshes
      rig.props.forEach((pv, i) => {
        pv.meshHolder.rotation.y = Math.sin(t * 0.9 + i) * 0.12;
      });

      // Door swings open during Getaway or Victory!
      const isOpen =
        snap?.phase === 'getaway' ||
        (snap?.winnerTeam !== null && snap?.winnerTeam === rig.team);
      const targetDoorRot = isOpen ? -1.45 : 0;
      rig.doorLeaf.rotation.y += (targetDoorRot - rig.doorLeaf.rotation.y) * Math.min(1, dtSec * 8);

      // Trapdoor pit drop for the losing Versus room
      const dropped = snap?.loserPitTeam === rig.team;
      const targetFloorY = dropped ? -3.4 : 0;
      rig.floorGroup.position.y += (targetFloorY - rig.floorGroup.position.y) * Math.min(1, dtSec * 6);

      // Rising hazard fluid plane
      const ratio = snap?.hazardRatio ?? 0;
      rig.hazardMesh.position.y = -0.15 + ratio * 1.45 + Math.sin(t * 2.5) * 0.03;

      // Spotlight zap shake
      const chamber =
        rig.team === 'coop'
          ? snap?.chambers.coop
          : rig.team === 'red'
            ? snap?.chambers.red
            : snap?.chambers.blue;
      const isZapped = chamber?.lastEffect === 'zap' && Date.now() - chamber.lastEffectAtMs < 650;
      rig.spotlightHolder.position.y = isZapped ? 0.35 + Math.abs(Math.sin(t * 28)) * 0.45 : 0.04;
    }
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
