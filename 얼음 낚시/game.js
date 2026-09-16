// ===== 얼음 낚시 프로토타입 =====

const stage = document.getElementById('stage');

// ----- 렌더러 -----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

// ----- 씬 -----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfe6f5);

// ----- 아이소메트릭(직교) 카메라 - 캐릭터를 항상 화면 중앙에 두고 따라다님 -----
const VIEW_SIZE = 10;
const camDist = 24;
const CAM_OFFSET = new THREE.Vector3(camDist, camDist, camDist);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 150);
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const aspect = w / h;
  camera.left = -VIEW_SIZE * aspect;
  camera.right = VIEW_SIZE * aspect;
  camera.top = VIEW_SIZE;
  camera.bottom = -VIEW_SIZE;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener('resize', resize);
resize();

// ----- 조명 -----
const hemi = new THREE.HemisphereLight(0xffffff, 0x88aabb, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(15, 25, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
scene.add(sun);

// ----- 얼음 바닥 -----
const GROUND_SIZE = 120;
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
  new THREE.MeshStandardMaterial({ color: 0xe8f6ff, roughness: 0.6, metalness: 0.05 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE / 2, 0x9fd6ee, 0xbfe4f5);
grid.position.y = 0.01;
scene.add(grid);

// =====================================================================
// 전역 상태
// =====================================================================
let money = 0;
let totalEarned = 0;
let totalPlayTime = 0;
let gameEnded = false;

let MOVE_SPEED = 6;
let CARRY_CAPACITY = 3;
const carriedItems = [];
const carriedItemMeshes = [];

const SELL_RATE = 2; // $ per lb (기본 단가, 강 확장 배율이 곱해짐)
let riverValueMultiplier = 1; // 강 확장할 때마다 2배씩

let MAX_FISH = 5;
const fishes = [];
let elapsedTime = 0;

const iceBlocks = [];
let maxIceBlocks = 0;

// 강을 처음부터 가로로 길게 깔아두고, 확장은 "폭(깊이)"만 넓어지도록 함
const WATER_BASE = { minX: -13, maxX: 13, minZ: -16, maxZ: -12 };
const WF = { ...WATER_BASE };
const PLAY_BOUNDS = { minX: -15, maxX: 15, minZ: -20, maxZ: 16 };

const HARPOON = {
  platformCenter: new THREE.Vector3(0, 0, -9.5),
  platformRadius: 2,
  gunPosition: new THREE.Vector3(0, 0, -12),
  fireInterval: 1.5,
  timer: 0,
  barrelRecoil: 0,
  damage: 1,
};
HARPOON.tipPosition = HARPOON.gunPosition.clone().add(new THREE.Vector3(0, 0.7, -1.2));
let autoFishingUnlocked = false;

const PIPELINE = [
  { key: 'oven', name: '오븐', center: new THREE.Vector3(4, 0, -7), radius: 1.6, fromStage: 'raw', toStage: 'cooked', pile: [], timer: 0, pileGroup: null, cookTime: 2.5, cooking: null, waitQueue: [] },
  { key: 'slicer', name: '슬라이서', center: new THREE.Vector3(4, 0, 1), radius: 1.6, fromStage: 'cooked', toStage: 'sliced', pile: [], timer: 0, pileGroup: null },
  { key: 'serving', name: '서빙', center: new THREE.Vector3(4, 0, 9), radius: 1.6, fromStage: 'sliced', toStage: 'sold', pile: [], timer: 0, pileGroup: null },
];

const BELT_SPEED = 2.0;
function makeBelt(from, to) {
  return { unlocked: false, from: from.clone(), to: to.clone(), items: [], duration: from.distanceTo(to) / BELT_SPEED };
}
const BELTS = [
  makeBelt(HARPOON.gunPosition.clone().add(new THREE.Vector3(0, 0.22, 0.8)), PIPELINE[0].center),
  makeBelt(PIPELINE[0].center, PIPELINE[1].center),
  makeBelt(PIPELINE[1].center, PIPELINE[2].center),
];

// 손님 대기열 - 남쪽 입구에서 한 명씩 걸어들어와 자리에 쌓임
const waitingCustomers = [];
let npcSpawnTimer = 0;
let npcSpawnInterval = 4;
const CUSTOMER_QUEUE_SLOTS = [0, 1, 2, 3, 4].map((i) => new THREE.Vector3(2.6, 0, -1.8 + i * 0.9));
const CUSTOMER_ENTRY = new THREE.Vector3(4, 0, 14.5);
const CUSTOMER_WALK_SPEED = 3;

// =====================================================================
// 공용 헬퍼
// =====================================================================
function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  scene.remove(group);
}

function makeLabelSprite(text, bg) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg || 'rgba(20,20,20,0.75)';
  ctx.beginPath();
  ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  const lineH = 26;
  const startY = canvas.height / 2 - ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, startY + i * lineH));

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.2, 1.1, 1);
  return sprite;
}

function makeBounceLabel(text, bg) {
  const sprite = makeLabelSprite(text, bg || 'rgba(15,60,95,0.88)');
  sprite.scale.set(3.2, 1.3, 1);
  sprite.userData.baseScale = { x: sprite.scale.x, y: sprite.scale.y };
  return sprite;
}

function styleForStage(stageName) {
  if (stageName === 'cooked') return 0xffa832;
  if (stageName === 'sliced') return 0xffe066;
  return 0x4a86b5;
}

function sellValue(item) {
  return Math.round(item.weight * SELL_RATE * riverValueMultiplier);
}

