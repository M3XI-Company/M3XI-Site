# Argos: what it is, whether it is doable, and the no-cost path

Argos is M3XI's robot forge. A pilot brings a sketch, a schematic or a few
words; Argos turns it into a printable companion robot with locked stats and
its own personality; the M3XI team prints it; the pilot bonds with it and
plays non-lethal sumo matches in arenas scanned by their phone.

What is in this repo now:

| Path | What it is |
|---|---|
| `argos/` → `m3xi.com/argos` | The Argos chat: the HUD orb (idle / listening / thinking / forging / speaking), typed and spoken prompts, sketch upload, a butler voice, the robot bay, the Law, the parts library. Runs fully in the browser. |
| `argos/core.js` | The Law, the class envelope, the stat forge (deterministic, so stats cannot be re-rolled), the clearance check, on-device storage. |
| `argos/brain.js` | Argos's replies. Local rule engine by default; uses `supabase/functions/argos-chat` when `<meta name="argos-endpoint">` is set. Forge actions always run locally so they follow the Law exactly. |
| `argos/pilot/` → `m3xi.com/argos/pilot` | The pilot controller as an installable PWA (Android and iOS): Bond (mood, traits, awareness), Health (HP, part condition, damage, swap), Arena (scan arena, robots, people, capture point; 1 v 1 KO or timed team capture; autopilot to spawn under 25% HP; e-stop; human-contact DQ), Pair (QR plate scan). The robot link is simulated. |
| `supabase/functions/argos-chat/` | Optional model backend (needs `ANTHROPIC_API_KEY`). |

---

## 1. Is this doable?

Yes, in stages. Honest breakdown:

| Piece | Doable now? | Notes |
|---|---|---|
| Argos chat + orb + voice | **Yes, done** (prototype here). | Browser speech is free; a premium butler voice later costs money. |
| Sketch → *fully functional, print-ready* CAD, automatically | **Partly.** | No AI today reliably turns a napkin sketch into a working mechanical assembly. What works: a **parametric robot kit** (chassis, wheel pods, wedge, parry arm, sensor mast, QR plate) whose dimensions Argos fills in from the sketch + chat. Every robot is then a valid, printable variant of a design you know works. Fully freeform sketches need a human CAD pass by the M3XI team. |
| Locked stats, swappable parts, parts library | **Yes.** | Stats are derived from the forge seed and stored server-side once you have a database; the client never writes them. |
| Creator privacy + clearance before arena | **Yes.** | Private by default; arena DB stores the clearance badge, not the geometry. |
| Pilot app (Android/iOS) | **Yes.** | PWA now (free, installable). Wrap it with Capacitor later for store listings. |
| Robot personality / pet-like bond | **Yes.** | Temperament + quirk + mood meters driving idle behaviours (follow, greet, sulk, seek charger) on the robot's ESP32. Cheap to do, and it is the part people will love. |
| Robot "understands what's happening around it" | **Basic version yes.** | ToF sensors + camera + simple on-board vision (person detected, edge of arena, opponent). Rich understanding needs phone-side or cloud vision. |
| Phone scans arena, people, capture point | **Yes, phased.** | Phase 1: QR/AprilTag markers on arena corners and capture point (cheap, reliable). Phase 2: ARCore/ARKit plane + person detection. |
| Live HP / damage per part | **Yes, approximated.** | Bumper switches, IMU impact spikes and motor current give hit counts and severity → per-part condition. There is no true "health"; it is game logic driven by real sensors. |
| Autopilot back to spawn | **Medium.** | Needs the robot to know where it is: overhead phone camera + AprilTag on each robot is the cheapest reliable way. |
| VR-style view through the phone | **Yes.** | Stream the robot's camera to the phone; a cardboard-style split view is a small step after that. |

## 2. The most minimal, no-cost way to make Argos

1. **Host free:** this site on Vercel (already the case). Done.
2. **Brain free:** the local rule engine shipped here costs nothing. For smarter
   chat at no cost, the options are a free API tier (e.g. Google's Gemini free
   tier, Groq free tier) or a small model running in the browser via WebLLM.
   For quality, `argos-chat` with Claude Haiku costs very little per message,
   but it is not zero.
