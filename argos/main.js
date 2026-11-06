import { createOrb } from "./orb.js";
import { think } from "./brain.js";
import { LAW, CLASSES, load, save } from "./core.js";

const $ = (s) => document.querySelector(s);
const orb = createOrb($("#orb"));
const state = load();
const LABEL = { idle: "STANDING BY", listening: "LISTENING", thinking: "THINKING", acting: "FORGING", speaking: "SPEAKING" };
function mood(s) { orb.setState(s); $("#orb-state").textContent = LABEL[s]; }

// --- clock ---------------------------------------------------------------
function tick() {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString("en-GB");
  $("#date").textContent = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}
tick(); setInterval(tick, 1000);

// --- panels --------------------------------------------------------------
$("#law-list").innerHTML = LAW.articles.map(([n, a]) => `<li><b>${n}</b><span>${a}</span></li>`).join("");

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function renderRobot() {
  const r = state.robot;
  $("#g-parts").textContent = state.library.length;
  if (!r) return;
  const stat = (k) => `<div class="stat"><span>${k}</span><i style="--v:${Math.min(100, r.stats[k] / 1.6)}%"></i><b>${r.stats[k]}</b></div>`;
  const clr = r.clearance === "cleared" ? '<span class="tag ok">Arena cleared</span>' : r.clearance === "refused" ? '<span class="tag bad">Refused</span>' : '<span class="tag">Clearance pending</span>';
  $("#robot-card").className = "";
  $("#robot-card").innerHTML = `
    <div class="robot-name">${esc(r.name)}</div>
    <div class="robot-id">${r.id} · ${CLASSES[r.cls].label.toUpperCase()} · ${r.sizeMm}MM · ${r.massG}G</div>
    ${["power", "guard", "agility", "sense", "stun"].map(stat).join("")}
    <p class="robot-note">${esc(r.temperament)}. It ${esc(r.temperamentNote)}.</p>
    <div class="tags"><span class="tag gold">Stats locked</span>${clr}<span class="tag">${r.private ? "Private" : "Public"}</span></div>`;
}
function renderLib() {
  $("#lib").innerHTML = state.library.length
    ? state.library.slice(0, 40).map((p) => `<li><span>${esc(p.name)}</span><small>${p.slot}${p.private ? " · 🔒" : ""}</small></li>`).join("")
    : '<li class="muted">Empty.</li>';
}

// --- log -----------------------------------------------------------------
const log = $("#log");
function addMsg(role, text, opts = {}) {
  const li = document.createElement("li");
  li.className = `msg ${role}`;
  if (opts.steps) {
    const st = document.createElement("div");
    st.className = "steps";
    li.append(st);
    li._steps = st;
  }
  const body = document.createElement("div");
  body.textContent = text;
  li.append(body);
  if (opts.img) { const im = new Image(); im.src = opts.img; im.alt = "Attached sketch"; li.append(im); }
  log.append(li);
  log.scrollTop = log.scrollHeight;
  return { li, body };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function typeOut(el, text) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = text; return; }
  el.textContent = "";
  for (let i = 0; i < text.length; i += 2) {
    el.textContent = text.slice(0, i + 2);
    if (i % 12 === 0) { orb.setLevel(0.35); log.scrollTop = log.scrollHeight; await wait(12); }
  }
}

// --- voice (butler) ------------------------------------------------------
let voiceOn = localStorage.getItem("argos.voice") !== "off";
let butler = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  const pref = [/Daniel/i, /Google UK English Male/i, /Arthur/i, /Oliver/i, /Ryan.*Online/i, /George/i, /en-GB.*Male/i];
  for (const p of pref) { const v = vs.find((x) => p.test(x.name)); if (v) return v; }
  return vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) {
  const set = () => { butler = pickVoice(); $("#g-voice").textContent = butler ? butler.name.split(" ")[0].toUpperCase() : "SYSTEM"; };
  set(); speechSynthesis.onvoiceschanged = set;
} else { $("#g-voice").textContent = "NONE"; }
const voiceBtn = $("#voice");
function syncVoiceBtn() { voiceBtn.classList.toggle("on", voiceOn); voiceBtn.setAttribute("aria-pressed", voiceOn); }
syncVoiceBtn();
voiceBtn.onclick = () => { voiceOn = !voiceOn; localStorage.setItem("argos.voice", voiceOn ? "on" : "off"); syncVoiceBtn(); if (!voiceOn) speechSynthesis?.cancel(); };