function orientArrowAlong(mesh, from, to) {
  const dir = new THREE.Vector3().subVectors(to, from);
  dir.y = 0;
  dir.normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

// ----- 작살 로프 -----
const ropeGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const ropeMaterial = new THREE.LineBasicMaterial({ color: 0xdddddd });
const ropeLine = new THREE.Line(ropeGeometry, ropeMaterial);
ropeLine.visible = false;
scene.add(ropeLine);

function updateRope(p1, p2) {
  const pos = ropeLine.geometry.attributes.position;
  pos.setXYZ(0, p1.x, p1.y, p1.z);
  pos.setXYZ(1, p2.x, p2.y, p2.z);
  pos.needsUpdate = true;
  ropeLine.visible = true;
}
function hideRope() {
  ropeLine.visible = false;
}

// ----- 판매 팝업 -----
const moneyPopups = [];
function spawnMoneyPopup(position, amount) {
  const label = makeLabelSprite(`+$${amount}`, 'rgba(20,90,20,0.85)');
  label.scale.set(1.6, 0.8, 1);
  label.position.copy(position);
  label.position.y = 1.8;
  scene.add(label);
  moneyPopups.push({ mesh: label, life: 0 });
}
function updateMoneyPopups(dt) {
  for (let i = moneyPopups.length - 1; i >= 0; i--) {
    const p = moneyPopups[i];
    p.life += dt;
    const t = p.life / 0.8;
    if (t >= 1) {
      scene.remove(p.mesh);
      p.mesh.material.map.dispose();
      p.mesh.material.dispose();
      moneyPopups.splice(i, 1);
      continue;
    }
    p.mesh.position.y = 1.8 + t * 1.2;
    p.mesh.material.opacity = 1 - t;
  }
}

// ----- 플레이어 캐릭터 -----
const player = new THREE.Group();
const body = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.5, 1.0, 4, 8),
  new THREE.MeshStandardMaterial({ color: 0xff7a45, roughness: 0.5 })
);
body.position.y = 1.0;
body.castShadow = true;
player.add(body);

const head = new THREE.Mesh(
  new THREE.SphereGeometry(0.4, 16, 16),
  new THREE.MeshStandardMaterial({ color: 0xffd7b0, roughness: 0.6 })
);
head.position.y = 1.9;
head.castShadow = true;
player.add(head);

const shadowBlob = new THREE.Mesh(
  new THREE.CircleGeometry(0.6, 20),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 })
);
shadowBlob.rotation.x = -Math.PI / 2;
shadowBlob.position.y = 0.02;
player.add(shadowBlob);

player.position.set(0, 0, 0);
scene.add(player);

// =====================================================================
// 경계(울타리) 시스템
// =====================================================================
function buildFence(points) {
  const group = new THREE.Group();
  const postMat = new THREE.MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.9 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x9c6a3e, roughness: 0.9 });

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const segments = Math.max(1, Math.round(len / 1.2));

    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), postMat);
      post.position.set(a.x + dx * t, 0.5, a.z + dz * t);
      post.castShadow = true;
      group.add(post);
    }

    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, len), railMat);
    rail.position.set((a.x + b.x) / 2, 0.65, (a.z + b.z) / 2);
    rail.rotation.y = Math.atan2(dx, dz);
    group.add(rail);
  }

  scene.add(group);
  return group;
}

buildFence([
  { x: PLAY_BOUNDS.minX, z: PLAY_BOUNDS.minZ },
  { x: PLAY_BOUNDS.maxX, z: PLAY_BOUNDS.minZ },
  { x: PLAY_BOUNDS.maxX, z: PLAY_BOUNDS.maxZ },
  { x: PLAY_BOUNDS.minX, z: PLAY_BOUNDS.maxZ },
  { x: PLAY_BOUNDS.minX, z: PLAY_BOUNDS.minZ },
]);

function buildWaterFence() {
  return buildFence([
    { x: WF.minX, z: WF.minZ },
    { x: WF.maxX, z: WF.minZ },
    { x: WF.maxX, z: WF.maxZ },
    { x: WF.minX, z: WF.maxZ },
    { x: WF.minX, z: WF.minZ },
  ]);
}

function clampToPlayArea(point) {
  point.x = THREE.MathUtils.clamp(point.x, PLAY_BOUNDS.minX, PLAY_BOUNDS.maxX);
  point.z = THREE.MathUtils.clamp(point.z, PLAY_BOUNDS.minZ, PLAY_BOUNDS.maxZ);

  const margin = 0.6;
  const inWaterX = point.x > WF.minX - margin && point.x < WF.maxX + margin;
  const inWaterZ = point.z > WF.minZ - margin && point.z < WF.maxZ + margin;
  if (inWaterX && inWaterZ) {
    const distLeft = point.x - (WF.minX - margin);
    const distRight = (WF.maxX + margin) - point.x;
    const distNear = point.z - (WF.minZ - margin);
    const distFar = (WF.maxZ + margin) - point.z;
    const min = Math.min(distLeft, distRight, distNear, distFar);
    if (min === distLeft) point.x = WF.minX - margin;
    else if (min === distRight) point.x = WF.maxX + margin;
    else if (min === distNear) point.z = WF.minZ - margin;
    else point.z = WF.maxZ + margin;
  }
  return point;
}

// ----- 클릭 이동 -----
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const moveTarget = new THREE.Vector3().copy(player.position);
let isMoving = false;

function getPointerNDC(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

function onPointerDown(clientX, clientY) {
  if (gameEnded) return;
  getPointerNDC(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(ground)[0];
  if (!hit) return;

  moveTarget.copy(hit.point);
  moveTarget.y = 0;
  clampToPlayArea(moveTarget);
  isMoving = true;
  spawnClickMarker(moveTarget);
}

renderer.domElement.addEventListener('mousedown', (e) => onPointerDown(e.clientX, e.clientY));
renderer.domElement.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (t) onPointerDown(t.clientX, t.clientY);
  e.preventDefault();
}, { passive: false });

const markerPool = [];
function spawnClickMarker(pos) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.45, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(pos);
  ring.position.y = 0.03;
  scene.add(ring);
  markerPool.push({ mesh: ring, life: 0 });
}

function updateMarkers(dt) {
  for (let i = markerPool.length - 1; i >= 0; i--) {
    const m = markerPool[i];
    m.life += dt;
    const t = m.life / 0.4;
    if (t >= 1) {
      scene.remove(m.mesh);
      m.mesh.geometry.dispose();
      m.mesh.material.dispose();
      markerPool.splice(i, 1);
      continue;
    }
    const s = 1 + t * 1.5;
    m.mesh.scale.set(s, s, s);
    m.mesh.material.opacity = 0.9 * (1 - t);
  }
}

// =====================================================================
// 자금 / HUD
// =====================================================================
const moneyEl = document.getElementById('money');
function updateMoneyUI() {
  moneyEl.textContent = `자금: $${money}`;
}
updateMoneyUI();

