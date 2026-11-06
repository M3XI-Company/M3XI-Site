// Argos's brain. Two modes:
//  1. Remote: if <meta name="argos-endpoint"> is set, messages go to that URL
//     (supabase/functions/argos-chat) and a real language model answers.
//  2. Local: no server, no key, no cost. A small rule engine with the voice of
//     a butler and the appetite of an engineer. It also performs the forge
//     actions (build robot, file parts, run clearance) in both modes, because
//     those must follow the Law exactly and never depend on a model's mood.
import { LAW, CLASSES, forgeRobot, clearance, bannedTermsIn } from "./core.js";

const endpoint = document.querySelector('meta[name="argos-endpoint"]')?.content?.trim();

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const OPEN = ["Very good.", "Certainly.", "At once.", "Of course.", "A pleasure."];

export async function think(text, state, attachment) {
  const t = text.toLowerCase().trim();
  const steps = [];

  // Forge actions run locally whatever the mode.
  const wantsBuild = attachment || /\b(build|forge|make|design|create)\b.*\b(robot|bot|me|one|him|her|it)\b/.test(t) || /^(build|forge)\b/.test(t);
  if (wantsBuild) return forge(text, state, attachment, steps);
  if (/\b(clear|clearance|check|inspect|audit)\b/.test(t) && state.robot) return inspect(state, steps);
  if (/\b(part|upgrade|swap|replace)\b/.test(t) && state.robot) return part(text, state, steps);
  if (/\b(private|public|publish|hide)\b/.test(t) && state.robot) {
    state.robot.private = !/\b(public|publish)\b/.test(t);
    return { steps: ["› updating creator protection"], reply: state.robot.private
      ? `${pick(OPEN)} ${state.robot.name}'s schematics are sealed. Only you may see them; the arena sees only its clearance badge.`
      : `As you wish. ${state.robot.name}'s design is now visible in the public library. Your authorship stays on record.` };
  }

  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: state.chat.slice(-12).map(({ role, text }) => ({ role, content: text })).concat([{ role: "user", content: text }]) }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.reply) return { steps: ["› consulting the engine room"], reply: data.reply };
      }
    } catch { /* fall back to local */ }
  }
  return local(t, state);
}

function local(t, state) {
  if (/^(hi|hello|hey|good (morning|evening|afternoon)|yo)\b/.test(t))
    return { reply: `${pick(["Good evening.", "Welcome back.", "At your service."])} I am Argos. Bring me a sketch, a schematic or a few words, and I shall forge you a companion. ${state.robot ? `${state.robot.name} is in the bay, if you wish to see it.` : "You have no robot yet. Say \"build me…\" and describe it."}` };
  if (/\b(who|what) (are|is) (you|argos)\b/.test(t))
    return { reply: "I am Argos, M3XI's fabricator. You bring sketches, schematics or plans; I turn them into a printable CAD build, forge its stats once and for all, and file every new part in the library. The M3XI team prints it. Then it is yours: one pilot, one robot, a pal with its own temperament." };
  if (/\b(law|rule|rules|allowed|can i)\b/.test(t))
    return { reply: LAW.articles.map(([n, a]) => `${n}. ${a}`).join("\n"), steps: ["› reciting the Law"] };
  if (/\b(class|size|limit|weight|envelope)\b/.test(t))
    return { reply: "The envelope, which no one may change:\n" + Object.values(CLASSES).map((c) => `${c.label}: ≤ ${c.maxMm} mm, ≤ ${c.maxG} g, ≤ ${c.maxW} W, ≤ ${c.maxMs} m/s`).join("\n") + "\nAny shape you like inside it." };
  if (/\b(match|battle|fight|arena|game|win|capture|point)\b/.test(t))
    return { reply: "Matches are slam-down sumo. Push, pin, parry, dodge, stun; nothing lethal. Two formats: 1 v 1 knockout, untimed, last robot standing in the ring; and team capture-the-point, timed, where the side holding the point longest wins. The pilot's phone scans the arena, the barriers, every team member and the capture point first. A badly hurt robot is auto-piloted back to spawn. A destroyed robot is out; any human hurt and the match is void with disqualification." };
  if (/\b(pilot|controller|app|phone)\b/.test(t))
    return { reply: "The pilot controller lives at /argos/pilot. Install it to your home screen and it behaves as an app on Android and iOS: health, part condition, damage, your robot's mood, the arena scan and the controls." };
  if (/\b(personality|bond|pet|pal|feel|mood)\b/.test(t))
    return { reply: state.robot ? `${state.robot.name} is ${state.robot.temperament.toLowerCase()}: it ${state.robot.temperamentNote}. It also ${state.robot.quirk}. These traits were forged with it and grow with time spent together, not with wins.` : "Each robot is forged with a temperament and a quirk of its own, like a pet. No two alike. Build one and you shall meet it." };
  if (/\b(cost|free|price|cheap)\b/.test(t))
    return { reply: "The forge itself runs at no cost: I live in your browser and remember on your device. Printing is M3XI's affair. Should you wish a sharper mind, connect me to a model and I shall use it." };
  if (/\b(thank|thanks|cheers)\b/.test(t)) return { reply: pick(["Always a pleasure.", "Think nothing of it.", "That is what I am for."]) };
  if (/\b(library|parts)\b/.test(t))
    return { reply: state.library.length ? "In the library:\n" + state.library.map((p) => `• ${p.name} (${p.slot})`).join("\n") : "The library is empty for now. Every new part I generate is filed there." };
  return { reply: pick([
    "Noted. If that is a design, say \"build\" and describe it. Shape, size, how it moves, how it parries. I shall do the rest.",
    "I am an engineer at heart; give me something to build. A sketch, a sentence, a napkin drawing.",
    "Of course. Might I suggest: \"build me a small tracked wedge bot that parries\". Or ask me about the Law, the arena or the pilot app.",
  ]) };
}

