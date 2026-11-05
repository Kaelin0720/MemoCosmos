import * as THREE from "three";
import type { MemoryGraph } from "./memory-types";
import { universeLayout, seedFor, type UniverseBody } from "./universe-layout";
import {
  appearancesFor,
  defaultSurface,
  fragment,
  vertex,
  ringFragment,
  ringDefs,
  type CelestialKind,
  type CelestialStyle,
} from "./celestial-materials";
import { UniverseRenderer as SurfaceLibrary } from "./universe-renderer";

export type AtlasNavigation = {
  level: "universe" | "galaxy" | "planet";
  region: string | null;
  label: string;
};
type Callbacks = {
  select: (id: string) => void;
  clear: () => void;
  running: (value: boolean) => void;
  failed: () => void;
  navigation: (value: AtlasNavigation) => void;
  label: (kind: CelestialKind) => string;
};
type CameraState = {
  yaw: number;
  pitch: number;
  distance: number;
  x: number;
  y: number;
  z: number;
};
type World = {
  body: UniverseBody;
  position: THREE.Vector3;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  atmosphere: THREE.Mesh;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.ShaderMaterial>;
  surface: string;
  ringStyle: string;
  reveal: number;
};
const knowledgePresence = new Map<string, boolean>();
const pointVertex = `attribute vec3 color;attribute vec3 aElliptical;attribute float aSize;varying vec3 vColor;uniform float uTime;uniform float uDpr;uniform float uScale;uniform float uMode;
void main(){float elliptical=step(1.5,uMode);vec3 p=mix(position,aElliptical,elliptical);float a=uTime*.006/(1.+length(p.xz)*.003);mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a));p.xz=r*p.xz;vec4 mv=modelViewMatrix*vec4(p,1.);vColor=mix(color,color*vec3(1.15,.95,.72),elliptical);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*uScale/max(80.,-mv.z),.65,6.)*uDpr;}`;
const pointFragment = `varying vec3 vColor;uniform float uFade;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;gl_FragColor=vec4(vColor,(exp(-r*r*13.)+.12*exp(-r*r*3.))*uFade);}`;