const catchEl = document.getElementById('catch');
function updateCatchUI() {
  const ovenWait = PIPELINE[0].pile.length;
  const slicerWait = PIPELINE[1].pile.length;
  const servingWait = PIPELINE[2].pile.length;
  catchEl.textContent = `등짐 ${carriedItems.length}/${CARRY_CAPACITY} · 오븐대기 ${ovenWait} · 슬라이서대기 ${slicerWait} · 서빙대기 ${servingWait} · 손님 ${waitingCustomers.length}`;
}
updateCatchUI();

// =====================================================================
// 등짐 운반 시스템
// =====================================================================
function addCarriedItem(item) {
  if (carriedItems.length >= CARRY_CAPACITY) return false;
  carriedItems.push(item);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshStandardMaterial({ color: styleForStage(item.stage), roughness: 0.6 })
  );
  mesh.scale.set(1, 0.7, 1.8);
  mesh.position.set(0, 2.1 + carriedItemMeshes.length * 0.3, -0.35);
  player.add(mesh);
  carriedItemMeshes.push(mesh);
  updateCatchUI();
  return true;
}

function removeCarriedItemByRef(item) {
  const idx = carriedItems.indexOf(item);
  if (idx === -1) return;
  const mesh = carriedItemMeshes[idx];
  player.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
  carriedItems.splice(idx, 1);
  carriedItemMeshes.splice(idx, 1);
  carriedItemMeshes.forEach((m, i) => { m.position.y = 2.1 + i * 0.3; });
}

function updateCarriedVisualByRef(item) {
  const idx = carriedItems.indexOf(item);
  if (idx === -1) return;
  carriedItemMeshes[idx].material.color.setHex(styleForStage(item.stage));
}

// =====================================================================
// 3단 가공 파이프라인
// =====================================================================
function refreshPileVisual(station) {
  if (station.pileGroup) disposeGroup(station.pileGroup);
  const group = new THREE.Group();
  const color = styleForStage(station.toStage === 'sold' ? 'sliced' : station.toStage);
  for (let i = 0; i < station.pile.length; i++) {
    const cube = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.16, 0.35),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
    );
    cube.position.set(0.3, 0.1 + i * 0.18, 0.3);
    group.add(cube);
  }
  group.position.copy(station.center);
  group.position.y = 0;
  scene.add(group);
  station.pileGroup = group;
  updateCatchUI();
}

function spawnOnBelt(belt, item) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 8, 6),
    new THREE.MeshStandardMaterial({ color: styleForStage(item.stage), roughness: 0.5 })
  );
  mesh.scale.set(1, 0.7, 1.6);
  mesh.position.copy(belt.from);
  scene.add(mesh);
  belt.items.push({ item, mesh, t: 0 });
}

function processArrival(item, stationIdx, cameFromBelt) {
  const station = PIPELINE[stationIdx];

  if (station.key === 'serving') {
    item.stage = 'sold';
    if (!cameFromBelt) removeCarriedItemByRef(item);
    station.pile.push(item);
    refreshPileVisual(station);
    updateCatchUI();
    return;
  }

  item.stage = station.toStage;
  const nextBelt = BELTS[stationIdx + 1];
  if (nextBelt.unlocked) {
    if (!cameFromBelt) removeCarriedItemByRef(item);
    spawnOnBelt(nextBelt, item);
  } else if (cameFromBelt) {
    station.pile.push(item);
    refreshPileVisual(station);
  } else {
    updateCarriedVisualByRef(item);
  }
  updateCatchUI();
}

function enqueueOven(item, cameFromBelt) {
  if (item.enqueuedForCooking) return;
  item.enqueuedForCooking = true;
  PIPELINE[0].waitQueue.push({ item, cameFromBelt });
}

function finishOvenItem(item, cameFromBelt) {
  item.stage = 'cooked';
  item.enqueuedForCooking = false;
  const nextBelt = BELTS[1];
  if (nextBelt.unlocked) {
    if (!cameFromBelt) removeCarriedItemByRef(item);
    spawnOnBelt(nextBelt, item);
  } else if (cameFromBelt) {
    PIPELINE[0].pile.push(item);
    refreshPileVisual(PIPELINE[0]);
  } else {
    updateCarriedVisualByRef(item);
  }
  updateCatchUI();
}

let ovenRingMesh = null;
function updateOvenRing(t) {
  if (ovenRingMesh) {
    scene.remove(ovenRingMesh);
    ovenRingMesh.geometry.dispose();
    ovenRingMesh.material.dispose();
    ovenRingMesh = null;
  }
  const theta = Math.max(t * Math.PI * 2, 0.001);
  const geo = new THREE.RingGeometry(0.35, 0.55, 24, 1, -Math.PI / 2, theta);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffcc33, side: THREE.DoubleSide });
  ovenRingMesh = new THREE.Mesh(geo, mat);
  ovenRingMesh.rotation.x = -Math.PI / 2;
  ovenRingMesh.position.copy(PIPELINE[0].center);
  ovenRingMesh.position.y = 1.4;
  scene.add(ovenRingMesh);
}
function hideOvenRing() {
  if (!ovenRingMesh) return;
  scene.remove(ovenRingMesh);
  ovenRingMesh.geometry.dispose();
  ovenRingMesh.material.dispose();
  ovenRingMesh = null;
}

function updateOvenCooking(dt) {
  const oven = PIPELINE[0];
  if (oven.cooking) {
    oven.cooking.timer += dt;
    const t = Math.min(oven.cooking.timer / oven.cookTime, 1);
    updateOvenRing(t);
    if (t >= 1) {
      const { item, cameFromBelt } = oven.cooking;
      oven.cooking = null;
      hideOvenRing();
      finishOvenItem(item, cameFromBelt);
    }
  } else if (oven.waitQueue.length > 0) {
    const next = oven.waitQueue.shift();
    oven.cooking = { item: next.item, timer: 0, cameFromBelt: next.cameFromBelt };
  }
}

function spawnRawItemFromCatch(weight) {
  const item = { weight, stage: 'raw' };
  if (BELTS[0].unlocked) {
    spawnOnBelt(BELTS[0], item);
  } else {
    addCarriedItem(item);
  }
  updateCatchUI();
}

function updateBelts(dt) {
  BELTS.forEach((belt, idx) => {
    if (!belt.unlocked) return;
    for (let i = belt.items.length - 1; i >= 0; i--) {
      const entry = belt.items[i];
      entry.t += dt / belt.duration;
      if (entry.t >= 1) {
        scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh.material.dispose();
        belt.items.splice(i, 1);
        if (idx === 0) enqueueOven(entry.item, true);
        else processArrival(entry.item, idx, true);
        continue;
      }
      entry.mesh.position.lerpVectors(belt.from, belt.to, entry.t);
      entry.mesh.position.y = 0.22 + Math.sin(entry.t * Math.PI * 6) * 0.02;
    }
  });
}