function speak(text) {
  if (!voiceOn || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((res) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[·•]/g, ",").replace(/\n/g, ". "));
    if (butler) u.voice = butler;
    u.lang = butler?.lang || "en-GB"; u.rate = 0.93; u.pitch = 0.82;
    u.onstart = () => mood("speaking");
    u.onboundary = () => orb.setLevel(0.9);
    u.onend = u.onerror = () => res();
    speechSynthesis.speak(u);
    setTimeout(res, 60000);
  });
}

// --- listening -----------------------------------------------------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = $("#mic");
if (!SR) mic.hidden = true;
else {
  const rec = new SR();
  rec.lang = "en-GB"; rec.interimResults = true;
  let live = false;
  rec.onresult = (e) => { $("#q").value = Array.from(e.results).map((r) => r[0].transcript).join(""); orb.setLevel(0.5); };
  rec.onend = () => { live = false; mic.classList.remove("live"); if (orb.state === "listening") mood("idle"); if ($("#q").value.trim()) $("#ask").requestSubmit(); };
  mic.onclick = () => { if (live) return rec.stop(); speechSynthesis?.cancel(); live = true; mic.classList.add("live"); mood("listening"); rec.start(); };
}

// --- attachments ---------------------------------------------------------
let attachment = null;
$("#file").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  attachment = { name: f.name, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : null };
  const chip = $("#chip"); chip.hidden = false; chip.textContent = "✕ " + f.name; chip.title = "Remove";
  $("#q").placeholder = "describe it: size, drive, how it parries…";
};
$("#chip").onclick = () => { attachment = null; $("#chip").hidden = true; $("#file").value = ""; };

// --- converse ------------------------------------------------------------
$("#q").addEventListener("focus", () => { if (orb.state === "idle") mood("listening"); });
$("#q").addEventListener("blur", () => { if (orb.state === "listening") mood("idle"); });

let busy = false;
$("#ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (busy || (!q && !attachment)) return;
  busy = true; $(".send").disabled = true;
  const att = attachment; attachment = null; $("#chip").hidden = true; $("#file").value = "";
  $("#q").value = ""; $("#q").placeholder = "speak, Pilot…";
  const text = q || "Build this sketch.";
  addMsg("user", text, { img: att?.url });
  state.chat.push({ role: "user", text });

  mood("thinking");
  const [res] = await Promise.all([think(text, state, att), wait(700)]);
  const { li, body } = addMsg("argos", "", { steps: true });
  if (res.steps?.length) {
    mood("acting");
    for (const s of res.steps) {
      const sp = document.createElement("span");
      sp.textContent = s;
      if (s.startsWith("✓")) sp.className = "ok";
      if (s.startsWith("✕")) sp.className = "bad";
      li._steps.append(sp); orb.pulse(); log.scrollTop = log.scrollHeight;
      await wait(260 + Math.random() * 220);
    }
  }
  mood("speaking");
  const spoken = speak(res.reply);
  await typeOut(body, res.reply);
  state.chat.push({ role: "assistant", text: res.reply });
  state.chat = state.chat.slice(-60);
  save(state);
  renderRobot(); renderLib();
  await spoken;
  mood("idle");
  busy = false; $(".send").disabled = false;
});

// --- boot ----------------------------------------------------------------
renderRobot(); renderLib();
$("#g-link").textContent = document.querySelector('meta[name="argos-endpoint"]').content.trim() ? "ENGINE" : "LOCAL";
document.querySelectorAll("[data-panel]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); $("#" + a.dataset.panel).scrollIntoView({ behavior: "smooth", block: "center" }); }));
if (state.chat.length) state.chat.slice(-8).forEach((m) => addMsg(m.role === "user" ? "user" : "argos", m.text));
else addMsg("argos", state.robot
  ? `Welcome back, Pilot. ${state.robot.name} has been waiting.`
  : "Good evening. I am Argos. Bring me a sketch, a schematic or simply a sentence, and I shall forge you a companion. Its stats will be set once and for all; its parts, you may change.");
