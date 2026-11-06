// Argos core: the rules every robot is held to, the stat forge, and the
// on-device store. Shared by /argos (the forge) and /argos/pilot (the
// controller). Everything lives in localStorage for now: no account, no
// server, no cost. The shapes below are the ones a real database would hold.

export const LAW = {
  title: "The Argos Law",
  articles: [
    ["I", "A robot is a companion first. It is never built, sold or modified as a weapon."],
    ["II", "Stats are forged once by Argos and cannot be changed. Parts can be swapped; numbers cannot."],
    ["III", "Combat is slam-down / sumo: push, pin, parry, dodge, stun. Nothing that cuts, burns, launches projectiles or harms people."],
    ["IV", "Every robot fits the class envelope (size, mass, power, speed). The envelope is game law and cannot be changed."],
    ["V", "Every robot carries cameras, proximity sensors, a hard e-stop and a printed 3D QR identity plate."],
    ["VI", "One pilot, one robot. Not replaceable, only upgradable."],
    ["VII", "A creator's own designs are private unless they choose otherwise. Arena entry needs full Argos clearance."],
    ["VIII", "A human casualty disqualifies. A robot destroyed is out of the match."],
  ],
};

// The envelope. Indicative numbers, chosen to keep every class safe on a
// tabletop or floor arena with people standing around it.
export const CLASSES = {
  pocket:  { label: "Pocket",  maxMm: 150, maxG: 450,  maxW: 15,  maxMs: 1.0 },
  desk:    { label: "Desk",    maxMm: 250, maxG: 1360, maxW: 40,  maxMs: 1.5 },
  floor:   { label: "Floor",   maxMm: 400, maxG: 3000, maxW: 90,  maxMs: 2.0 },
};

// Hard bans Argos refuses on sight. Kept short and literal.
const BANNED = [
  "blade", "saw", "spinner", "flame", "fire", "laser", "taser", "shock", "projectile",
  "gun", "shoot", "launcher", "spike", "drill", "explosive", "poison", "knife", "cutter",
  "hammer", "weapon",
];

export function bannedTermsIn(text) {
  const t = text.toLowerCase();
  return BANNED.filter((w) => new RegExp(`\\b${w}`).test(t));
}

// Deterministic: same design text, same stats. The seed is what makes the
// numbers "unchangeable" -- regenerating cannot reroll them.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let s = seed || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 10000) / 10000; };
}

const TEMPERAMENTS = [
  ["Loyal", "follows you around the room and waits by the charger at night"],
  ["Curious", "investigates every new object and logs it"],
  ["Playful", "nudges your hand when it wants a match"],
  ["Stoic", "says little, never retreats until told"],
  ["Protective", "positions itself between you and anything new"],
  ["Mischievous", "hides behind furniture and ambushes your feet"],
  ["Gentle", "slows down near pets and children on its own"],
  ["Proud", "does a little spin after every clean parry"],
];
const QUIRKS = [
  "hums when charging", "tilts its sensor head when you speak", "dislikes carpet",
  "greets the same person first every morning", "counts its wins out loud",
  "sulks for ten seconds after a loss", "follows light patches on the floor",
  "chirps at its own reflection",
];

export function classify(text) {
  const t = text.toLowerCase();
  if (/\b(pocket|tiny|small|mini|palm)\b/.test(t)) return "pocket";
  if (/\b(big|large|floor|heavy|tank)\b/.test(t)) return "floor";
  return "desk";
}