function updateStationManualProcessing(dt) {
  for (let i = 0; i < PIPELINE.length; i++) {
    const station = PIPELINE[i];
    const dx = player.position.x - station.center.x;
    const dz = player.position.z - station.center.z;
    if (Math.sqrt(dx * dx + dz * dz) > station.radius) {
      station.timer = 0;
      continue;
    }
    station.timer += dt;
    if (station.timer < 0.25) continue;
    station.timer = 0;

    const idx = carriedItems.findIndex((it) => it.stage === station.fromStage && !it.enqueuedForCooking);
    if (idx === -1) continue;

    if (i === 0) {
      enqueueOven(carriedItems[idx], false);
    } else {
      processArrival(carriedItems[idx], i, false);
    }
  }
}

function updateStationPickup() {
  for (let i = 0; i < PIPELINE.length - 1; i++) {
    const station = PIPELINE[i];
    if (station.pile.length === 0) continue;
    const dx = player.position.x - station.center.x;
    const dz = player.position.z - station.center.z;
    if (Math.sqrt(dx * dx + dz * dz) > station.radius) continue;
    if (carriedItems.length >= CARRY_CAPACITY) continue;
    const item = station.pile.shift();
    refreshPileVisual(station);
    addCarriedItem(item);
  }
}

function buildPipelineVisuals() {
  const MACHINE_COLOR = { oven: 0xaa4422, slicer: 0x8899aa, serving: 0x7fe0a0 };
  for (const station of PIPELINE) {
    const tile = new THREE.Mesh(
      new THREE.CircleGeometry(station.radius, 32),
      new THREE.MeshStandardMaterial({ color: MACHINE_COLOR[station.key], transparent: true, opacity: 0.35 })
    );
    tile.rotation.x = -Math.PI / 2;
    tile.position.copy(station.center);
    tile.position.y = 0.015;
    scene.add(tile);

    const machine = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 1.0, 1.2),
      new THREE.MeshStandardMaterial({ color: MACHINE_COLOR[station.key], roughness: 0.6 })
    );
    machine.position.copy(station.center);
    machine.position.y = 0.5;
    machine.castShadow = true;
    scene.add(machine);

    const label = makeLabelSprite(station.name);
    label.position.copy(station.center);
    label.position.y = 1.8;
    scene.add(label);
  }
}
buildPipelineVisuals();

// ----- 손님 대기열: 남쪽 입구에서 걸어들어와 쌓임 -----
function buildCustomerMesh(color) {
  const group = new THREE.Group();
  const bodyMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, 0.55, 4, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 })
  );
  bodyMesh.position.y = 0.55;
  bodyMesh.castShadow = true;
  group.add(bodyMesh);

  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe0c2, roughness: 0.7 })
  );
  headMesh.position.y = 1.05;
  group.add(headMesh);
  return group;
}

const CUSTOMER_COLORS = [0xffb6a3, 0xb6d8ff, 0xd8b6ff, 0xb6ffcf, 0xffe0a3];

function repositionCustomerQueue() {
  waitingCustomers.forEach((c, i) => {
    c.to = PIPELINE[2].center.clone().add(CUSTOMER_QUEUE_SLOTS[i]);
    c.walking = true;
  });
}

function spawnCustomer() {
  if (waitingCustomers.length >= CUSTOMER_QUEUE_SLOTS.length) return;
  const color = CUSTOMER_COLORS[waitingCustomers.length % CUSTOMER_COLORS.length];
  const mesh = buildCustomerMesh(color);
  mesh.position.copy(CUSTOMER_ENTRY);
  scene.add(mesh);
  waitingCustomers.push({ mesh, hop: 0, walking: true, to: CUSTOMER_ENTRY.clone() });
  repositionCustomerQueue();
  updateCatchUI();
}

function removeFrontCustomer() {
  const customer = waitingCustomers.shift();
  if (!customer) return;
  scene.remove(customer.mesh);
  customer.mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  repositionCustomerQueue();
  updateCatchUI();
}

function updateCustomerSpawning(dt) {
  npcSpawnTimer += dt;
  if (npcSpawnTimer >= npcSpawnInterval) {
    npcSpawnTimer = 0;
    spawnCustomer();
  }
}

function updateCustomerWalk(dt) {
  for (const c of waitingCustomers) {
    if (!c.walking) continue;
    const dir = new THREE.Vector3().subVectors(c.to, c.mesh.position);
    const dist = dir.length();
    if (dist < 0.1) {
      c.walking = false;
      c.mesh.position.copy(c.to);
      continue;
    }
    dir.normalize();
    c.mesh.position.addScaledVector(dir, Math.min(CUSTOMER_WALK_SPEED * dt, dist));
    c.mesh.rotation.y = Math.atan2(dir.x, dir.z);
  }
}

function updateNpcQueue(dt) {
  for (const c of waitingCustomers) {
    if (c.hop <= 0) continue;
    c.hop = Math.max(c.hop - dt * 3, 0);
    c.mesh.position.y = Math.sin(c.hop * Math.PI) * 0.35;
  }
}

function updateServingConsumption() {
  const station = PIPELINE[2];
  if (station.pile.length === 0 || waitingCustomers.length === 0) return;
  const item = station.pile.shift();
  refreshPileVisual(station);

  const frontCustomer = waitingCustomers[0];
  frontCustomer.hop = 1;
  removeFrontCustomer();

  const amount = sellValue(item);
  money += amount;
  totalEarned += amount;
  updateMoneyUI();
  spawnMoneyPopup(station.center, amount);
}

// =====================================================================
// 작살 포획 기구 + 물고기/얼음 HP 시스템
// =====================================================================
const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f7fb8, roughness: 0.3, metalness: 0.1 });
const water = new THREE.Mesh(new THREE.PlaneGeometry(WF.maxX - WF.minX, WF.maxZ - WF.minZ), waterMat);
water.rotation.x = -Math.PI / 2;
water.position.set((WF.minX + WF.maxX) / 2, 0.005, (WF.minZ + WF.maxZ) / 2);
scene.add(water);

let waterFenceGroup = buildWaterFence();

