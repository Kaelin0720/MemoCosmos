import * as THREE from "three";
import type { MemoryGraph } from "./memory-types";
import {
  appearancesFor,
  defaultSurface,
  fragment,
  vertex,
  ringFragment,
  ringDefs,
  typeDefs,
  starDefs,
  type CelestialStyle,
  type CelestialKind,
} from "./celestial-materials";
import { universeLayout, type UniverseBody } from "./universe-layout";

type CameraState = {
  yaw: number;
  pitch: number;
  distance: number;
  cx: number;
  cy: number;
  cz: number;
};
type BodyObject = {
  body: UniverseBody;
  position: THREE.Vector3;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  ring?: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  glow?: THREE.Sprite;
  orbit?: THREE.LineLoop;
  surface: string;
  ringStyle: string;
};
type Callbacks = {
  select: (id: string) => void;
  running: (value: boolean) => void;
  failed: () => void;
  label: (kind: CelestialKind) => string;
};
const TAU = Math.PI * 2;

export class UniverseRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(43, 1, 0.2, 80000);
  private sphere = new THREE.SphereGeometry(1, 56, 40);
  private rings = new THREE.RingGeometry(1.2, 2.8, 192, 1);
  private glowTexture: THREE.CanvasTexture;
  private objects = new Map<string, BodyObject>();
  private labels = new Map<string, HTMLButtonElement>();
  private layout: ReturnType<typeof universeLayout>;
  private regionCenters = new Map<string, THREE.Vector3>();
  private regionRotation = new Map<string, THREE.Quaternion>();
  private resources: { dispose: () => void }[] = [];
  private target: CameraState = { yaw: -0.18, pitch: 0.45, distance: 2200, cx: 0, cy: 0, cz: 0 };
  private current = { ...this.target };
  private velocity: CameraState = { yaw: 0, pitch: 0, distance: 0, cx: 0, cy: 0, cz: 0 };
  private selected: string | null = null;
  private hover: string | null = null;
  private paused = false;
  private inView = true;
  private disposed = false;
  private started = false;
  private raf = 0;
  private previous = 0;
  private time = 0;
  private width = 1;
  private height = 1;
  private inertia = { yaw: 0, pitch: 0 };
  private observer: ResizeObserver;
  private intersection: IntersectionObserver;
  private abort = new AbortController();
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: {
    x: number;
    y: number;
    yaw: number;
    pitch: number;
    time: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null = null;
  private pinch: { distance: number; zoom: number } | null = null;
  private tracked: THREE.Vector3 | null = null;
  private line: THREE.LineSegments;
  private lineData: Float32Array;
  private lineGeometry: THREE.BufferGeometry;
  private emphasize: THREE.LineSegments;
  private emphasisData: Float32Array;
  private emphasisGeometry: THREE.BufferGeometry;
  private projection = new THREE.Vector3();
  private relationPath = new Set<string>();
  private previewScene: THREE.Scene;
  private previewEye: THREE.PerspectiveCamera;
  private previewMesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private previewRing: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  private previewGlow: THREE.Sprite;
  private previewTarget: THREE.WebGLRenderTarget;
  private thumbnailCache = new Map<string, HTMLCanvasElement>();
  private previewPixels = new Uint8Array(128 * 128 * 4);

  constructor(
    private canvas: HTMLCanvasElement,
    private layer: HTMLDivElement,
    private graph: MemoryGraph,
    private callbacks: Callbacks,
  ) {
    this.layout = universeLayout(graph);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x03060d, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.resources.push(this.sphere, this.rings);
    const image = document.createElement("canvas");
    image.width = image.height = 256;
    const context = image.getContext("2d")!,
      gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, "rgba(255,255,255,.32)");
    gradient.addColorStop(0.16, "rgba(255,255,255,.24)");
    gradient.addColorStop(0.38, "rgba(255,255,255,.065)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    this.glowTexture = new THREE.CanvasTexture(image);
    this.resources.push(this.glowTexture);
    for (const region of this.layout.regions) {
      this.regionCenters.set(region.id, new THREE.Vector3());
      this.regionRotation.set(region.id, new THREE.Quaternion());
    }
    for (const body of this.layout.bodies) this.addBody(body);
    const starsGeometry = new THREE.BufferGeometry(),
      points = new Float32Array(1200 * 3);
    for (let i = 0; i < 1200; i++) {
      const a = i * 2.39996,
        z = 1 - (2 * (i + 0.5)) / 1200,
        r = 8000 + Math.sin(i * 37.2) * 1700;
      points.set(
        [Math.cos(a) * Math.sqrt(1 - z * z) * r, z * r, Math.sin(a) * Math.sqrt(1 - z * z) * r],
        i * 3,
      );
    }
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
    const starsMaterial = new THREE.PointsMaterial({
      color: 0xaec3e7,
      size: 2.4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    this.scene.add(new THREE.Points(starsGeometry, starsMaterial));
    this.resources.push(starsGeometry, starsMaterial);
    const line = (opacity: number, color: number) => {
      const data = new Float32Array(Math.max(1, graph.edges.length) * 18 * 6),
        geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data, 3).setUsage(THREE.DynamicDrawUsage),
      );
      geometry.setDrawRange(0, 0);
      const material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      const mesh = new THREE.LineSegments(geometry, material);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.resources.push(geometry, material);
      return { data, geometry, mesh };
    };
    const ordinary = line(0.09, 0x8da6cd),
      emphasis = line(0.7, 0xb6d7ff);
    this.line = ordinary.mesh;
    this.lineGeometry = ordinary.geometry;
    this.lineData = ordinary.data;
    this.emphasize = emphasis.mesh;
    this.emphasisGeometry = emphasis.geometry;
    this.emphasisData = emphasis.data;
    this.previewScene = new THREE.Scene();
    this.previewEye = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
    this.previewMesh = new THREE.Mesh(this.sphere, this.material("planet", 0));
    this.previewScene.add(this.previewMesh);
    this.previewRing = new THREE.Mesh(this.rings, this.ringMaterial());
    this.previewScene.add(this.previewRing);
    this.previewGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.previewScene.add(this.previewGlow);
    this.previewTarget = new THREE.WebGLRenderTarget(128, 128, { depthBuffer: true });
    this.resources.push(this.previewTarget, this.previewGlow.material);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.intersection = new IntersectionObserver(([entry]) => {
      this.inView = entry.isIntersecting;
      this.reportRunning();
    });
    this.intersection.observe(canvas);
    this.bindInput();
    this.resize();
    this.updatePositions();
    this.reset(true);
    this.renderer
      .compileAsync(this.scene, this.camera)
      .then(() => {
        if (!this.disposed) {
          this.started = true;
          this.callbacks.running(!this.paused);
          this.raf = requestAnimationFrame(this.frame);
        }
      })
      .catch(() => {
        if (!this.disposed) this.callbacks.failed();
      });
  }
  private material(kind: CelestialKind, seed: number) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uKind: { value: kind === "star" ? 0 : kind === "moon" ? 14 : 1 },
        uVariant: { value: 0 },
        uSeed: { value: (seed % 1000) * 0.73 },
        uTime: { value: 0 },
        uSelected: { value: 0 },
        uStar: { value: new THREE.Vector3() },
        uEye: { value: new THREE.Vector3() },
        uTone: { value: new THREE.Vector3(0.67, 0.81, 1) },
      },
    });
    this.resources.push(material);
    return material;
  }
  private ringMaterial() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: ringFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uRingStyle: { value: 2 },
        uCold: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uStar: { value: new THREE.Vector3() },
        uRadius: { value: 1 },
      },
    });
    this.resources.push(mat);
    return mat;
  }
  private addBody(body: UniverseBody) {
    const mesh = new THREE.Mesh(this.sphere, this.material(body.kind, body.seed)),
      surface = defaultSurface(body.kind, body.seed),
      o: BodyObject = {
        body,
        position: new THREE.Vector3(),
        mesh,
        surface,
        ringStyle: typeDefs[surface]?.ring ?? "none",
      };
    this.scene.add(mesh);
    if (body.kind === "planet") {
      o.ring = new THREE.Mesh(this.rings, this.ringMaterial());
      this.scene.add(o.ring);
    }
    if (body.kind === "star") {
      const material = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xc9ddff,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      o.glow = new THREE.Sprite(material);
      this.scene.add(o.glow);
      this.resources.push(material);
    }
    if (body.anchor) {
      const points = [];
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * TAU;
        points.push(
          new THREE.Vector3(
            Math.cos(a) * body.orbit,
            Math.sin(a) * body.orbit * Math.sin(body.tilt),
            Math.sin(a) * body.orbit * Math.cos(body.tilt),
          ),
        );
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points),
        material = new THREE.LineBasicMaterial({
          color: 0x8da6ca,
          transparent: true,
          opacity: body.kind === "moon" ? 0.09 : 0.12,
          depthWrite: false,
        });
      o.orbit = new THREE.LineLoop(geometry, material);
      this.scene.add(o.orbit);
      this.resources.push(geometry, material);
    }
    this.objects.set(body.id, o);
    const label = document.createElement("button");
    label.type = "button";
    label.className = "universe-node-label";
    label.textContent = body.title;
    label.setAttribute("aria-label", body.title);
    label.setAttribute("aria-pressed", "false");
    label.hidden = true;
    label.addEventListener("click", () => this.callbacks.select(body.id), {
      signal: this.abort.signal,
    });
    label.addEventListener(
      "pointerenter",
      () => {
        this.hover = body.id;
      },
      { signal: this.abort.signal },
    );
    label.addEventListener(
      "pointerleave",
      () => {
        this.hover = null;
      },
      { signal: this.abort.signal },
    );
    label.addEventListener(
      "focus",
      () => {
        this.hover = body.id;
      },
      { signal: this.abort.signal },
    );
    label.addEventListener(
      "blur",
      () => {
        this.hover = null;
      },
      { signal: this.abort.signal },
    );
    this.layer.append(label);
    this.labels.set(body.id, label);
  }
  getBody(id: string) {
    return this.objects.get(id)?.body;
  }
  setStyle(id: string, style: CelestialStyle) {
    const o = this.objects.get(id);
    if (!o || !appearancesFor(o.body.kind)[style.surface]) return;
    o.surface = style.surface;
    o.ringStyle =
      style.ring && Object.hasOwn(ringDefs, style.ring)
        ? style.ring
        : (typeDefs[style.surface]?.ring ?? "none");
  }
  setPath(ids: string[]) {
    this.relationPath = new Set(ids);
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    this.reportRunning();
  }
  private reportRunning() {
    this.callbacks.running(this.started && !this.paused && this.inView && !document.hidden);
  }
  setSelected(id: string | null) {
    if (id === this.selected) return;
    this.selected = id;
    this.tracked = null;
    this.inertia = { yaw: 0, pitch: 0 };
    if (!id) {
      this.reset();
      return;
    }
    const o = this.objects.get(id);
    if (!o) return;
    const region = this.layout.regions.find((region) => region.id === o.body.region)!;
    const distance =
      o.body.kind === "star"
        ? Math.max(800, (region.extent * 2.7) / Math.min(1, this.width / this.height))
        : o.body.kind === "moon"
          ? 150
          : Math.max(230, o.body.radius * 10);
    Object.assign(this.target, { cx: o.position.x, cy: o.position.y, cz: o.position.z, distance });
    this.tracked = o.position.clone();
  }
  zoomBy(factor: number) {
    this.target.distance = Math.max(100, Math.min(26000, this.target.distance / factor));
  }
  rotate(dx: number, dy: number) {
    this.target.yaw += dx;
    this.target.pitch = THREE.MathUtils.clamp(this.target.pitch + dy, -1.35, 1.35);
  }
  reset(immediate = false) {
    const bounds = new THREE.Box3();
    for (const region of this.layout.regions) {
      const center = this.regionCenters.get(region.id)!,
        radius = region.extent;
      bounds.expandByPoint(center.clone().addScalar(radius));
      bounds.expandByPoint(center.clone().addScalar(-radius));
    }
    const center = this.layout.regions.length
      ? bounds.getCenter(new THREE.Vector3())
      : new THREE.Vector3();
    const inverse = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(0.45, -0.18, 0, "YXZ"))
      .invert();
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 700;
    for (const region of this.layout.regions) {
      const local = this.regionCenters.get(region.id)!.clone().sub(center).applyQuaternion(inverse);
      distance = Math.max(
        distance,
        local.z +
          Math.max(
            (Math.abs(local.x) + region.extent) / ((tangent * this.width) / this.height),
            (Math.abs(local.y) + region.extent) / tangent,
          ),
      );
    }
    Object.assign(this.target, {
      yaw: -0.18,
      pitch: 0.45,
      cx: center.x,
      cy: center.y,
      cz: center.z,
      distance: distance * 1.06,
    });
    this.tracked = null;
    this.inertia = { yaw: 0, pitch: 0 };
    if (immediate) this.current = { ...this.target };
  }
  private resize() {
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }
  private updatePositions() {
    this.layout.regions.forEach((region, i) => {
      const a = i * 1.7,
        t = this.time * 0.0035;
      const bases = [
        [0, 0, 0],
        [-1040, -300, 260],
        [1070, 250, -700],
      ];
      const r = 900 * Math.sqrt(i),
        base = bases[i] ?? [
          Math.cos(i * 2.39996) * r,
          Math.sin(i * 1.7) * 300,
          Math.sin(i * 2.39996) * r * 0.65,
        ];
      this.regionCenters
        .get(region.id)!
        .set(
          base[0] * Math.cos(t) +
            base[2] * Math.sin(t) +
            65 * (Math.sin(this.time * 0.014 + a) - Math.sin(a)),
          base[1] + 105 * (Math.sin(this.time * 0.009 + a) - Math.sin(a)),
          -base[0] * Math.sin(t) +
            base[2] * Math.cos(t) +
            100 * (Math.cos(this.time * 0.011 + a) - Math.cos(a)),
        );
      this.regionRotation
        .get(region.id)!
        .setFromEuler(
          new THREE.Euler(
            0.13 * Math.sin(this.time * 0.008 + i),
            this.time * (0.002 + i * 0.0007),
            0,
          ),
        );
    });
    for (const o of this.objects.values()) {
      const b = o.body;
      if (!b.anchor) {
        o.position.copy(this.regionCenters.get(b.region)!);
        continue;
      }
      const a = b.phase + this.time * b.speed,
        parent = this.objects.get(b.anchor)!;
      this.projection
        .set(
          Math.cos(a) * b.orbit,
          Math.sin(a) * b.orbit * Math.sin(b.tilt),
          Math.sin(a) * b.orbit * Math.cos(b.tilt),
        )
        .applyQuaternion(this.regionRotation.get(b.region)!);
      o.position.copy(parent.position).add(this.projection);
    }
  }
  private spring(dt: number) {
    const seconds = dt / 1000,
      omega = this.drag ? 27 : 11,
      decay = Math.exp(-omega * seconds);
    for (const k of Object.keys(this.current) as (keyof CameraState)[]) {
      const logarithmic = k === "distance",
        x = logarithmic ? Math.log(this.current[k]) : this.current[k],
        goal = logarithmic ? Math.log(this.target[k]) : this.target[k],
        e = x - goal,
        c = this.velocity[k] + omega * e,
        value = goal + (e + c * seconds) * decay;
      this.velocity[k] = (this.velocity[k] - omega * c * seconds) * decay;
      this.current[k] = logarithmic ? Math.exp(value) : value;
    }
  }
  private updateLines() {
    let ordinary = 0,
      emphasis = 0;
    const focus = this.hover ?? this.selected;
    for (const edge of this.graph.edges) {
      const a = this.objects.get(edge.source)?.position,
        b = this.objects.get(edge.target)?.position;
      if (!a || !b) continue;
      const lit =
          edge.source === focus ||
          edge.target === focus ||
          (this.relationPath.has(edge.source) && this.relationPath.has(edge.target)),
        data = lit ? this.emphasisData : this.lineData;
      let at = lit ? emphasis : ordinary;
      for (let i = 0; i < 18; i++)
        for (let j = 0; j < 2; j++) {
          const t = (i + j) / 18,
            lift = Math.sin(t * Math.PI) * Math.min(70, a.distanceTo(b) * 0.13);
          data[at++] = a.x + (b.x - a.x) * t;
          data[at++] = a.y + (b.y - a.y) * t + lift;
          data[at++] = a.z + (b.z - a.z) * t;
        }
      if (lit) emphasis = at;
      else ordinary = at;
    }
    for (const [g, count] of [
      [this.lineGeometry, ordinary],
      [this.emphasisGeometry, emphasis],
    ] as const) {
      g.setDrawRange(0, count / 3);
      g.attributes.position.needsUpdate = true;
    }
  }
  private drawLabels() {
    const used: { x: number; y: number; w: number; h: number }[] = [],
      list = [...this.objects.values()].sort(
        (a, b) =>
          Number(b.body.id === this.selected) - Number(a.body.id === this.selected) ||
          Number(b.body.id === this.hover) - Number(a.body.id === this.hover) ||
          Number(b.body.kind === "star") - Number(a.body.kind === "star"),
      );
    for (const o of list) {
      const label = this.labels.get(o.body.id)!;
      this.projection.copy(o.position).project(this.camera);
      const x = ((this.projection.x + 1) * this.width) / 2,
        y = ((1 - this.projection.y) * this.height) / 2,
        screenRadius =
          (o.mesh.scale.x * this.height) /
          (2 *
            Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) *
            this.camera.position.distanceTo(o.position)),
        w = Math.min(
          190,
          Math.max(
            60,
            [...o.body.title].reduce(
              (size, char) => size + (char.charCodeAt(0) > 255 ? 12 : 7),
              20,
            ),
          ),
        ),
        h = 28;
      let top = y + screenRadius + 7,
        left = x - w / 2;
      const nearby =
        this.selected &&
        (this.selected === o.body.anchor ||
          this.layout.neighbors.get(this.selected)?.has(o.body.id));
      const show =
        this.projection.z > -1 &&
        this.projection.z < 1 &&
        left > 3 &&
        left + w < this.width - 3 &&
        top > 4 &&
        top + h < this.height - 6 &&
        (o.body.kind !== "moon" || nearby || this.selected === o.body.id) &&
        !used.some(
          (rect) =>
            left < rect.x + rect.w + 4 &&
            left + w + 4 > rect.x &&
            top < rect.y + rect.h + 4 &&
            top + h + 4 > rect.y,
        );
      if (this.hover === o.body.id && !label.hidden) {
        left = Number(label.dataset.x ?? left);
        top = Number(label.dataset.y ?? top);
      }
      label.hidden = !show;
      label.setAttribute("aria-pressed", String(this.selected === o.body.id));
      if (show) {
        label.style.transform = `translate3d(${left.toFixed(2)}px,${top.toFixed(2)}px,0)`;
        label.style.width = w + "px";
        label.dataset.x = String(left);
        label.dataset.y = String(top);
        used.push({ x: left, y: top, w, h });
      }
    }
  }
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(80, this.previous ? now - this.previous : 16);
    this.previous = now;
    if (!this.inView || document.hidden) return;
    if (!this.paused) {
      this.time += dt * 0.001;
      if (!this.drag) {
        const decay = Math.exp(-dt / 230);
        this.target.yaw += this.inertia.yaw * 230 * (1 - decay) + dt * 0.000002;
        this.target.pitch = THREE.MathUtils.clamp(
          this.target.pitch + this.inertia.pitch * 230 * (1 - decay),
          -1.35,
          1.35,
        );
        this.inertia.yaw *= decay;
        this.inertia.pitch *= decay;
      }
    }
    this.updatePositions();
    if (this.selected) {
      const position = this.objects.get(this.selected)?.position;
      if (position && this.tracked && !this.drag) {
        this.target.cx += position.x - this.tracked.x;
        this.target.cy += position.y - this.tracked.y;
        this.target.cz += position.z - this.tracked.z;
      }
      if (position) this.tracked = position.clone();
    }
    this.spring(dt);
    this.camera.rotation.set(this.current.pitch, this.current.yaw, 0, "YXZ");
    this.projection.set(0, 0, this.current.distance).applyQuaternion(this.camera.quaternion);
    this.camera.position
      .set(this.current.cx, this.current.cy, this.current.cz)
      .add(this.projection);
    this.camera.updateMatrixWorld();
    for (const o of this.objects.values()) {
      const b = o.body,
        u = o.mesh.material.uniforms,
        def = appearancesFor(b.kind)[o.surface],
        tone = def.tone ?? [171, 207, 255];
      o.mesh.position.copy(o.position);
      const minimum = b.kind === "moon" ? this.camera.position.distanceTo(o.position) * 0.005 : 0,
        radius = Math.max(b.radius * 1.35, minimum);
      o.mesh.scale.setScalar(radius);
      o.mesh.rotation.set(
        0.12 * Math.sin(b.seed),
        this.time * (b.kind === "star" ? 0.006 : 0.018) + (b.seed % 100) * 0.7,
        0.07 * Math.sin(b.seed),
      );
      u.uKind.value = b.kind === "star" ? 0 : b.kind === "moon" ? 14 : (def.model ?? 10);
      u.uVariant.value =
        b.kind === "planet" ? 0 : Object.keys(appearancesFor(b.kind)).indexOf(o.surface);
      u.uTone.value.set(...tone.map((c) => c / 255));
      u.uTime.value = this.time;
      u.uEye.value.copy(this.camera.position);
      u.uSelected.value = b.id === this.selected || b.id === this.hover ? 1 : 0;
      const star = this.objects.get(
        this.layout.regions.find((region) => region.id === b.region)!.root,
      )!;
      u.uStar.value.copy(star.position);
      if (o.glow) {
        o.glow.position.copy(o.position);
        o.glow.scale.setScalar(radius * (o.surface === "redgiant" ? 11 : 8.5));
        o.glow.material.color.setRGB(tone[0] / 255, tone[1] / 255, tone[2] / 255);
      }
      if (o.ring) {
        o.ring.visible = o.ringStyle !== "none";
        o.ring.position.copy(o.position);
        o.ring.scale.setScalar(radius);
        o.ring.quaternion
          .copy(this.regionRotation.get(b.region)!)
          .multiply(
            new THREE.Quaternion().setFromEuler(new THREE.Euler(1.35 + (b.seed % 10) * 0.03, 0, 0)),
          );
        const ru = o.ring.material.uniforms;
        ru.uRingStyle.value = Object.keys(ringDefs).indexOf(o.ringStyle);
        ru.uCold.value = o.ringStyle === "icy" ? 1 : 0;
        ru.uCenter.value.copy(o.position);
        ru.uRadius.value = radius;
        ru.uStar.value.copy(star.position);
      }
      if (o.orbit) {
        o.orbit.visible = b.kind !== "moon" || this.selected === b.id || this.selected === b.anchor;
        o.orbit.position.copy(this.objects.get(b.anchor!)!.position);
        o.orbit.quaternion.copy(this.regionRotation.get(b.region)!);
      }
    }
    this.updateLines();
    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
  };
  private pick(x: number, y: number) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2),
      this.camera,
    );
    const hit = ray.intersectObjects(
      [...this.objects.values()].map((o) => o.mesh),
      false,
    )[0];
    return hit ? [...this.objects.values()].find((o) => o.mesh === hit.object)?.body.id : null;
  }
  private bindInput() {
    const signal = this.abort.signal,
      local = (e: PointerEvent) => {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };
    this.canvas.addEventListener(
      "pointerdown",
      (e) => {
        const p = local(e);
        this.pointers.set(e.pointerId, p);
        this.canvas.setPointerCapture(e.pointerId);
        this.inertia = { yaw: 0, pitch: 0 };
        if (this.pointers.size === 1)
          this.drag = {
            ...p,
            yaw: this.target.yaw,
            pitch: this.target.pitch,
            time: performance.now(),
            vx: 0,
            vy: 0,
            moved: false,
          };
        else if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.target.distance };
          if (this.drag) this.drag.moved = true;
        }
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointermove",
      (e) => {
        const p = local(e);
        if (!this.pointers.has(e.pointerId)) {
          this.hover = this.pick(p.x, p.y) ?? null;
          return;
        }
        const previous = this.pointers.get(e.pointerId)!;
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2 && this.pinch) {
          const [a, b] = [...this.pointers.values()];
          this.target.distance = THREE.MathUtils.clamp(
            (this.pinch.zoom * this.pinch.distance) /
              Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
            100,
            26000,
          );
          return;
        }
        if (!this.drag) return;
        const dx = p.x - this.drag.x,
          dy = p.y - this.drag.y,
          now = performance.now(),
          delta = Math.max(8, now - this.drag.time);
        if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
        this.target.yaw = this.drag.yaw + dx * 0.005;
        this.target.pitch = THREE.MathUtils.clamp(this.drag.pitch + dy * 0.004, -1.35, 1.35);
        this.drag.vx = THREE.MathUtils.clamp(((p.x - previous.x) * 0.005) / delta, -0.0015, 0.0015);
        this.drag.vy = THREE.MathUtils.clamp(((p.y - previous.y) * 0.004) / delta, -0.001, 0.001);
        this.drag.time = now;
      },
      { signal },
    );
    const finish = (e: PointerEvent) => {
      const p = local(e),
        drag = this.drag;
      this.pointers.delete(e.pointerId);
      this.pinch = null;
      if (!this.pointers.size) {
        this.drag = null;
        if (drag && !drag.moved) {
          const id = this.pick(p.x, p.y);
          if (id) this.callbacks.select(id);
        } else if (drag && !this.paused && performance.now() - drag.time < 100)
          this.inertia = { yaw: drag.vx, pitch: drag.vy };
      }
    };
    this.canvas.addEventListener("pointerup", finish, { signal });
    this.canvas.addEventListener(
      "pointercancel",
      () => {
        this.pointers.clear();
        this.drag = null;
        this.pinch = null;
        this.inertia = { yaw: 0, pitch: 0 };
      },
      { signal },
    );
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.target.distance = THREE.MathUtils.clamp(
          this.target.distance * Math.exp(e.deltaY * 0.001),
          100,
          26000,
        );
      },
      { passive: false, signal },
    );
    this.canvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        this.callbacks.failed();
      },
      { signal },
    );
    document.addEventListener("visibilitychange", () => this.reportRunning(), { signal });
  }
  thumbnail(kind: CelestialKind, value: string) {
    const key = kind + ":" + value,
      cached = this.thumbnailCache.get(key);
    if (cached) return cached;
    const def = appearancesFor(kind)[value],
      u = this.previewMesh.material.uniforms;
    u.uKind.value = kind === "star" ? 0 : kind === "moon" ? 14 : (def.model ?? 10);
    u.uVariant.value = Object.keys(appearancesFor(kind)).indexOf(value);
    u.uSeed.value = 7.3;
    u.uTime.value = 0;
    u.uSelected.value = 0;
    u.uStar.value.set(-4, 3, 5);
    u.uTone.value.set(...(def.tone ?? [171, 207, 255]).map((c) => c / 255));
    this.previewMesh.rotation.set(
      0.12,
      Object.keys(appearancesFor(kind)).indexOf(value) * 0.47,
      0.05,
    );
    this.previewRing.visible = kind === "planet" && Boolean(def.ring);
    this.previewGlow.visible = kind === "star";
    this.previewEye.position.set(0, 0, this.previewRing.visible ? 7.6 : 4.1);
    this.previewEye.lookAt(0, 0, 0);
    this.previewEye.updateMatrixWorld();
    u.uEye.value.copy(this.previewEye.position);
    if (this.previewRing.visible) {
      this.previewRing.rotation.set(1.05, 0.1, -0.28);
      const ru = this.previewRing.material.uniforms;
      ru.uRingStyle.value = Object.keys(ringDefs).indexOf(def.ring!);
      ru.uCold.value = def.ring === "icy" ? 1 : 0;
      ru.uCenter.value.set(0, 0, 0);
      ru.uStar.value.set(-4, 3, 5);
      ru.uRadius.value = 1;
    }
    if (kind === "star") {
      this.previewGlow.material.color.setRGB(
        ...(starDefs[value].tone!.map((c) => c / 255) as [number, number, number]),
      );
      this.previewGlow.scale.setScalar(5.1);
    }
    const old = this.renderer.getRenderTarget();
    const color = this.renderer.getClearColor(new THREE.Color()),
      alpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.previewTarget);
    this.renderer.setClearColor(0, 0);
    this.renderer.render(this.previewScene, this.previewEye);
    this.renderer.readRenderTargetPixels(this.previewTarget, 0, 0, 128, 128, this.previewPixels);
    this.renderer.setRenderTarget(old);
    this.renderer.setClearColor(color, alpha);
    // Parallel shader compilation can leave the first preview transparent.
    // Retry on a later frame instead of permanently caching an empty image.
    if (!this.previewPixels.some((value, index) => index % 4 === 3 && value > 0)) return null;
    const output = document.createElement("canvas");
    output.width = output.height = 128;
    const context = output.getContext("2d")!,
      pixels = context.createImageData(128, 128);
    for (let y = 0; y < 128; y++)
      pixels.data.set(this.previewPixels.subarray((127 - y) * 512, (128 - y) * 512), y * 512);
    context.putImageData(pixels, 0, 0);
    this.thumbnailCache.set(key, output);
    return output;
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.abort.abort();
    this.observer.disconnect();
    this.intersection.disconnect();
    this.layer.replaceChildren();
    this.resources.forEach((resource) => resource.dispose());
    this.renderer.dispose();
    this.callbacks.running(false);
  }
}
