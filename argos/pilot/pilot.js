// Argos Pilot: the controller. A PWA so one codebase installs on Android and
// iOS at no cost. The robot link is SIMULATED here; the real link is a
// WebSocket to the robot's ESP32 (same JSON messages: {hp, parts, sensors}
// in, {drive, move} out). Everything else -- bond, health, arena scan, match
// rules -- is the real logic.
import { load, save, forgeRobot, CLASSES } from "../core.js";

const $ = (s) => document.querySelector(s);
const state = load();
const bondKey = "argos.bond.v1";
const bond = JSON.parse(localStorage.getItem(bondKey) || '{"bond":40,"energy":80,"cur":60}');
const saveBond = () => localStorage.setItem(bondKey, JSON.stringify(bond));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/argos/sw.js", { scope: "/argos/" }).catch(() => {});

// --- tabs ----------------------------------------------------------------
function go(tab) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.go === tab));
  if (tab !== "pair") stopQr();
  scrollTo(0, 0);
}
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));

// --- robot -------------------------------------------------------------
const r = () => state.robot;
function setLink(on) { const l = $("#link-state"); l.className = "link " + (on ? "on" : "off"); l.textContent = on ? "LINKED · SIM" : "NO LINK"; }

function renderAll() {
  const robot = r();
  $("#no-robot").hidden = !!robot;
  $("#bond").hidden = !robot;
  setLink(!!robot);
  if (!robot) return;
  $("#b-name").textContent = robot.name;
  $("#b-id").textContent = `${robot.id} · ${CLASSES[robot.cls].label.toUpperCase()} CLASS`;
  $("#b-tags").innerHTML = `<span class="tag gold">Stats locked</span><span class="tag ${robot.clearance === "cleared" ? "ok" : ""}">${robot.clearance === "cleared" ? "Arena cleared" : "Clearance pending"}</span>`;
  $("#b-traits").innerHTML = [
    ["Temperament", robot.temperament], ["Habit", robot.temperamentNote], ["Quirk", robot.quirk],
    ["Power", robot.stats.power], ["Guard", robot.stats.guard], ["Agility", robot.stats.agility], ["Sense", robot.stats.sense], ["Stun", robot.stats.stun],
  ].map(([k, v]) => `<li><b>${k}</b> · ${esc(v)}</li>`).join("");
  renderMood();
  renderHealth();
}

function renderMood() {
  const robot = r();
  [["#m-bond", bond.bond], ["#m-energy", bond.energy], ["#m-cur", bond.cur]].forEach(([s, v]) => $(s).style.setProperty("--v", v + "%"));
  const hp = robot.hp / 1000;
  const face = $("#face");
  face.className = "face " + (hp < 0.4 ? "hurt" : bond.energy < 25 ? "tired" : bond.bond > 70 ? "happy" : "");
  const n = robot.name;
  $("#b-mood").textContent =
    hp < 0.4 ? `${n} is hurt and keeps close to you. It needs repairs before it plays again.` :
    bond.energy < 25 ? `${n} is sleepy. It would like the charger.` :
    bond.bond > 80 ? `${n} is delighted to see you, and ${robot.quirk}.` :
    bond.cur > 70 ? `${n} has noticed something new in the room and wants to look.` :
    `${n} is content. Being ${robot.temperament.toLowerCase()}, it ${robot.temperamentNote}.`;
  // What it is aware of: in the real build this is the robot's sensor feed.
  $("#b-aware").innerHTML = [
    `You, ${bond.bond > 50 ? "recognised" : "learning your face"} · 0.6 m`,
    `${Math.round(bond.cur / 20) + 1} objects mapped in this room`,
    `Floor: ${["hardwood", "tile", "carpet"][robot.id.charCodeAt(4) % 3]} · grip ${70 + (robot.id.charCodeAt(5) % 25)}%`,
    `Battery ${bond.energy}% · ${bond.energy < 25 ? "heading to charger" : "fine"}`,
  ].map((s) => `<li>${s}</li>`).join("");
}
function nudge(k, d) { bond[k] = Math.max(0, Math.min(100, bond[k] + d)); }
$("#pat").onclick = () => { nudge("bond", 4); nudge("energy", 1); saveBond(); renderMood(); buzz(20); };
$("#talk").onclick = () => { nudge("bond", 2); nudge("cur", 6); saveBond(); renderMood(); };
$("#walk").onclick = () => { nudge("bond", 6); nudge("energy", -8); nudge("cur", 8); saveBond(); renderMood(); };
setInterval(() => { if (r()) { nudge("energy", -1); nudge("cur", Math.random() < 0.5 ? 1 : -1); saveBond(); renderMood(); } }, 30000);
function buzz(ms) { navigator.vibrate?.(ms); }