const platformRing = new THREE.Mesh(
  new THREE.RingGeometry(HARPOON.platformRadius - 0.15, HARPOON.platformRadius, 32),
  new THREE.MeshBasicMaterial({ color: 0x2266ff, side: THREE.DoubleSide })
);
platformRing.rotation.x = -Math.PI / 2;
platformRing.position.copy(HARPOON.platformCenter);
platformRing.position.y = 0.02;
scene.add(platformRing);

const platformFill = new THREE.Mesh(
  new THREE.CircleGeometry(HARPOON.platformRadius - 0.15, 32),
  new THREE.MeshBasicMaterial({ color: 0x2266ff, transparent: true, opacity: 0.12 })
);
platformFill.rotation.x = -Math.PI / 2;
platformFill.position.copy(HARPOON.platformCenter);
platformFill.position.y = 0.019;
scene.add(platformFill);

const harpoonGroup = new THREE.Group();
const baseMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1, 0.6, 1),
  new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.8 })
);
baseMesh.position.y = 0.3;
baseMesh.castShadow = true;
harpoonGroup.add(baseMesh);

const barrelMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(0.15, 0.18, 1.6, 12),
  new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.4, roughness: 0.4 })
);
barrelMesh.rotation.x = Math.PI / 2;
barrelMesh.position.set(0, 0.7, -0.6);
barrelMesh.castShadow = true;
harpoonGroup.add(barrelMesh);
harpoonGroup.position.copy(HARPOON.gunPosition);
scene.add(harpoonGroup);
HARPOON.barrelMesh = barrelMesh;
HARPOON.barrelBaseZ = barrelMesh.position.z;

const projectileMesh = new THREE.Mesh(
  new THREE.ConeGeometry(0.1, 0.6, 8),
  new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.3 })
);
projectileMesh.rotation.x = Math.PI / 2;
projectileMesh.visible = false;
scene.add(projectileMesh);
let projectileAnim = null;

function makeFishMesh(weight) {
  const group = new THREE.Group();
  const lightness = 0.6 - Math.min(weight / 10, 1) * 0.2;
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.55, 0.55, lightness), roughness: 0.5 });

  const bodyMesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), mat);
  const scale = 2.2 + Math.min(weight / 10, 1) * 1.6;
  bodyMesh.scale.set(scale, scale * 0.7, scale * 1.8);
  bodyMesh.castShadow = true;
  group.add(bodyMesh);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.22 * scale, 0.35 * scale, 8), mat);
  tail.rotation.x = Math.PI / 2;
  tail.position.z = -0.5 * scale;
  group.add(tail);

  return group;
}

const FISH_BASE_HP = 5;

function refreshHpLabel(target) {
  if (target.hpLabel) {
    target.mesh.remove(target.hpLabel);
    target.hpLabel.material.map.dispose();
    target.hpLabel.material.dispose();
    target.hpLabel = null;
  }
  const label = makeLabelSprite(`${target.hpRemaining}/${target.hp}`, 'rgba(150,20,20,0.85)');
  label.scale.set(1.3, 0.65, 1);
  label.position.y = 1.6;
  target.mesh.add(label);
  target.hpLabel = label;
}

function spawnFish() {
  if (fishes.length >= MAX_FISH) return;
  const weight = Math.round((1 + Math.random() * 9) * 10) / 10;
  const mesh = makeFishMesh(weight);
  const x = THREE.MathUtils.randFloat(WF.minX, WF.maxX);
  const z = THREE.MathUtils.randFloat(WF.minZ, WF.maxZ);
  mesh.position.set(x, 0.12, z);
  scene.add(mesh);

  const fish = {
    mesh,
    weight,
    hp: FISH_BASE_HP,
    hpRemaining: FISH_BASE_HP,
    state: 'swimming',
    dir: new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(),
    changeDirTimer: 1 + Math.random() * 2,
    bobPhase: Math.random() * Math.PI * 2,
  };

  const priceLabel = makeLabelSprite(`$${sellValue(fish)}`, 'rgba(20,70,20,0.8)');
  priceLabel.scale.set(1.1, 0.55, 1);
  priceLabel.position.y = 1.1;
  mesh.add(priceLabel);

  fishes.push(fish);
  refreshHpLabel(fish);
}
for (let i = 0; i < MAX_FISH; i++) spawnFish();

function spawnIceBlockInstance() {
  const weight = Math.round(100 + Math.random() * 50);
  const group = new THREE.Group();

  const ice = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.6, 0),
    new THREE.MeshStandardMaterial({ color: 0xcdeeff, transparent: true, opacity: 0.7, roughness: 0.15, metalness: 0.05 })
  );
  ice.castShadow = true;
  group.add(ice);

  const silhouette = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 12, 8),
    new THREE.MeshStandardMaterial({ color: 0x2f5f82, roughness: 0.6 })
  );
  silhouette.scale.set(1, 0.6, 1.8);
  group.add(silhouette);

  const hp = Math.round(8 + Math.random() * 4);
  const ice_ = {
    mesh: group,
    weight,
    hp,
    hpRemaining: hp,
    state: 'floating',
    bobPhase: Math.random() * Math.PI * 2,
  };

  const weightLabel = makeBounceLabel(`${weight}lb / $${sellValue(ice_)}`);
  weightLabel.position.y = 2.6;
  group.add(weightLabel);
  ice_.weightLabel = weightLabel;

  const x = THREE.MathUtils.randFloat(WF.minX + 2, WF.maxX - 2);
  const z = THREE.MathUtils.randFloat(WF.minZ + 2, WF.maxZ - 2);
  group.position.set(x, 0.3, z);
  scene.add(group);

  refreshHpLabel(ice_);
  iceBlocks.push(ice_);
}

function trySpawnIceBlocks() {
  while (iceBlocks.length < maxIceBlocks) spawnIceBlockInstance();
}

function findHarpoonTarget() {
  if (!BELTS[0].unlocked && carriedItems.length >= CARRY_CAPACITY) return null;

  let best = null;
  let bestKind = null;
  let bestKey = Infinity;

  for (const fish of fishes) {
    if (fish.state !== 'swimming') continue;
    const d = fish.mesh.position.distanceTo(HARPOON.gunPosition);
    const dealt = fish.hp - fish.hpRemaining;
    const key = d - dealt * 1000;
    if (key < bestKey) {
      bestKey = key;
      best = fish;
      bestKind = 'fish';
    }
  }
  for (const ice of iceBlocks) {
    if (ice.state !== 'floating') continue;
    const d = ice.mesh.position.distanceTo(HARPOON.gunPosition);
    const dealt = ice.hp - ice.hpRemaining;
    const key = d - dealt * 1000;
    if (key < bestKey) {
      bestKey = key;
      best = ice;
      bestKind = 'ice';
    }
  }
  return best ? { target: best, kind: bestKind } : null;
}