export function forgeRobot(design, name) {
  const seed = hash(design.trim().toLowerCase());
  const r = rng(seed);
  const cls = classify(design);
  const c = CLASSES[cls];
  const t = design.toLowerCase();
  // 400 points split across five stats; design words nudge the split.
  const w = {
    power: 1 + r() + (/\b(push|ram|strong|heavy|wedge|plow)\b/.test(t) ? 1 : 0),
    guard: 1 + r() + (/\b(armou?r|shell|shield|parry|tank)\b/.test(t) ? 1 : 0),
    agility: 1 + r() + (/\b(fast|quick|agile|dodge|wheels?|omni)\b/.test(t) ? 1 : 0),
    sense: 1 + r() + (/\b(camera|sensor|eye|lidar|scan)\b/.test(t) ? 1 : 0),
    stun: 1 + r() + (/\b(stun|flip|lift|grab|clamp)\b/.test(t) ? 1 : 0),
  };
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const stats = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.max(20, Math.round((v / sum) * 400))]));
  const temper = TEMPERAMENTS[seed % TEMPERAMENTS.length];
  const quirk = QUIRKS[(seed >>> 8) % QUIRKS.length];
  const drive = /\b(legs?|walk|walker|spider)\b/.test(t) ? "Legged (6-servo)" : /\b(track|tread)\b/.test(t) ? "Tracked" : /\bomni|mecanum\b/.test(t) ? "Mecanum 4WD" : "Differential 2WD";
  const id = "ARG-" + seed.toString(36).toUpperCase().slice(0, 6).padStart(6, "0");
  return {
    id,
    name: name || defaultName(seed),
    design,
    cls,
    envelope: c,
    massG: Math.round(c.maxG * (0.7 + r() * 0.28)),
    sizeMm: Math.round(c.maxMm * (0.75 + r() * 0.24)),
    stats,
    statsLocked: true,
    hp: 1000,
    temperament: temper[0],
    temperamentNote: temper[1],
    quirk,
    parts: defaultParts(drive, cls),
    sensors: ["Front camera (wide)", "Rear camera", "ToF proximity x4", "IMU", "Bumper switches", "Hard e-stop"],
    qr: id,
    createdAt: Date.now(),
    private: true,
    clearance: "pending",
  };
}

function defaultName(seed) {
  const a = ["Atlas", "Bishop", "Cobalt", "Echo", "Fable", "Juno", "Kestrel", "Onyx", "Pip", "Rook", "Sable", "Vesper"];
  return a[seed % a.length];
}

function defaultParts(drive, cls) {
  const shell = cls === "pocket" ? "PETG unibody" : "PETG chassis + TPU bumpers";
  return [
    { slot: "chassis", name: shell, condition: 100 },
    { slot: "drive", name: drive, condition: 100 },
    { slot: "front", name: "Sumo wedge (TPU lip)", condition: 100 },
    { slot: "arms", name: "Parry arm (1x servo)", condition: 100 },
    { slot: "stun", name: "Stun pulse: LED strobe + IR tag", condition: 100 },
    { slot: "brain", name: "ESP32-S3 + camera", condition: 100 },
    { slot: "power", name: "2S LiPo, fused", condition: 100 },
  ];
}

// Clearance: what Argos checks before a creator-made robot may enter the
// arena database. Each check returns [name, pass, note].
export function clearance(robot) {
  const env = CLASSES[robot.cls];
  const banned = bannedTermsIn(robot.design + " " + robot.parts.map((p) => p.name).join(" "));
  const checks = [
    ["Envelope: size", robot.sizeMm <= env.maxMm, `${robot.sizeMm} / ${env.maxMm} mm`],
    ["Envelope: mass", robot.massG <= env.maxG, `${robot.massG} / ${env.maxG} g`],
    ["Non-lethal parts", banned.length === 0, banned.length ? `refused: ${banned.join(", ")}` : "none found"],
    ["Stat budget", Object.values(robot.stats).reduce((a, b) => a + b, 0) <= 410, "forged, locked"],
    ["Sensors + cameras", robot.sensors.length >= 4, `${robot.sensors.length} fitted`],
    ["Hard e-stop", robot.sensors.some((s) => /e-stop/i.test(s)), "fitted"],
    ["QR identity plate", !!robot.qr, robot.qr],
  ];
  return { checks, cleared: checks.every((c) => c[1]) };
}

// --- storage -------------------------------------------------------------
const KEY = "argos.v1";
export function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { robot: null, library: [], chat: [] }; }
  catch { return { robot: null, library: [], chat: [] }; }
}
export function save(state) { localStorage.setItem(KEY, JSON.stringify(state)); }