function renderHealth() {
  const robot = r();
  $("#hp-num").textContent = Math.round(robot.hp);
  $("#hp-bar").style.setProperty("--v", robot.hp / 10 + "%");
  $(".hpbar").classList.toggle("low", robot.hp < 250);
  const damaged = robot.parts.filter((p) => p.condition < 60);
  $("#hp-note").textContent = robot.hp <= 0 ? "Destroyed. Out of play until repaired." : damaged.length ? `${damaged.length} part(s) damaged: ${damaged.map((p) => p.slot).join(", ")}. Swap before the next match.` : "All systems nominal.";
  $("#parts").innerHTML = robot.parts.map((p, i) => {
    const c = p.condition < 30 ? "var(--red)" : p.condition < 60 ? "var(--gold)" : "var(--cyan)";
    return `<li><span>${esc(p.name)}<small>${p.slot} · ${Math.round(p.condition)}%</small></span><i class="cond" style="--v:${p.condition}%;--c:${c}"></i><button data-fix="${i}" ${p.condition >= 60 ? "disabled" : ""}>${p.condition >= 60 ? "OK" : "SWAP"}</button></li>`;
  }).join("");
  $("#sensors").innerHTML = robot.sensors.map((s) => `<li>${esc(s)} · online</li>`).join("");
}
$("#parts").addEventListener("click", (e) => {
  const i = e.target.dataset?.fix;
  if (i == null) return;
  const robot = r();
  robot.parts[i].condition = 100;
  robot.hp = Math.min(1000, robot.hp + 150);
  save(state); renderAll();
});