function hookTarget(target) {
  target.state = 'hooked';
  target.haulFrom = target.mesh.position.clone();
  target.haulTo = HARPOON.gunPosition.clone().add(new THREE.Vector3(0, 0.3, 0.8));
  target.haulDuration = target.weight >= 100 ? 3 + target.weight * 0.02 : 0.6 + target.weight * 0.15;
  target.haulTimer = 0;
}

function attachSpear(target) {
  const spear = new THREE.Mesh(
    new THREE.ConeGeometry(0.09, 0.5, 6),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.5, roughness: 0.4 })
  );
  spear.rotation.x = Math.PI / 2;
  spear.position.set(0, 0.3, 0);
  target.mesh.add(spear);
  target.spearMesh = spear;
}

function strikeTarget(target, kind, hits) {
  const activeState = kind === 'ice' ? 'floating' : 'swimming';
  if (target.state !== activeState) return false;
  target.hpRemaining = Math.max(0, target.hpRemaining - hits);
  if (target.hpRemaining <= 0) {
    hookTarget(target);
    attachSpear(target);
    return true;
  }
  refreshHpLabel(target);
  return false;
}

function fireHarpoon() {
  HARPOON.barrelRecoil = 1;
  const found = findHarpoonTarget();
  const target = found ? found.target : null;
  const from = HARPOON.tipPosition.clone();
  const to = target ? target.mesh.position.clone() : HARPOON.gunPosition.clone().add(new THREE.Vector3(0, 0.1, -4));

  projectileMesh.visible = true;
  projectileMesh.position.copy(from);
  projectileAnim = {
    t: 0,
    from,
    to,
    duration: 0.35,
    onComplete: () => {
      if (!target) {
        projectileMesh.visible = false;
        hideRope();
        return;
      }
      strikeTarget(target, found.kind, HARPOON.damage);
      projectileMesh.visible = false;
      if (target.state !== 'hooked') hideRope();
    },
  };
}

function updateHarpoon(dt) {
  const dx = player.position.x - HARPOON.platformCenter.x;
  const dz = player.position.z - HARPOON.platformCenter.z;
  const onPlatform = autoFishingUnlocked || Math.sqrt(dx * dx + dz * dz) <= HARPOON.platformRadius;

  if (onPlatform) {
    HARPOON.timer += dt;
    if (HARPOON.timer >= HARPOON.fireInterval) {
      HARPOON.timer = 0;
      fireHarpoon();
    }
  } else {
    HARPOON.timer = 0;
  }

  if (HARPOON.barrelRecoil > 0) {
    HARPOON.barrelRecoil = Math.max(HARPOON.barrelRecoil - dt * 3, 0);
    HARPOON.barrelMesh.position.z = HARPOON.barrelBaseZ - HARPOON.barrelRecoil * 0.3;
  }

  if (projectileAnim) {
    projectileAnim.t += dt;
    const p = Math.min(projectileAnim.t / projectileAnim.duration, 1);
    projectileMesh.position.lerpVectors(projectileAnim.from, projectileAnim.to, p);
    updateRope(HARPOON.tipPosition, projectileMesh.position);
    if (p >= 1) {
      const cb = projectileAnim.onComplete;
      projectileAnim = null;
      if (cb) cb();
    }
  }
}