3. **Voice free:** browser `speechSynthesis` (already used; it picks a British
   male voice such as "Daniel" or "Google UK English Male" when present) and
   `SpeechRecognition` for talking to it.
4. **Accounts, library, privacy free:** Supabase free tier (Auth + Postgres
   with row-level security: `designs.owner_id = auth.uid()` unless
   `public = true`). This repo already uses Supabase.
5. **Sketch upload free:** Supabase Storage free tier, private bucket.

## 3. The most minimal, no-cost way to make the CAD

- **Use code-CAD, not hand modelling.** [OpenSCAD](https://openscad.org) or
  [CadQuery / build123d](https://build123d.readthedocs.io) (Python), both free.
  Write one parametric robot (chassis length/width/height, wheelbase, wedge
  angle, arm length, mast height, QR plate text). Argos only fills parameters.
- **Generate STL/STEP server-side for free:** OpenSCAD runs in the browser
  as WebAssembly (openscad-wasm), so the user's own device renders the model.
  Zero server cost.
- **Electronics:** ESP32-S3 camera boards (~£10), N20 gear motors, 1 servo for
  the parry arm, 4 VL53L0X ToF sensors, bumper microswitches, 2S LiPo with a
  fuse and a physical e-stop. Parts cost money; the design work does not.
- **Firmware:** Arduino/PlatformIO (free). The robot opens a WebSocket; the
  pilot PWA connects to it on the local network. No cloud needed in a match.
- **QR plate:** the QR is a raised/inset 2-colour print; OpenSCAD has free
  QR libraries, so the plate is generated from the robot ID automatically.

## 4. Dos and don'ts (game rules as built)

**Do**
- Slam-down / sumo: push, pin, ring-out.
- Parry (timed guard that staggers the attacker), dodge (side-step with
  i-frames), stun (LED strobe + IR "tag" that freezes the target's controls in
  software for ~1–2 s). Stun is a *game* effect, never electrical.
- Any shape and size inside the class envelope.
- Cameras, ToF sensors, bumpers, hard e-stop, QR plate on every robot.
- Scan arena, barriers, every person present, every robot (HP recorded) and
  the capture point before a match.
- Autopilot to spawn when HP drops under 25%.

**Don't**
- Blades, saws, spinners, flippers that launch, flames, lasers aimed at eyes,
  projectiles, electrical shock, spikes, anything that cuts or burns. Argos
  refuses these words on sight and clearance fails on them.
- Change stats. Ever. Upgrades are parts.
- Own two robots. One pilot, one robot.
- Drive a robot near a person: any human contact = disqualification and the
  match is void.

**Win conditions**
- 1 v 1 knockout: untimed; push the other robot out of the ring or reduce it to 0 HP.
- Team capture the point: timed (3:00 by default); the team that holds the point longest wins. Out-of-bounds robots respawn.
- Robot destroyed (0 HP): out and disqualified from that match.
- Human casualty: disqualification.

## 5. Safety notes worth keeping

- Keep the speed caps in `CLASSES` (`argos/core.js`); at ≤ 2 m/s and ≤ 3 kg a
  robot can bump an ankle but not injure. Raise them only after testing.
- The e-stop must be **physical on the robot** and **in the app**; the app
  e-stop alone is not enough.
- Kids and pets: the "Gentle" temperament's slow-near-people behaviour should
  be a rule for every robot, not a personality trait. The phone's person scan
  should create no-go zones the firmware enforces.

## 6. Next steps

1. Supabase tables: `pilots`, `robots` (one per pilot, unique), `parts`,
   `designs` (private by default), `matches` (format, capture point, arena
   bounds, people count, HP per robot), RLS on all.
2. One parametric OpenSCAD robot + openscad-wasm preview in `/argos`.
3. ESP32 firmware with the WebSocket protocol the pilot app expects:
   in `{hp, parts, sensors}`, out `{drive:[x,y], move:"slam|parry|dodge|stun"}`.
4. Capacitor wrapper for Play Store / App Store once the PWA is proven.