function forge(text, state, attachment, steps) {
  const banned = bannedTermsIn(text);
  if (banned.length)
    return { steps: ["› reading design", "› checking Article I and III", "✕ refused"], reply: `I must decline, with respect. A ${banned.join(", ")} would make it a weapon, and Argos builds companions. Give it a wedge, a parry arm or a stun strobe instead and I shall begin at once.` };
  const design = (text + (attachment ? ` [sketch: ${attachment.name}]` : "")).trim();
  steps.push(attachment ? `› tracing sketch ${attachment.name}` : "› reading design brief", "› fitting class envelope", "› generating chassis CAD (PETG / TPU)", "› routing drive, parry arm, stun strobe", "› mounting cameras + sensors + e-stop", "› forging stats (locked)", "› embossing QR identity plate");

  if (state.robot) {
    // One pilot, one robot: further builds become parts.
    const p = { id: "P" + Date.now().toString(36), slot: guessSlot(text), name: partName(text), by: "you", private: true, createdAt: Date.now() };
    state.library.unshift(p);
    return { steps: steps.slice(0, 3).concat(["› filing to library"]), action: "part", reply: `You already have ${state.robot.name}, and the Law allows one. So I have made this as a part instead: “${p.name}” for the ${p.slot} slot, now in your library. Fit it as an upgrade; ${state.robot.name}'s stats stay as forged.` };
  }
  const name = (text.match(/\b(?:called|named)\s+([A-Z][\w-]{1,20})/i) || [])[1];
  const robot = forgeRobot(design, name);
  state.robot = robot;
  robot.parts.forEach((p) => state.library.unshift({ id: "P" + Math.random().toString(36).slice(2, 8), slot: p.slot, name: p.name, by: "argos", private: false, createdAt: Date.now() }));
  const s = robot.stats;
  return {
    steps, action: "robot",
    reply: `${pick(OPEN)} May I present ${robot.name}, ${robot.id}.\n` +
      `${CLASSES[robot.cls].label} class · ${robot.sizeMm} mm · ${robot.massG} g\n` +
      `Power ${s.power} · Guard ${s.guard} · Agility ${s.agility} · Sense ${s.sense} · Stun ${s.stun}  (locked)\n` +
      `Temperament: ${robot.temperament}. It ${robot.temperamentNote}, and it ${robot.quirk}.\n` +
      `Its design is private to you. Say "clearance" when you would like me to inspect it for the arena.`,
  };
}

function inspect(state, steps) {
  const { checks, cleared } = clearance(state.robot);
  state.robot.clearance = cleared ? "cleared" : "refused";
  steps.push(...checks.map(([n, ok, note]) => `${ok ? "✓" : "✕"} ${n}: ${note}`));
  return { steps, action: "clearance", reply: cleared
    ? `${state.robot.name} is cleared for the arena database. The design remains private; only the badge is public.`
    : `${state.robot.name} did not pass. I have marked what must change.` };
}

function part(text, state, steps) {
  const p = { id: "P" + Date.now().toString(36), slot: guessSlot(text), name: partName(text), by: "you", private: true, createdAt: Date.now() };
  if (bannedTermsIn(text).length) return { steps: ["✕ refused"], reply: "That part would be a weapon. I shall not make it." };
  state.library.unshift(p);
  return { steps: ["› modelling part", "› fitting to envelope", "› filing to library"], action: "part", reply: `Done. “${p.name}” is in the library. Fit it whenever you like; stats never change, only parts.` };
}

function guessSlot(t) {
  t = t.toLowerCase();
  if (/arm|parry|claw|grab/.test(t)) return "arms";
  if (/wheel|track|leg|drive|motor/.test(t)) return "drive";
  if (/wedge|plow|front|bumper|scoop/.test(t)) return "front";
  if (/shell|armou?r|chassis|body/.test(t)) return "chassis";
  if (/stun|strobe|light/.test(t)) return "stun";
  if (/battery|power/.test(t)) return "power";
  return "accessory";
}
function partName(t) {
  const clean = t.replace(/\b(build|forge|make|design|create|me|a|an|the|part|upgrade|new|please)\b/gi, " ").replace(/\s+/g, " ").trim();
  return (clean.slice(0, 40) || "Custom part").replace(/^./, (c) => c.toUpperCase());
}