function disposeFishLike(target) {
  scene.remove(target.mesh);
  target.mesh.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

function completeCatch(fish) {
  disposeFishLike(fish);
  fishes.splice(fishes.indexOf(fish), 1);
  hideRope();
  spawnRawItemFromCatch(fish.weight);
  setTimeout(spawnFish, 800 + Math.random() * 1200);
}

function completeIceCatch(ice) {
  disposeFishLike(ice);
  iceBlocks.splice(iceBlocks.indexOf(ice), 1);
  hideRope();
  spawnRawItemFromCatch(ice.weight);
  setTimeout(trySpawnIceBlocks, 5000 + Math.random() * 4000);
}

function updateFish(dt) {
  elapsedTime += dt;
  for (const fish of fishes) {
    if (fish.state === 'swimming') {
      fish.changeDirTimer -= dt;
      if (fish.changeDirTimer <= 0) {
        fish.dir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        fish.changeDirTimer = 1 + Math.random() * 2;
      }
      const speed = 1.2;
      const p = fish.mesh.position;
      p.addScaledVector(fish.dir, speed * dt);
      if (p.x < WF.minX || p.x > WF.maxX) {
        fish.dir.x *= -1;
        p.x = THREE.MathUtils.clamp(p.x, WF.minX, WF.maxX);
      }
      if (p.z < WF.minZ || p.z > WF.maxZ) {
        fish.dir.z *= -1;
        p.z = THREE.MathUtils.clamp(p.z, WF.minZ, WF.maxZ);
      }
      fish.mesh.rotation.y = Math.atan2(fish.dir.x, fish.dir.z);
      p.y = 0.12 + Math.sin(elapsedTime * 3 + fish.bobPhase) * 0.04;
    } else if (fish.state === 'hooked') {
      fish.haulTimer += dt;
      const t = Math.min(fish.haulTimer / fish.haulDuration, 1);
      fish.mesh.position.lerpVectors(fish.haulFrom, fish.haulTo, t);
      fish.mesh.position.y += Math.sin(t * Math.PI) * 0.8;
      updateRope(HARPOON.tipPosition, fish.mesh.position);
      if (t >= 1) completeCatch(fish);
    }
  }
}

function updateIceBlocks(dt) {
  for (const ice of iceBlocks) {
    ice.bobPhase += dt;
    const bounce = 1 + Math.sin(ice.bobPhase * 4) * 0.12;
    ice.weightLabel.scale.set(ice.weightLabel.userData.baseScale.x * bounce, ice.weightLabel.userData.baseScale.y * bounce, 1);

    if (ice.state === 'floating') {
      ice.mesh.position.y = 0.3 + Math.sin(ice.bobPhase * 1.5) * 0.08;
    } else if (ice.state === 'hooked') {
      ice.haulTimer += dt;
      const t = Math.min(ice.haulTimer / ice.haulDuration, 1);
      ice.mesh.position.lerpVectors(ice.haulFrom, ice.haulTo, t);
      ice.mesh.position.y += Math.sin(t * Math.PI) * 0.6;
      updateRope(HARPOON.tipPosition, ice.mesh.position);
      if (t >= 1) completeIceCatch(ice);
    }
  }
}

// =====================================================================
// 강 확장: 폭(깊이)만 넓어짐 + 얼음물고기 비중 증가 + 전체 가격 배율 상승
// =====================================================================
const RIVER_POPULATION = [
  { maxFish: 5, maxIce: 0 }, // tier 0
  { maxFish: 3, maxIce: 3 }, // tier 1 - 절반 정도가 얼음
  { maxFish: 0, maxIce: 6 }, // tier 2 - 전부 얼음
];

function applyRiverTier(tier) {
  const factor = tier === 1 ? 1.5 : 2.0;
  const cz = (WATER_BASE.minZ + WATER_BASE.maxZ) / 2;
  const halfD = ((WATER_BASE.maxZ - WATER_BASE.minZ) / 2) * factor;
  WF.minX = WATER_BASE.minX; // 가로 길이는 고정, 폭(깊이)만 확장
  WF.maxX = WATER_BASE.maxX;
  WF.minZ = cz - halfD;
  WF.maxZ = cz + halfD;

  water.geometry.dispose();
  water.geometry = new THREE.PlaneGeometry(WF.maxX - WF.minX, WF.maxZ - WF.minZ);
  water.position.set((WF.minX + WF.maxX) / 2, 0.005, (WF.minZ + WF.maxZ) / 2);
  water.material.color.setHex(tier === 1 ? 0x256d92 : 0x134f6e);

  disposeGroup(waterFenceGroup);
  waterFenceGroup = buildWaterFence();

  for (const fish of fishes.slice()) disposeFishLike(fish);
  fishes.length = 0;
  for (const ice of iceBlocks.slice()) disposeFishLike(ice);
  iceBlocks.length = 0;

  MAX_FISH = RIVER_POPULATION[tier].maxFish;
  maxIceBlocks = RIVER_POPULATION[tier].maxIce;
  for (let i = 0; i < MAX_FISH; i++) spawnFish();
  trySpawnIceBlocks();

  riverValueMultiplier *= 2; // 강을 강화할수록 모든 물고기 가격이 2배씩
}

// =====================================================================
// 업그레이드 발판
// =====================================================================
const UPGRADE_STATIONS = [];

function registerStation(st) {
  const tile = new THREE.Mesh(
    new THREE.CircleGeometry(st.radius, 32),
    new THREE.MeshStandardMaterial({ color: st.color, transparent: true, opacity: 0.8 })
  );
  tile.rotation.x = -Math.PI / 2;
  tile.position.copy(st.center);
  tile.position.y = 0.015;
  scene.add(tile);
  st.tileMesh = tile;

  const label = makeLabelSprite(`${st.name}\n$${st.costs[0]}`);
  label.position.copy(st.center);
  label.position.y = 2.2;
  scene.add(label);
  st.labelSprite = label;

  UPGRADE_STATIONS.push(st);
}

function refreshUpgradeLabel(st) {
  scene.remove(st.labelSprite);
  st.labelSprite.material.map.dispose();
  st.labelSprite.material.dispose();
  if (st.tier < st.costs.length) {
    const label = makeLabelSprite(`${st.name}\n$${st.costs[st.tier]}`);
    label.position.copy(st.center);
    label.position.y = 2.2;
    scene.add(label);
    st.labelSprite = label;
  } else {
    st.tileMesh.material.color.setHex(0xbdf0c4);
  }
}

function updateUpgradeStations() {
  for (const st of UPGRADE_STATIONS) {
    if (st.tier >= st.costs.length) continue;
    const dx = player.position.x - st.center.x;
    const dz = player.position.z - st.center.z;
    if (Math.sqrt(dx * dx + dz * dz) <= st.radius && money >= st.costs[st.tier]) {
      money -= st.costs[st.tier];
      updateMoneyUI();
      st.apply();
      st.tier += 1;
      refreshUpgradeLabel(st);
    }
  }
}

// [기계/동선 자동화 발판] 컨베이어 벨트 Part 1~3
function buildBeltVisual(belt) {
  const beltMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.1, belt.duration * BELT_SPEED),
    new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.7 })
  );
  beltMesh.position.lerpVectors(belt.from, belt.to, 0.5);
  beltMesh.position.y = 0.05;
  beltMesh.receiveShadow = true;
  scene.add(beltMesh);

  for (let i = 0; i <= 4; i++) {
    const chevron = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.35, 3),
      new THREE.MeshBasicMaterial({ color: 0xdddddd })
    );
    orientArrowAlong(chevron, belt.from, belt.to);
    chevron.position.lerpVectors(belt.from, belt.to, i / 4);
    chevron.position.y = 0.12;
    scene.add(chevron);
  }
}

function buildGuideArrows(from, to, color) {
  const group = new THREE.Group();
  const dist = from.distanceTo(to);
  const count = Math.max(2, Math.round(dist / 1.4));
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.24, 0.6, 3),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
    );
    orientArrowAlong(arrow, from, to);
    arrow.position.lerpVectors(from, to, t);
    arrow.position.y = 0.08;
    group.add(arrow);
  }
  scene.add(group);
  return group;
}

const GUIDE_ARROW_COLOR = 0xffcc33;
const guideArrowGroups = [
  buildGuideArrows(BELTS[0].from, BELTS[0].to, GUIDE_ARROW_COLOR),
  buildGuideArrows(BELTS[1].from, BELTS[1].to, GUIDE_ARROW_COLOR),
  buildGuideArrows(BELTS[2].from, BELTS[2].to, GUIDE_ARROW_COLOR),
];
function hideGuideArrows(idx) {
  guideArrowGroups[idx].visible = false;
}