export class AtlasRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(43, 1, 0.2, 30000);
  private layout: ReturnType<typeof universeLayout>;
  private resources: { dispose(): void }[] = [];
  private objects = new Map<string, World>();
  private labels = new Map<string, HTMLButtonElement>();
  private galaxies = new Map<string, THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>>();
  private galaxyLabels = new Map<string, HTMLButtonElement>();
  private centers = new Map<string, THREE.Vector3>();
  private sphere = new THREE.SphereGeometry(1, 64, 48);
  private rings = new THREE.RingGeometry(1.2, 2.8, 160);
  private beacons: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private field: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private gas: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private paths: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private selected: string | null = null;
  private hover: string | null = null;
  private region: string | null = null;
  private level: AtlasNavigation["level"] = "universe";
  private relationPath = new Set<string>();
  private target: CameraState = { yaw: -0.18, pitch: 0.2, distance: 1800, x: 0, y: 0, z: 0 };
  private current = { ...this.target };
  private velocity: CameraState = { yaw: 0, pitch: 0, distance: 0, x: 0, y: 0, z: 0 };
  private width = 1;
  private height = 1;
  private time = 0;
  private previous = 0;
  private raf = 0;
  private paused = false;
  private visible = true;
  private disposed = false;
  private observer: ResizeObserver;
  private intersection: IntersectionObserver;
  private abort = new AbortController();
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private pinch = 0;
  private library: SurfaceLibrary | null = null;
  private rng = 1;
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
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.6));
    this.renderer.setClearColor(0x040609);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.resources.push(this.sphere, this.rings);
    this.layout.regions.forEach((region, i) => {
      const angle = i * 2.399963,
        distance = i ? 800 * Math.sqrt(i) : 0;
      const center = new THREE.Vector3(
        Math.cos(angle) * distance,
        Math.sin(i * 1.7) * 170,
        Math.sin(angle) * distance * 0.6,
      );
      this.centers.set(region.id, center);
      this.rng = seedFor(region.id);
      const positions: number[] = [],
        colors: number[] = [],
        sizes: number[] = [];
      const count = Math.max(350, Math.min(6000, Math.floor(40000 / this.layout.regions.length)));
      for (let j = 0; j < count; j++) {
        const bulge = j < count * 0.18,
          r = 18 + Math.pow(this.random(), 0.67) * region.extent;
        let x: number, y: number, z: number;
        if (i % 3 === 2) {
          x = this.gaussian() * region.extent * 0.38;
          y = this.gaussian() * region.extent * 0.15;
          z = this.gaussian() * region.extent * 0.28;
        } else if (bulge) {
          x = this.gaussian() * region.extent * 0.1;
          y = this.gaussian() * region.extent * 0.06;
          z = this.gaussian() * region.extent * 0.1;
        } else {
          const a =
            r * 0.027 +
            ((j % (i % 3 ? 2 : 3)) * Math.PI * 2) / (i % 3 ? 2 : 3) +
            this.gaussian() * 0.15;
          x = Math.cos(a) * r;
          y = this.gaussian() * 7;
          z = Math.sin(a) * r * 0.78;
        }
        positions.push(x, y, z);
        const v = 0.35 + this.random() * 0.7,
          warm = Math.exp(-r / 70);
        colors.push(v, v * (0.91 + warm * 0.04), v * (0.9 - warm * 0.15));
        sizes.push(0.55 + Math.pow(this.random(), 6) * 2.6);
      }
      const galaxy = this.points(positions, colors, sizes, 1900);
      galaxy.position.copy(center);
      galaxy.rotation.set(0.46 + i * 0.2, 0, -0.23 + i * 0.15);
      this.galaxies.set(region.id, galaxy);
      this.scene.add(galaxy);
      const label = this.button(region.label, "universe-region-label", () =>
        this.enterRegion(region.id),
      );
      this.galaxyLabels.set(region.id, label);
    });
    this.layout.bodies.forEach((body) => this.addWorld(body));
    this.rng = 12067;
    const positions: number[] = [],
      colors: number[] = [],
      sizes: number[] = [];
    for (let i = 0; i < 26000; i++) {
      const x = (this.random() - 0.5) * 2900,
        spread = i % 5 === 0 ? 160 : i % 3 === 0 ? 95 : 40;
      const y = x * 0.37 + Math.sin(x * 0.002) * 75 + this.gaussian() * spread;
      const z = -450 - this.random() * 1800;
      const lane = Math.exp(-Math.pow((y - x * 0.37 + Math.sin(x * 0.009) * 25) / 32, 2));
      const v = (0.12 + Math.pow(this.random(), 3) * 0.6) * (1 - lane * 0.9);
      positions.push(x, y, z);
      colors.push(v * 0.78, v * 0.87, v);
      sizes.push(0.5 + Math.pow(this.random(), 8) * 3);
    }
    for (let i = 0; i < 1400; i++) {
      positions.push(
        (this.random() - 0.5) * 2500,
        (this.random() - 0.5) * 1700,
        400 - this.random() * 900,
      );
      const v = 0.2 + this.random() * 0.4;
      colors.push(v * 0.85, v * 0.9, v);
      sizes.push(0.5 + Math.pow(this.random(), 5) * 2);
    }
    this.field = this.points(positions, colors, sizes, 1500);
    this.scene.add(this.field);
    this.gas = new THREE.Mesh(
      new THREE.PlaneGeometry(2700, 1800),
      new THREE.ShaderMaterial({
        uniforms: { uFade: { value: 0 }, uMode: { value: 0 } },
        vertexShader:
          "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
        fragmentShader: `varying vec2 vUv;uniform float uFade;uniform float uMode;float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}float fbm(vec2 p){float f=0.,a=.5;for(int i=0;i<6;i++){f+=noise(p)*a;p=p*2.07+2.1;a*=.49;}return f;}void main(){vec2 p=(vUv-.5)*vec2(3.6,2.4);float f=fbm(p*3.),g=fbm(p*7.+f*2.);float band=p.y-p.x*.37+sin(p.x*1.7)*.08;float light=exp(-pow(band/.29,2.))*(.025+pow(f,3.)*.45);float core=exp(-pow((p.x-.65)/.7,2.)-pow(band/.23,2.));float lane=exp(-pow((band+.02+(g-.5)*.32)/.06,2.));vec3 color=mix(vec3(.18,.23,.33),vec3(.38,.28,.17),core);float density=(light+core*.045)*(1.-lane*.95);if(uMode>1.5){density=.1*exp(-dot(p*vec2(.8,1.3),p*vec2(.8,1.3)))*(f*.5+.5);color=vec3(.31,.27,.21);}gl_FragColor=vec4(color,density*uFade*3.);}`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(this.gas);
    this.resources.push(this.gas.geometry, this.gas.material);
    const bp = new Float32Array(this.layout.bodies.length * 3),
      bc: number[] = [],
      bs: number[] = [],
      bk: number[] = [];
    for (const body of this.layout.bodies) {
      bc.push(...(body.kind === "star" ? [2.1, 1.8, 1.28] : [1.3, 1.6, 1.96]));
      bs.push(5 + Math.pow(this.layout.neighbors.get(body.id)!.size + 1, 0.6) * 3);
      bk.push((knowledgePresence.get(body.id) ?? body.hasKnowledge) ? 1 : 0);
      knowledgePresence.set(body.id, body.hasKnowledge);
      if (knowledgePresence.size > 1000)
        knowledgePresence.delete(knowledgePresence.keys().next().value!);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(bp, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(bc, 3));
    geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(bs, 1));
    geometry.setAttribute("aKnown", new THREE.Float32BufferAttribute(bk, 1));
    geometry.setAttribute(
      "aFocus",
      new THREE.Float32BufferAttribute(
        this.layout.bodies.map(() => 1),
        1,
      ),
    );
    const material = new THREE.ShaderMaterial({
      uniforms: { uDpr: { value: Math.min(devicePixelRatio || 1, 1.6) } },
      vertexShader: `attribute vec3 color;attribute float aSize;attribute float aKnown;attribute float aFocus;varying vec3 vColor;varying float vKnown;uniform float uDpr;void main(){vKnown=aKnown;vColor=mix(vec3(.12,.24,.4),color,aKnown)*aFocus;vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*620./max(80.,-mv.z),8.,29.)*(.72+.28*aKnown)*uDpr;}`,
      fragmentShader: `varying vec3 vColor;varying float vKnown;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;float bright=exp(-r*r*34.)+.38*exp(-r*r*5.5);float ring=smoothstep(.26,.37,r)*(1.-smoothstep(.48,.63,r))*.72;gl_FragColor=vec4(vColor,mix(ring,bright,vKnown));}`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.beacons = new THREE.Points(geometry, material);
    this.beacons.frustumCulled = false;
    this.scene.add(this.beacons);
    this.resources.push(geometry, material);
    const pathGeometry = new THREE.BufferGeometry();
    pathGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(Math.max(1, graph.edges.length) * 18 * 6), 3),
    );
    pathGeometry.setDrawRange(0, 0);
    const pathMaterial = new THREE.LineBasicMaterial({
      color: 0xa8c8d9,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    });
    this.paths = new THREE.LineSegments(pathGeometry, pathMaterial);
    this.paths.frustumCulled = false;
    this.scene.add(this.paths);
    this.resources.push(pathGeometry, pathMaterial);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.intersection = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.report();
    });
    this.intersection.observe(canvas);
    this.bindInput();
    this.resize();
    this.reset(true);
    this.updatePositions();
    this.raf = requestAnimationFrame(this.frame);
  }
  private random() {
    this.rng = (this.rng * 1664525 + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }
  private gaussian() {
    return (
      Math.sqrt(-2 * Math.log(Math.max(0.00001, this.random()))) *
      Math.cos(this.random() * Math.PI * 2)
    );
  }
  private button(text: string, className: string, click: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = className;
    b.hidden = true;
    b.addEventListener("click", click, { signal: this.abort.signal });
    this.layer.append(b);
    return b;
  }
  private points(positions: number[], colors: number[], sizes: number[], scale: number) {
    const geometry = new THREE.BufferGeometry();
    const elliptical: number[] = [];
    for (let i = 0; i < positions.length / 3; i++)
      elliptical.push(
        this.gaussian() * 650 + 160,
        this.gaussian() * 330,
        this.gaussian() * 600 - 1000,
      );
    geometry.setAttribute("aElliptical", new THREE.Float32BufferAttribute(elliptical, 3));
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFade: { value: 1 },
        uDpr: { value: Math.min(devicePixelRatio || 1, 1.6) },
        uScale: { value: scale },
        uMode: { value: 0 },
      },
      vertexShader: pointVertex,
      fragmentShader: pointFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.resources.push(geometry, material);
    return new THREE.Points(geometry, material);
  }
  private addWorld(body: UniverseBody) {
    const material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uKind: { value: body.kind === "star" ? 0 : body.kind === "moon" ? 14 : 1 },
        uVariant: { value: 0 },
        uSeed: { value: (body.seed % 1000) * 0.73 },
        uTime: { value: 0 },
        uSelected: { value: 0 },
        uStar: { value: new THREE.Vector3() },
        uEye: { value: new THREE.Vector3() },
        uTone: { value: new THREE.Vector3(0.67, 0.81, 1) },
      },
    });
    const mesh = new THREE.Mesh(this.sphere, material);
    mesh.visible = false;
    this.scene.add(mesh);
    this.resources.push(material);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader:
        "varying vec3 n;varying vec3 e;void main(){vec4 p=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);e=normalize(-p.xyz);gl_Position=projectionMatrix*p;}",
      fragmentShader:
        "varying vec3 n;varying vec3 e;void main(){float rim=pow(1.-abs(dot(normalize(n),normalize(e))),3.6);gl_FragColor=vec4(.35,.55,.75,rim*.48);}",
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const atmosphere = new THREE.Mesh(this.sphere, atmosphereMaterial);
    atmosphere.visible = false;
    this.scene.add(atmosphere);
    this.resources.push(atmosphereMaterial);
    const ringMaterial = new THREE.ShaderMaterial({
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
    const ring = new THREE.Mesh(this.rings, ringMaterial);
    ring.visible = false;
    this.scene.add(ring);
    this.resources.push(ringMaterial);
    const surface = defaultSurface(body.kind, body.seed);
    this.objects.set(body.id, {
      body,
      position: new THREE.Vector3(),
      mesh,
      atmosphere,
      ring,
      surface,
      ringStyle: appearancesFor(body.kind)[surface]?.ring ?? "none",
      reveal: 0,
    });
    const label = this.button(body.title, "universe-node-label", () =>
      this.callbacks.select(body.id),
    );
    label.dataset.knowledge = body.hasKnowledge ? "recorded" : "empty";
    label.setAttribute("aria-label", body.title);
    for (const event of ["pointerenter", "focus"])
      label.addEventListener(
        event,
        () => {
          this.hover = body.id;
        },
        { signal: this.abort.signal },
      );
    for (const event of ["pointerleave", "blur"])
      label.addEventListener(
        event,
        () => {
          this.hover = null;
        },
        { signal: this.abort.signal },
      );
    this.labels.set(body.id, label);
  }
  private report() {
    this.callbacks.running(!this.paused && this.visible && !document.hidden && !this.disposed);
  }
  private navigation() {
    const region = this.layout.regions.find((r) => r.id === this.region);
    this.callbacks.navigation({
      level: this.level,
      region: this.region,
      label: this.selected ? this.objects.get(this.selected)!.body.title : (region?.label ?? ""),
    });
  }
  setPaused(value: boolean) {
    this.paused = value;
    this.report();
  }
  snapshot() {
    return {
      level: this.level,
      region: this.region,
      selected: this.selected,
      time: this.time,
      current: { ...this.current },
      target: { ...this.target },
    };
  }
  restore(snapshot: ReturnType<AtlasRenderer["snapshot"]>) {
    if (
      (snapshot.region && !this.centers.has(snapshot.region)) ||
      (snapshot.selected && !this.objects.has(snapshot.selected))
    )
      return;
    this.level = snapshot.level;
    this.region = snapshot.region;
    this.selected = snapshot.selected;
    this.time = snapshot.time;
    this.current = { ...snapshot.current };
    this.target = { ...snapshot.target };
    this.updatePositions();
    this.navigation();
  }
  setPath(ids: string[]) {
    this.relationPath = new Set(ids);
  }
  setStyle(id: string, style: CelestialStyle) {
    const o = this.objects.get(id);
    if (!o || !appearancesFor(o.body.kind)[style.surface]) return;
    o.surface = style.surface;
    o.ringStyle = style.ring ?? appearancesFor(o.body.kind)[style.surface].ring ?? "none";
  }
  setSelected(id: string | null) {
    if (id === this.selected) return;
    if (!id) {
      if (this.level === "planet" && this.region) this.enterRegion(this.region);
      return;
    }
    const o = this.objects.get(id);
    if (!o) return;
    this.selected = id;
    this.region = o.body.region;
    this.level = "planet";
    this.target.x = o.position.x;
    this.target.y = o.position.y;
    this.target.z = o.position.z;
    this.target.distance = o.body.radius * (this.width < 700 ? 6.8 : 6.1);
    this.target.yaw = 0.12;
    this.target.pitch = 0.08;
    this.hover = null;
    this.navigation();
  }
  enterRegion(id: string) {
    const region = this.layout.regions.find((r) => r.id === id);
    if (!region) return;
    this.selected = null;
    this.region = id;
    this.level = "galaxy";
    const c = this.centers.get(id)!;
    Object.assign(this.target, {
      x: c.x,
      y: c.y,
      z: c.z,
      yaw: -0.22,
      pitch: 0.14,
      distance: Math.max(600, (region.extent * 2.8) / Math.min(1, this.width / this.height)),
    });
    this.callbacks.clear();
    this.navigation();
  }
  back() {
    if (this.level === "planet" && this.region) this.enterRegion(this.region);
    else this.reset();
  }
  reset(immediate = false) {
    this.level = "universe";
    this.region = null;
    this.selected = null;
    const bounds = new THREE.Box3();
    for (const [id, center] of this.centers) {
      const radius = this.layout.regions.find((r) => r.id === id)!.extent;
      bounds.expandByPoint(center.clone().addScalar(radius));
      bounds.expandByPoint(center.clone().addScalar(-radius));
    }
    const center = this.centers.size ? bounds.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const size = this.centers.size
      ? bounds.getSize(new THREE.Vector3())
      : new THREE.Vector3(500, 500, 500);
    Object.assign(this.target, {
      x: center.x,
      y: center.y,
      z: center.z,
      distance: Math.max(900, Math.max(size.x / this.camera.aspect, size.y, size.z) * 1.5),
      yaw: -0.18,
      pitch: 0.2,
    });
    if (immediate) this.current = { ...this.target };
    else this.callbacks.clear();
    this.navigation();
  }
  zoomBy(factor: number) {
    this.target.distance = THREE.MathUtils.clamp(this.target.distance / factor, 35, 15000);
  }
  rotate(dx: number, dy: number) {
    this.target.yaw += dx;
    this.target.pitch = THREE.MathUtils.clamp(this.target.pitch + dy, -1.2, 1.2);
  }
  private resize() {
    this.width = Math.max(1, this.canvas.clientWidth);
    this.height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }
  private updatePositions() {
    for (const o of this.objects.values()) {
      const c = this.centers.get(o.body.region)!;
      o.position.set(...o.body.position).add(c);
      o.position.x += Math.sin(this.time * 0.07 + o.body.seed) * 2;
      o.position.y += Math.cos(this.time * 0.06 + o.body.seed) * 2.5;
    }
  }
  private updateCamera(dt: number) {
    const omega = 7,
      decay = Math.exp(-omega * dt);
    for (const key of Object.keys(this.target) as (keyof CameraState)[]) {
      const x = this.current[key] - this.target[key],
        v = this.velocity[key],
        c = v + omega * x;
      this.current[key] = this.target[key] + (x + c * dt) * decay;
      this.velocity[key] = (v - omega * c * dt) * decay;
    }
    const c = this.current,
      target = new THREE.Vector3(c.x, c.y, c.z);
    this.camera.position.set(
      c.x + Math.sin(c.yaw) * Math.cos(c.pitch) * c.distance,
      c.y + Math.sin(c.pitch) * c.distance,
      c.z + Math.cos(c.yaw) * Math.cos(c.pitch) * c.distance,
    );
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }
  private updatePaths() {
    let count = 0;
    const data = this.paths.geometry.attributes.position;
    for (const edge of this.graph.edges) {
      if (
        this.level !== "galaxy" ||
        !(
          edge.source === this.hover ||
          edge.target === this.hover ||
          (this.relationPath.has(edge.source) && this.relationPath.has(edge.target))
        )
      )
        continue;
      const a = this.objects.get(edge.source),
        b = this.objects.get(edge.target);
      if (!a || !b || a.body.region !== this.region || b.body.region !== this.region) continue;
      for (let i = 0; i < 18; i++)
        for (let j = 0; j < 2; j++) {
          const t = (i + j) / 18;
          data.setXYZ(
            count++,
            THREE.MathUtils.lerp(a.position.x, b.position.x, t),
            THREE.MathUtils.lerp(a.position.y, b.position.y, t) + Math.sin(t * Math.PI) * 14,
            THREE.MathUtils.lerp(a.position.z, b.position.z, t),
          );
        }
    }
    this.paths.geometry.setDrawRange(0, count);
    data.needsUpdate = true;
  }
  private project(p: THREE.Vector3) {
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (0.5 - v.y * 0.5) * this.height, z: v.z };
  }
  private drawLabels() {
    const boxes: { x: number; y: number; w: number }[] = [];
    const place = (label: HTMLButtonElement, p: THREE.Vector3, show: boolean) => {
      const q = this.project(p),
        w = Math.min(180, Math.max(65, label.textContent!.length * 10));
      const x = q.x + 9,
        y = q.y + 5;
      const valid =
        show &&
        q.z > -1 &&
        q.z < 1 &&
        x > 0 &&
        x + w < this.width - 4 &&
        y > 62 &&
        y + 28 < this.height - 52 &&
        !boxes.some((b) => x < b.x + b.w && x + w > b.x && y < b.y + 28 && y + 28 > b.y);
      label.hidden = !valid;
      if (valid) {
        label.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        label.style.maxWidth = w + "px";
        boxes.push({ x, y, w });
      }
    };
    for (const [id, label] of this.galaxyLabels)
      place(label, this.centers.get(id)!, this.level === "universe");
    const sorted = [...this.objects.values()].sort(
      (a, b) =>
        Number(b.body.id === this.hover) - Number(a.body.id === this.hover) ||
        Number(b.body.hasKnowledge) - Number(a.body.hasKnowledge) ||
        b.body.radius - a.body.radius,
    );
    for (const o of sorted) {
      const neighbor = this.hover && this.layout.neighbors.get(this.hover)?.has(o.body.id);
      const show =
        this.level === "galaxy" &&
        o.body.region === this.region &&
        (o.body.kind !== "moon" || neighbor || this.hover === o.body.id);
      const label = this.labels.get(o.body.id)!;
      label.style.opacity = this.hover && o.body.id !== this.hover && !neighbor ? ".3" : "1";
      place(label, o.position, Boolean(show));
    }
  }
  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - (this.previous || now - 16)) / 1000);
    this.previous = now;
    if (!this.visible || document.hidden) return;
    if (!this.paused) {
      this.time += dt;
      if (!this.drag && !this.hover && this.level !== "planet")
        this.target.yaw += dt * (this.level === "universe" ? 0.006 : 0.002);
    }
    this.updatePositions();
    if (this.selected) {
      const p = this.objects.get(this.selected)!.position;
      this.target.x = p.x;
      this.target.y = p.y;
      this.target.z = p.z;
    }
    this.updateCamera(dt);
    for (const galaxy of this.galaxies.values()) {
      galaxy.visible = this.level === "universe";
      galaxy.material.uniforms.uTime.value = this.time;
    }
    const center = this.region ? this.centers.get(this.region)! : new THREE.Vector3();
    this.field.visible = this.level !== "universe";
    this.field.position.copy(center);
    this.field.material.uniforms.uTime.value = this.time;
    const morphology = this.layout.regions.findIndex((r) => r.id === this.region) % 3;
    this.field.material.uniforms.uMode.value = morphology;
    this.field.rotation.z = morphology === 1 ? -0.32 : 0;
    this.gas.rotation.z = this.field.rotation.z;
    this.field.material.uniforms.uFade.value = this.level === "planet" ? 0.3 : 1;
    this.gas.visible = this.level !== "universe";
    this.gas.position.copy(center).add(new THREE.Vector3(0, 0, -1000));
    this.gas.material.uniforms.uFade.value = this.level === "planet" ? 0.3 : 1;
    this.gas.material.uniforms.uMode.value =
      this.layout.regions.findIndex((r) => r.id === this.region) % 3;
    const pos = this.beacons.geometry.attributes.position,
      focus = this.beacons.geometry.attributes.aFocus,
      known = this.beacons.geometry.attributes.aKnown;
    this.layout.bodies.forEach((body, i) => {
      const o = this.objects.get(body.id)!;
      known.setX(
        i,
        known.getX(i) +
          ((body.hasKnowledge ? 1 : 0) - known.getX(i)) *
            (this.paused ? 1 : 1 - Math.exp(-dt * 2.8)),
      );
      const target = this.level === "planet" && this.selected === body.id ? 1 : 0;
      o.reveal += (target - o.reveal) * (1 - Math.exp(-dt * 3));
      const shown = this.level === "galaxy" && body.region === this.region;
      pos.setXYZ(
        i,
        shown ? o.position.x : 1e6,
        shown ? o.position.y : 1e6,
        shown ? o.position.z : 1e6,
      );
      focus.setX(
        i,
        this.hover
          ? this.hover === body.id
            ? 1.6
            : this.layout.neighbors.get(this.hover)?.has(body.id)
              ? 1.25
              : 0.24
          : 1,
      );
      o.mesh.visible = o.reveal > 0.01 && body.region === this.region;
      o.mesh.position.copy(o.position);
      o.mesh.scale.setScalar(body.radius * Math.max(0.01, o.reveal));
      o.mesh.rotation.y = this.time * 0.018 + body.seed;
      const def = appearancesFor(body.kind)[o.surface],
        u = o.mesh.material.uniforms;
      u.uTime.value = this.time;
      u.uEye.value.copy(this.camera.position);
      u.uStar.value.copy(o.position).add(new THREE.Vector3(-300, 220, 300));
      u.uKind.value = body.kind === "star" ? 0 : body.kind === "moon" ? 14 : (def.model ?? 10);
      u.uVariant.value = Object.keys(appearancesFor(body.kind)).indexOf(o.surface);
      u.uTone.value.set(...(def.tone ?? [171, 207, 255]).map((v) => v / 255));
      o.atmosphere.visible = o.mesh.visible && body.kind !== "star";
      o.atmosphere.position.copy(o.position);
      o.atmosphere.scale.setScalar(o.mesh.scale.x * 1.025);
      o.ring.visible = o.mesh.visible && o.ringStyle !== "none";
      o.ring.position.copy(o.position);
      o.ring.scale.copy(o.mesh.scale);
      o.ring.rotation.set(1.25, 0.1, -0.2);
      const ru = o.ring.material.uniforms;
      ru.uRingStyle.value = Object.keys(ringDefs).indexOf(o.ringStyle);
      ru.uCold.value = o.ringStyle === "icy" ? 1 : 0;
      ru.uCenter.value.copy(o.position);
      ru.uRadius.value = o.mesh.scale.x;
      ru.uStar.value.copy(u.uStar.value);
    });
    pos.needsUpdate = true;
    focus.needsUpdate = true;
    known.needsUpdate = true;
    this.beacons.visible = this.level === "galaxy";
    this.updatePaths();
    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
  };
  private pick(x: number, y: number) {
    const candidates =
      this.level === "universe"
        ? [...this.centers].map(([id, p]) => ({ id, p }))
        : [...this.objects.values()]
            .filter((o) => o.body.region === this.region)
            .map((o) => ({ id: o.body.id, p: o.position }));
    let best: string | null = null,
      distance = this.level === "universe" ? 100 : 26;
    for (const item of candidates) {
      const p = this.project(item.p),
        d = Math.hypot(x - p.x, y - p.y);
      if (p.z > -1 && p.z < 1 && d < distance) {
        best = item.id;
        distance = d;
      }
    }
    return best;
  }
  private bindInput() {
    const signal = this.abort.signal,
      local = (e: PointerEvent) => {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
    this.canvas.addEventListener(
      "pointerdown",
      (e) => {
        const p = local(e);
        this.pointers.set(e.pointerId, p);
        this.canvas.setPointerCapture(e.pointerId);
        this.drag = { ...p, moved: false };
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()];
          this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
        }
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointermove",
      (e) => {
        const p = local(e);
        if (!this.pointers.has(e.pointerId)) {
          this.hover = this.level === "galaxy" ? this.pick(p.x, p.y) : null;
          return;
        }
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()],
            distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (this.pinch) this.zoomBy(distance / Math.max(1, this.pinch));
          this.pinch = distance;
          if (this.drag) this.drag.moved = true;
          return;
        }
        if (this.drag) {
          const dx = p.x - this.drag.x,
            dy = p.y - this.drag.y;
          if (Math.hypot(dx, dy) > 2) this.drag.moved = true;
          this.rotate(-dx * 0.004, dy * 0.003);
          this.drag.x = p.x;
          this.drag.y = p.y;
        }
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointerup",
      (e) => {
        const p = local(e),
          drag = this.drag;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size) return;
        this.drag = null;
        this.pinch = 0;
        if (drag && !drag.moved) {
          const id = this.pick(p.x, p.y);
          if (id) {
            if (this.level === "universe") this.enterRegion(id);
            else this.callbacks.select(id);
          }
        }
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointerleave",
      () => {
        this.hover = null;
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointercancel",
      () => {
        this.drag = null;
        this.pointers.clear();
        this.pinch = 0;
      },
      { signal },
    );
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.001));
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
    document.addEventListener("visibilitychange", () => this.report(), { signal });
  }
  thumbnail(kind: CelestialKind, surface: string) {
    if (!this.library) {
      const canvas = document.createElement("canvas"),
        layer = document.createElement("div");
      this.library = new SurfaceLibrary(
        canvas,
        layer,
        { nodes: [], edges: [] },
        { select: () => {}, running: () => {}, failed: () => {}, label: this.callbacks.label },
      );
      this.library.setPaused(true);
    }
    return this.library.thumbnail(kind, surface);
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.abort.abort();
    this.observer.disconnect();
    this.intersection.disconnect();
    this.layer.replaceChildren();
    this.library?.dispose();
    for (const resource of this.resources) resource.dispose();
    this.renderer.dispose();
    this.callbacks.running(false);
  }
}