// --- pairing -------------------------------------------------------------
let qrStream = null;
function stopQr() { qrStream?.getTracks().forEach((t) => t.stop()); qrStream = null; $("#qrwrap").hidden = true; }
function pair(code) {
  code = code.trim().toUpperCase();
  if (!/^ARG-[A-Z0-9]{6}$/.test(code)) { $("#pairmsg").textContent = "That is not an Argos plate code."; return; }
  if (r() && r().id !== code) { $("#pairmsg").textContent = `You are bonded to ${r().name}. One pilot, one robot.`; return; }
  if (!r()) { state.robot = forgeRobot(code); state.robot.id = state.robot.qr = code; save(state); }
  $("#pairmsg").textContent = `Paired with ${r().name}.`;
  buzz([30, 40, 30]); renderAll(); go("bond");
}
$("#codego").onclick = () => pair($("#code").value);
$("#qrstart").onclick = async () => {
  if (!("BarcodeDetector" in window)) { $("#pairmsg").textContent = "This browser cannot read QR codes yet. Type the code printed under the plate."; return; }
  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const v = $("#qrcam"); v.srcObject = qrStream; await v.play(); $("#qrwrap").hidden = false;
    const det = new BarcodeDetector({ formats: ["qr_code"] });
    const loop = async () => {
      if (!qrStream) return;
      const codes = await det.detect(v).catch(() => []);
      if (codes[0]) { stopQr(); pair(codes[0].rawValue.replace(/^.*\//, "")); return; }
      requestAnimationFrame(loop);
    };
    loop();
  } catch { $("#pairmsg").textContent = "Camera unavailable. Type the code instead."; }
};

// --- arena setup ---------------------------------------------------------
const scans = {};
const HINTS = {
  arena: "Walk the edge of the arena slowly. Keep every barrier in frame.",
  robots: "Point at each robot's QR plate, one by one. Their HP is recorded.",
  people: "Pan across everyone standing near the arena, team mates included. The robots will keep their distance.",
  point: "Aim at the spot on the floor where the capture point goes.",
};
let camStream = null, camStep = null;
function syncChecklist() {
  const cp = $("#fmt").value === "cp";
  document.querySelectorAll("#check li").forEach((li) => {
    li.classList.toggle("off", li.dataset.step === "point" && !cp);
    li.classList.toggle("done", !!scans[li.dataset.step]);
  });
  const need = ["arena", "robots", "people"].concat(cp ? ["point"] : []);
  $("#start").disabled = !r() || !need.every((k) => scans[k]);
  $("#start").textContent = !r() ? "Pair a robot first" : r().hp <= 0 ? "Repair before playing" : "Start match";
  if (r() && r().hp <= 0) $("#start").disabled = true;
}
$("#fmt").onchange = syncChecklist;
$("#check").addEventListener("click", async (e) => {
  const li = e.target.closest("li"); if (!li) return;
  camStep = li.dataset.step;
  $("#camhint").textContent = HINTS[camStep];
  $("#camwrap").hidden = false;
  try {
    camStream = camStream || await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    $("#cam").srcObject = camStream; await $("#cam").play();
  } catch { $("#camhint").textContent = HINTS[camStep] + " (No camera here: confirm to simulate.)"; }
});
$("#camdone").onclick = () => {
  scans[camStep] = { at: Date.now() };
  $("#camwrap").hidden = true;
  camStream?.getTracks().forEach((t) => t.stop()); camStream = null;
  buzz(25); syncChecklist();
};

// --- match ---------------------------------------------------------------
const W = 400, H = 300, RING = { x: 200, y: 150, r: 130 };
let M = null;
const COOLDOWN = { slam: 2500, parry: 1500, dodge: 2000, stun: 8000 };

function feed(t, cls = "") { const li = document.createElement("li"); li.textContent = `${new Date().toLocaleTimeString("en-GB")}  ${t}`; li.className = cls; $("#feed").prepend(li); }

$("#start").onclick = () => {
  const robot = r();
  if (robot.hp <= 0) { alert(`${robot.name} is destroyed. Repair its parts first.`); return; }
  const fmt = $("#fmt").value;
  M = {
    fmt, t0: performance.now() + 3000, dur: fmt === "cp" ? 180 : Infinity, over: false,
    me: { x: 160, y: 150, vx: 0, vy: 0, spawn: { x: 160, y: 150 }, auto: false, parry: 0, dodge: 0, stun: 0 },
    op: { x: 240, y: 150, vx: 0, vy: 0, hp: 1000, spawn: { x: 240, y: 150 }, stun: performance.now() + 3000, parry: 0 },
    cp: { x: 200, y: 150, r: 34, mine: 0, theirs: 0 }, cd: {},
    record: { format: fmt, scans: { ...scans }, startHp: robot.hp, capturePoint: fmt === "cp" ? "centre" : null },
  };
  $("#setup").hidden = true; $("#match").hidden = false; $("#feed").innerHTML = "";
  feed(`Match recorded: ${fmt === "cp" ? "team capture the point, 3:00" : "1 v 1 knockout, untimed"}.`, "ok");
  sizeMap(); requestAnimationFrame(step);
};

const map = $("#map"), g = map.getContext("2d");
function sizeMap() { const d = Math.min(devicePixelRatio, 2); map.width = W * d; map.height = H * d; g.setTransform(d, 0, 0, d, 0, 0); }

// joystick
const stick = { x: 0, y: 0 };
(() => {
  const el = $("#stick"), knob = $("#knob");
  let id = null;
  const move = (e) => {
    const b = el.getBoundingClientRect();
    let x = (e.clientX - b.left - b.width / 2) / (b.width / 2), y = (e.clientY - b.top - b.height / 2) / (b.height / 2);
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    stick.x = x; stick.y = y; knob.style.transform = `translate(${x * 42}px,${y * 42}px)`;
  };
  el.addEventListener("pointerdown", (e) => { id = e.pointerId; el.setPointerCapture(id); move(e); });
  el.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
  const up = () => { id = null; stick.x = stick.y = 0; knob.style.transform = ""; };
  el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
})();

document.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", () => act(b.dataset.move, b)));
function act(mv, btn) {
  if (!M || M.over || M.me.auto) return;
  const now = performance.now();
  if (now < M.t0 || (M.cd[mv] || 0) > now || M.me.stun > now) return;
  M.cd[mv] = now + COOLDOWN[mv];
  btn.style.setProperty("--cd", COOLDOWN[mv] + "ms"); btn.classList.remove("cd"); void btn.offsetWidth; btn.classList.add("cd");
  const s = r().stats, me = M.me, op = M.op;
  const d = Math.hypot(op.x - me.x, op.y - me.y);
  buzz(15);
  if (mv === "parry") { me.parry = now + 600; feed("Parry raised."); }
  if (mv === "dodge") { me.dodge = now + 400; const a = Math.atan2(op.y - me.y, op.x - me.x) + Math.PI / 2; me.vx += Math.cos(a) * (2 + s.agility / 40); me.vy += Math.sin(a) * (2 + s.agility / 40); feed("Dodge."); }
  if (mv === "slam" && d < 44) {
    if (op.parry > now) { me.stun = now + 900; feed("Slam parried. You are off balance.", "warn"); return; }
    const a = Math.atan2(op.y - me.y, op.x - me.x), f = 3 + s.power / 25;
    op.vx += Math.cos(a) * f; op.vy += Math.sin(a) * f; op.hp -= 40 + s.power / 2; feed(`Slam lands. Opponent pushed.`, "ok");
  } else if (mv === "slam") feed("Slam missed: too far.");
  if (mv === "stun" && d < 90) { op.stun = now + 800 + s.stun * 6; feed(`Stun strobe: opponent frozen ${((800 + s.stun * 6) / 1000).toFixed(1)} s.`, "ok"); }
  else if (mv === "stun") feed("Stun out of range.");
}

function hurt(amount) {
  const robot = r();
  const g2 = robot.stats.guard;
  const dmg = amount * (1 - g2 / 400);
  robot.hp = Math.max(0, robot.hp - dmg);
  const part = robot.parts[Math.floor(Math.random() * robot.parts.length)];
  part.condition = Math.max(0, part.condition - dmg / 6);
  if (part.condition < 60 && !part._flag) { part._flag = 1; feed(`Damage: ${part.slot} at ${Math.round(part.condition)}%. Swap after the match.`, "warn"); buzz([60, 40, 60]); }
}

function end(text, cls) {
  M.over = true; feed(text, cls);
  r().parts.forEach((p) => delete p._flag);
  M.record.endHp = r().hp; M.record.result = text; M.record.at = Date.now();
  state.matches = (state.matches || []).concat([M.record]).slice(-50);
  save(state); renderAll();
  setTimeout(() => { $("#setup").hidden = false; $("#match").hidden = true; Object.keys(scans).forEach((k) => delete scans[k]); syncChecklist(); }, 4000);
}

$("#estop").onclick = () => { if (M && !M.over) end("E-STOP. All robots halted. Match void.", "bad"); };
$("#human").onclick = () => { if (M && !M.over && confirm("Report that a robot made contact with a person?")) end("Human contact reported. Responsible pilot disqualified. Match void.", "bad"); };

function step(now) {
  if (!M || M.over) return;
  const me = M.me, op = M.op, s = r().stats, sp = 0.18 + s.agility / 900;
  // pilot or autopilot
  if (me.auto) {
    const dx = me.spawn.x - me.x, dy = me.spawn.y - me.y, d = Math.hypot(dx, dy);
    if (d < 6) { me.auto = false; r().hp = Math.min(1000, r().hp + 120); feed("Back at spawn. Control returned.", "ok"); }
    else { me.vx += (dx / d) * 0.35; me.vy += (dy / d) * 0.35; }
  } else if (me.stun < now && now > M.t0) { me.vx += stick.x * sp; me.vy += stick.y * sp; }
  // opponent AI: chase, slam when close, sometimes parry
  if (op.stun < now) {
    const target = M.fmt === "cp" && Math.random() < 0.5 ? M.cp : me;
    const dx = target.x - op.x, dy = target.y - op.y, d = Math.hypot(dx, dy) || 1;
    op.vx += (dx / d) * 0.1; op.vy += (dy / d) * 0.1;
    const dm = Math.hypot(me.x - op.x, me.y - op.y);
    if (dm < 40 && Math.random() < 0.02) {
      if (me.parry > now) { op.stun = now + 900; feed("Parried! Opponent staggered.", "ok"); }
      else if (me.dodge > now) feed("Dodged.", "ok");
      else { const a = Math.atan2(me.y - op.y, me.x - op.x), f = 2.5 * (1 - r().stats.guard / 400); me.vx += Math.cos(a) * f; me.vy += Math.sin(a) * f; hurt(55); feed("Opponent slams you.", "warn"); }
    }
    if (Math.random() < 0.004) op.parry = now + 700;
  }
  for (const b of [me, op]) { b.vx *= 0.88; b.vy *= 0.88; b.x += b.vx; b.y += b.vy; }
  // bodies collide
  const dx = op.x - me.x, dy = op.y - me.y, d = Math.hypot(dx, dy);
  if (d < 30 && d > 0) { const p = (30 - d) / 2; me.x -= dx / d * p; me.y -= dy / d * p; op.x += dx / d * p; op.y += dy / d * p; }

  const t = Math.max(0, (now - M.t0) / 1000);
  if (now < M.t0) { $("#timer").textContent = String(Math.ceil((M.t0 - now) / 1000)); draw(now); return requestAnimationFrame(step); }
  // rules
  if (!me.auto && r().hp < 250 && r().hp > 0) { me.auto = true; feed("Heavy damage. Autopilot: returning to spawn.", "warn"); buzz([100, 50, 100]); }
  const out = (b) => Math.hypot(b.x - RING.x, b.y - RING.y) > RING.r;
  if (M.fmt === "ko") {
    if (out(op) || op.hp <= 0) return end(`Knockout! ${r().name} wins.`, "ok"), draw();
    if (out(me) && !me.auto) return end(`${r().name} was pushed out. Knocked out.`, "bad"), draw();
  } else {
    // out of bounds in CP: teleport to spawn
    for (const b of [me, op]) if (out(b)) { b.x = b.spawn.x; b.y = b.spawn.y; b.vx = b.vy = 0; }
    const inMe = Math.hypot(me.x - M.cp.x, me.y - M.cp.y) < M.cp.r, inOp = Math.hypot(op.x - M.cp.x, op.y - M.cp.y) < M.cp.r;
    if (inMe && !inOp) M.cp.mine += 1 / 60;
    if (inOp && !inMe) M.cp.theirs += 1 / 60;
    $("#cp").textContent = `${Math.round(M.cp.mine)}–${Math.round(M.cp.theirs)}`;
    if (t >= M.dur) return end(M.cp.mine >= M.cp.theirs ? `Time. Your team held the point longer: win.` : "Time. The other team held the point longer.", M.cp.mine >= M.cp.theirs ? "ok" : "bad"), draw();
  }
  if (r().hp <= 0) return end(`${r().name} is destroyed: out and disqualified from this match.`, "bad"), draw();
  $("#timer").textContent = M.dur === Infinity ? "∞" : `${Math.floor((M.dur - t) / 60)}:${String(Math.floor((M.dur - t) % 60)).padStart(2, "0")}`;
  $("#opp").textContent = Math.max(0, Math.round(op.hp));
  $("#hp-num").textContent = Math.round(r().hp);
  draw(now);
  requestAnimationFrame(step);
}

function draw(now = performance.now()) {
  g.clearRect(0, 0, W, H);
  g.strokeStyle = "rgba(25,227,227,.15)";
  for (let x = 0; x < W; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 20) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.strokeStyle = "#19e3e3"; g.lineWidth = 2; g.beginPath(); g.arc(RING.x, RING.y, RING.r, 0, Math.PI * 2); g.stroke();
  if (M.fmt === "cp") { g.fillStyle = "rgba(214,178,106,.15)"; g.strokeStyle = "#d6b26a"; g.beginPath(); g.arc(M.cp.x, M.cp.y, M.cp.r, 0, Math.PI * 2); g.fill(); g.stroke(); }
  for (const [b, col, label] of [[M.me, "#19e3e3", r().name], [M.op, "#ff4d5e", "OPP"]]) {
    g.fillStyle = "rgba(255,255,255,.08)"; g.fillRect(b.spawn.x - 8, b.spawn.y - 8, 16, 16);
    g.fillStyle = col; g.shadowColor = col; g.shadowBlur = b.stun > now ? 2 : 14;
    g.beginPath(); g.arc(b.x, b.y, 14, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
    if (b.parry > now) { g.strokeStyle = "#d6b26a"; g.beginPath(); g.arc(b.x, b.y, 20, 0, Math.PI * 2); g.stroke(); }
    if (b.stun > now) { g.fillStyle = "#fff"; g.font = "10px monospace"; g.fillText("STUN", b.x - 12, b.y - 20); }
    g.fillStyle = "#d9f7f7"; g.font = "10px monospace"; g.fillText(label, b.x - 12, b.y + 28);
  }
  if (M.me.auto) { g.fillStyle = "#d6b26a"; g.font = "12px monospace"; g.fillText("AUTOPILOT → SPAWN", 10, 18); }
}

renderAll(); syncChecklist();