registerStation({
  name: '벨트: 포획→오븐', center: new THREE.Vector3(8, 0, -8), radius: 1.6, costs: [40], tier: 0, color: 0xd8b3ff,
  apply: () => { BELTS[0].unlocked = true; buildBeltVisual(BELTS[0]); hideGuideArrows(0); },
});
registerStation({
  name: '벨트: 오븐→슬라이서', center: new THREE.Vector3(7, 0, -3), radius: 1.6, costs: [80], tier: 0, color: 0xd8b3ff,
  apply: () => {
    BELTS[1].unlocked = true;
    buildBeltVisual(BELTS[1]);
    hideGuideArrows(1);
    while (PIPELINE[0].pile.length) spawnOnBelt(BELTS[1], PIPELINE[0].pile.shift());
    refreshPileVisual(PIPELINE[0]);
  },
});
registerStation({
  name: '벨트: 슬라이서→서빙', center: new THREE.Vector3(7, 0, 5), radius: 1.6, costs: [150], tier: 0, color: 0xd8b3ff,
  apply: () => {
    BELTS[2].unlocked = true;
    buildBeltVisual(BELTS[2]);
    hideGuideArrows(2);
    while (PIPELINE[1].pile.length) spawnOnBelt(BELTS[2], PIPELINE[1].pile.shift());
    refreshPileVisual(PIPELINE[1]);
  },
});

// [스펙 업그레이드] - 가격을 완만하게, 단계 수를 늘림
registerStation({
  name: '이동속도', center: new THREE.Vector3(-6, 0, -2), radius: 1.5, costs: [20, 35, 55, 80, 110], tier: 0, color: 0xffe0a3,
  apply: () => { MOVE_SPEED *= 1.15; },
});
registerStation({
  name: '최대 소지량', center: new THREE.Vector3(-6, 0, 3), radius: 1.5, costs: [25, 50, 80, 120], tier: 0, color: 0xffc7c7,
  apply: () => { CARRY_CAPACITY += 2; updateCatchUI(); },
});
registerStation({
  name: '작살 연사속도', center: new THREE.Vector3(-10, 0, -2), radius: 1.5, costs: [20, 35, 55, 80, 110], tier: 0, color: 0xa3c9ff,
  apply: () => { HARPOON.fireInterval = Math.max(0.4, HARPOON.fireInterval * 0.85); },
});
const damageStation = {
  name: '작살 데미지', center: new THREE.Vector3(-10, 0, 3), radius: 1.5, costs: [30, 60, 100, 150, 220, 320, 450, 600], tier: 0, color: 0xa3c9ff,
  apply: null,
};
damageStation.apply = () => {
  if (damageStation.tier < 4) {
    HARPOON.damage += 1; // 앞 4단계는 확실하게 +1
  } else {
    HARPOON.damage = Math.round(HARPOON.damage * 1.15 * 10) / 10; // 이후엔 +15%로 점점 덜 중요해짐
  }
};
registerStation(damageStation);

registerStation({
  name: '자동 낚시', center: new THREE.Vector3(-6, 0, -7), radius: 1.5, costs: [250], tier: 0, color: 0x8be0c0,
  apply: () => { autoFishingUnlocked = true; },
});

const riverStation = {
  name: '강 확장', center: new THREE.Vector3(12, 0, -7), radius: 2, costs: [50, 150], tier: 0, color: 0xa3d8ff,
  apply: null,
};
riverStation.apply = () => applyRiverTier(riverStation.tier + 1);
registerStation(riverStation);

registerStation({
  name: '오븐 속도', center: new THREE.Vector3(13, 0, -3), radius: 1.5, costs: [25, 45, 70, 100, 140], tier: 0, color: 0xffb08a,
  apply: () => { PIPELINE[0].cookTime = Math.max(0.5, PIPELINE[0].cookTime * 0.85); },
});
registerStation({
  name: '손님 방문 속도', center: new THREE.Vector3(0, 0, 9), radius: 1.5, costs: [25, 45, 70, 100, 140, 190], tier: 0, color: 0x9fd8ff,
  apply: () => { npcSpawnInterval = Math.max(0.8, npcSpawnInterval * 0.7); },
});

// [엔딩]
const endingStation = {
  name: '엔딩', center: new THREE.Vector3(9, 0, 9), radius: 1.5, costs: [3000], tier: 0, color: 0xffd1e8,
  apply: () => triggerEnding(),
};
registerStation(endingStation);

// =====================================================================
// 시작 / 엔딩 화면
// =====================================================================
const startOverlay = document.getElementById('start-overlay');
const endingOverlay = document.getElementById('ending-overlay');
const endingTimeEl = document.getElementById('ending-time');
const endingMoneyEl = document.getElementById('ending-money');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

function triggerEnding() {
  gameEnded = true;
  const minutes = Math.floor(totalPlayTime / 60);
  const seconds = Math.floor(totalPlayTime % 60);
  endingTimeEl.textContent = `플레이 시간: ${minutes}분 ${seconds}초`;
  endingMoneyEl.textContent = `누적 수익: $${totalEarned}`;
  endingOverlay.style.display = 'flex';
}

restartBtn.addEventListener('click', () => location.reload());
startBtn.addEventListener('click', () => {
  startOverlay.style.display = 'none';
  clock.start();
  animate();
});

// =====================================================================
// 메인 루프
// =====================================================================
const clock = new THREE.Clock();

function updatePlayer(dt) {
  if (!isMoving) return;
  const toTarget = new THREE.Vector3().subVectors(moveTarget, player.position);
  toTarget.y = 0;
  const dist = toTarget.length();
  if (dist < 0.05) {
    isMoving = false;
    return;
  }
  toTarget.normalize();
  const step = Math.min(MOVE_SPEED * dt, dist);
  player.position.addScaledVector(toTarget, step);
  player.rotation.y = Math.atan2(toTarget.x, toTarget.z);
}

function updateCamera() {
  camera.position.copy(player.position).add(CAM_OFFSET);
  camera.lookAt(player.position);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!gameEnded) {
    totalPlayTime += dt;
    updatePlayer(dt);
    updateMarkers(dt);
    updateUpgradeStations();
    updateFish(dt);
    updateIceBlocks(dt);
    updateHarpoon(dt);
    updateBelts(dt);
    updateOvenCooking(dt);
    updateStationManualProcessing(dt);
    updateStationPickup();
    updateCustomerSpawning(dt);
    updateCustomerWalk(dt);
    updateServingConsumption();
    updateNpcQueue(dt);
    updateMoneyPopups(dt);
    updateCamera();
  }

  renderer.render(scene, camera);
}
