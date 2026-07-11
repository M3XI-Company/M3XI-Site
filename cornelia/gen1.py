# -*- coding: utf-8 -*-
import os

OUT = "/sessions/beautiful-modest-euler/mnt/M3XI/cornelia/site_v2"

ICON = "https://play-lh.googleusercontent.com/kFzSrwfvG3uZNXggcoIYnkqwpqziKXGJtNdGAaNYyl_OZw1pDnaSjDJMdSUWNHW9xrtUPaSmXgkkoGE73Fk"
SHOTS = [
 "https://play-lh.googleusercontent.com/GWT6QCMj_TH5hpVuC8A-QTkBk1XDYlS2I_HUi0-x7QPnheQzWjZuKmpNUlxGDv1OyCpZzs_YClHB2zxX1VDu",
 "https://play-lh.googleusercontent.com/xjj647DbAl-CrwQHUqd7V9pIK_BliRsxTn0JS14ZrWAoypaALLj5wYu855nvuWEJVhweMjpe9TqTBex_yKcuXg",
 "https://play-lh.googleusercontent.com/ZcenaHdvtFvqsXAoYFwnz4J5gfif-9oCr2BuFoxKYQHRQAi_1W8cBk1DA8x7RiMz3wSTwVW3NUjqR0NjAXKn",
 "https://play-lh.googleusercontent.com/IZsuTKqxL0LpmFJnwHpTb7yTGVIxasYMOdg2XwzAhE9KX4_jhmpWo_4vS6W-dLDQyBqg8F9YDJ9TxGEpDn1z7w",
 "https://play-lh.googleusercontent.com/HZtFh6pfhY9_c8Ksmud-rclJ3mNPYaZbW_1skl88Pd-8vqCQ85ed4gQF2IkCaoXakMmzfXlUwMGqiJPmFdzNSg",
 "https://play-lh.googleusercontent.com/LTBasmz-HiZEllSWaCk8mmUROJyUPMV5xdtr--I1M-RwCnw7cd_wSOjVyWk9P777gdu4Be2xfYrWSEr_pmx1",
]
ICON_S = ICON + "=s128"
ICON_FAV = ICON + "=s64"
SHOTW = [s + "=w640" for s in SHOTS]

CSS = """
:root{
  --paper:#F0E8D8; --paper2:#F6F0E3; --panel:#FBF6EC; --white:#fff;
  --ink:#19150F; --ink2:#605747; --blue:#2B4257; --blue2:#3E6079;
  --gold:#B6892F; --gold2:#CBA css; --line:rgba(25,21,15,.14); --ok:#2f6b46; --err:#9b3030;
  --maxw:1140px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;color:var(--ink);font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  font-weight:400;line-height:1.62;-webkit-font-smoothing:antialiased;
  background-color:#EFE7D6;
  background-image:
    linear-gradient(rgba(43,66,87,.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(43,66,87,.045) 1px, transparent 1px),
    radial-gradient(1200px 700px at 80% -8%, rgba(255,253,247,.9), transparent 60%);
  background-size:30px 30px, 30px 30px, 100% 100%;
}
a{color:inherit;text-decoration:none}
img{max-width:100%}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 24px}
.eyebrow{font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:var(--blue);font-weight:600;margin:0 0 14px;display:flex;align-items:center;gap:10px}
.eyebrow::before{content:"";width:26px;height:1px;background:var(--gold)}
.eyebrow.c{justify-content:center}.eyebrow.c::after{content:"";width:26px;height:1px;background:var(--gold)}
h1,h2,h3,h4{font-family:'Playfair Display',Georgia,serif;letter-spacing:-.012em;color:var(--ink);margin:0}
h1{font-size:clamp(40px,6.2vw,68px);line-height:1.05;font-weight:600}
h1 em,h2 em{font-style:italic;color:var(--gold);font-weight:500}
h2{font-size:clamp(28px,4vw,42px);line-height:1.12;font-weight:600}
p{margin:0 0 16px}
.lede{font-size:clamp(16px,2vw,19px);color:#3c382f;max-width:62ch}
.jp{font-family:'Noto Serif JP',serif;color:var(--ink2)}
.muted{color:var(--ink2)}
.btn{display:inline-flex;align-items:center;gap:9px;font-weight:600;font-size:15px;padding:13px 24px;border-radius:999px;cursor:pointer;border:1px solid transparent;transition:transform .08s, background .2s, color .2s}
.btn-primary{background:linear-gradient(180deg,#2c2a22,#19150F);color:#F4EEDF;border-color:#0c0b08}
.btn-primary:hover{transform:translateY(-1px)}
.btn-ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--blue)}
.btn-gold{background:linear-gradient(180deg,#E3C271,#B6892F);color:#1c1606;border:none}
.btn-gold:hover{transform:translateY(-1px)}

/* header */
header.site{position:sticky;top:0;z-index:40;backdrop-filter:saturate(180%) blur(9px);
  background:rgba(241,234,221,.82);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px;gap:14px}
.brand{display:flex;align-items:center;gap:10px;font-family:'Playfair Display',serif;font-weight:600;font-size:19px}
.brand .mk{width:30px;height:30px;border-radius:8px;display:block}
.brand .jp{font-size:13px;margin-left:1px}
.menu{display:flex;align-items:center;gap:24px;font-size:14px;color:var(--ink2)}
.menu a:hover{color:var(--ink)}
.menu a.active{color:var(--ink)}
.menu .cta{padding:8px 15px;border:1px solid var(--ink);border-radius:999px;color:var(--ink);font-weight:600}
.menu .cta:hover{background:var(--ink);color:var(--paper)}
@media(max-width:780px){.menu a.lnk{display:none}}

/* sections */
section{padding:64px 0;position:relative}
.center{text-align:center}
.dim{display:flex;align-items:center;gap:14px;color:var(--blue);opacity:.6;font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin:0 auto;max-width:var(--maxw);padding:0 24px}
.dim::before,.dim::after{content:"";height:1px;background:repeating-linear-gradient(90deg,var(--blue),var(--blue) 4px,transparent 4px,transparent 9px);flex:1;opacity:.5}

/* hero */
.hero{padding:64px 0 40px}
.hero-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:40px;align-items:center}
.hero-cta{display:flex;gap:13px;flex-wrap:wrap;margin-top:26px}
.hero-art{width:100%;height:auto;filter:drop-shadow(0 30px 50px rgba(43,66,87,.14))}
@media(max-width:880px){.hero-grid{grid-template-columns:1fr;gap:18px}.hero-art{max-width:440px;margin:0 auto;order:-1}}

/* product card */
.product{display:grid;grid-template-columns:280px 1fr;gap:34px;align-items:center;background:var(--panel);
  border:1px solid var(--line);border-radius:24px;padding:30px;box-shadow:0 30px 60px -46px rgba(43,66,87,.5)}
.product .device{margin:0 auto}
.prod-head{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.prod-head img{width:58px;height:58px;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.16)}
.prod-head .nm{font-family:'Playfair Display',serif;font-size:26px;font-weight:600}
.prod-head .tag{font-size:12px;color:var(--blue);letter-spacing:.16em;text-transform:uppercase;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 20px}
.chip{font-size:12.5px;color:var(--ink2);background:#efe7d4;border:1px solid var(--line);border-radius:999px;padding:5px 12px}
@media(max-width:760px){.product{grid-template-columns:1fr;text-align:center}.prod-head{justify-content:center}.chips{justify-content:center}}

/* device frame */
.device{position:relative;width:230px;padding:9px;background:linear-gradient(150deg,#26211a,#15120d);border-radius:34px;
  box-shadow:0 26px 50px -22px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.12)}
.device::before{content:"";position:absolute;top:14px;left:50%;transform:translateX(-50%);width:54px;height:5px;border-radius:3px;background:rgba(255,255,255,.25);z-index:2}
.device img{display:block;width:100%;border-radius:26px;background:#0c0c0c;aspect-ratio:9/16;object-fit:cover}

/* value cards */
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:34px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px 24px}
.card h3{font-size:20px;margin-bottom:8px}
.card p{color:var(--ink2);font-size:14.5px;margin:0}
.card .ic{width:42px;height:42px;border-radius:11px;background:#e9e0cd;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;margin-bottom:16px}
.card .ic svg{width:22px;height:22px;stroke:var(--blue);fill:none;stroke-width:1.6}
@media(max-width:820px){.grid3{grid-template-columns:1fr}}

/* steps (how we build) */
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin-top:34px;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:var(--panel)}
.step{padding:28px 24px;border-right:1px dashed var(--line);position:relative}
.step:last-child{border-right:none}
.step .no{font-family:'Playfair Display',serif;color:var(--gold);font-size:14px;letter-spacing:.1em;margin-bottom:12px}
.step h3{font-size:19px;margin-bottom:6px}
.step p{color:var(--ink2);font-size:14px;margin:0}
.step svg{width:30px;height:30px;stroke:var(--blue);fill:none;stroke-width:1.5;margin-bottom:14px}
@media(max-width:820px){.steps{grid-template-columns:1fr}.step{border-right:none;border-bottom:1px dashed var(--line)}.step:last-child{border-bottom:none}}

/* screens row */
.screens{display:flex;gap:16px;overflow-x:auto;padding:6px 2px 14px;scroll-snap-type:x mandatory}
.screens .device{flex:0 0 auto;scroll-snap-align:center}
.screens .device img{width:200px}

/* features / reviews */
.feat{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:34px}
.feat .card h3{font-size:19px}
@media(max-width:820px){.feat{grid-template-columns:1fr}}
.reviews{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:30px}
.review{background:var(--white);border:1px solid var(--line);border-radius:18px;padding:22px}
.stars{color:var(--gold);letter-spacing:3px;font-size:13px;margin:0 0 10px}
.review p{font-size:14.5px;margin:0 0 14px}
.who{display:flex;align-items:center;gap:10px}
.who .av{width:32px;height:32px;border-radius:50%;background:#e9e0cd;color:#8a6d22;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}
.who b{font-size:13.5px}.who small{display:block;color:var(--ink2);font-size:12px}
@media(max-width:820px){.reviews{grid-template-columns:1fr}}

/* waitlist (dark, gold) */
.waitlist{background:linear-gradient(165deg,#23344a,#141d28);color:#EFE9DC;border-radius:26px;padding:54px 28px;text-align:center;position:relative;overflow:hidden}
.waitlist h2{color:#fff}.waitlist h2 em{color:#E3C271}
.waitlist .lede{color:#c4cdd6;margin-left:auto;margin-right:auto}
.wl-form{max-width:440px;margin:24px auto 0;text-align:left}
.wl-row{display:flex;gap:10px;flex-wrap:wrap}.wl-row .f{flex:1;min-width:150px}
.waitlist label{font-size:12px;letter-spacing:.04em;color:#a9b4bf;display:block;margin:0 0 6px}
.waitlist input{width:100%;padding:13px 15px;font:inherit;color:#fff;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.2);border-radius:11px;outline:none;transition:.15s}
.waitlist input::placeholder{color:#8a96a2}
.waitlist input:focus{border-color:#E3C271;box-shadow:0 0 0 3px rgba(227,194,113,.22)}
.wl-hp{position:absolute;left:-9999px}
.wl-form button{width:100%;margin-top:12px;padding:14px;font:inherit;font-weight:700;color:#1c1606;background:linear-gradient(180deg,#E9CB7E,#B6892F);border:none;border-radius:11px;cursor:pointer;transition:.1s}
.wl-form button:hover{transform:translateY(-1px)}.wl-form button:disabled{opacity:.6;transform:none}
.wl-msg{font-size:13.5px;margin:12px 2px 0;text-align:center;min-height:18px}
.wl-msg.ok{color:#9fe0b8}.wl-msg.err{color:#f3b4b4}
.wl-fine{font-size:12px;color:#8a96a2;margin-top:16px}
.wl-success{display:none}
.wl-success .tick{width:52px;height:52px;border-radius:50%;background:rgba(159,224,184,.16);display:flex;align-items:center;justify-content:center;margin:0 auto 12px}
.wl-success h3{color:#fff;font-size:24px;margin:0 0 6px}.wl-success p{color:#c4cdd6;margin:0}

/* team */
.people{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:30px}
.person{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px}
.person .av{width:54px;height:54px;border-radius:14px;background:#e9e0cd;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--blue);font-family:'Playfair Display',serif;font-size:20px;margin-bottom:14px}
.person .role{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);font-weight:600}
.person h3{font-size:22px;margin:2px 0 8px}.person p{color:var(--ink2);font-size:14.5px;margin:0}
.roles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:26px}
.role-card{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:18px}
.role-card .k{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:600;margin-bottom:6px}
.role-card h4{font-size:16px;margin:0 0 6px}.role-card p{font-size:13px;color:var(--ink2);margin:0}
@media(max-width:820px){.people{grid-template-columns:1fr}.roles{grid-template-columns:1fr}}

/* contact */
.contact-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:26px;margin-top:30px;align-items:start}
.contact-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px}
.contact-card a.email{font-family:'Playfair Display',serif;font-size:22px;color:var(--ink)}
.socials{display:flex;gap:10px;margin-top:18px}
.socials a{width:38px;height:38px;border-radius:10px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;background:var(--white)}
.socials svg{width:18px;height:18px;fill:var(--ink)}
form.cf label{font-size:12px;color:var(--ink2);display:block;margin:0 0 6px}
form.cf input,form.cf select,form.cf textarea{width:100%;padding:12px 14px;font:inherit;color:var(--ink);background:var(--white);border:1px solid var(--line);border-radius:11px;outline:none;margin-bottom:13px}
form.cf input:focus,form.cf select:focus,form.cf textarea:focus{border-color:var(--blue)}
@media(max-width:820px){.contact-grid{grid-template-columns:1fr}}

/* footer */
footer.site{border-top:1px solid var(--line);padding:34px 0;color:var(--ink2);font-size:13px;background:rgba(246,240,227,.6)}
.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center}
.foot a:hover{color:var(--ink)}
.foot .lnks{display:flex;gap:16px;flex-wrap:wrap}
"""

# fix accidental token in CSS
CSS = CSS.replace("--gold2:#CBA css;", "--gold2:#CBA14A;")

# ---------- SVG ART ----------
HERO_ART = """
<svg class="hero-art" viewBox="0 0 470 500" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Blueprint sketch: a phone being lifted into place">
  <defs>
    <linearGradient id="scr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FBF7EC"/><stop offset="1" stop-color="#EDE4D2"/></linearGradient>
  </defs>
  <!-- blueprint guides -->
  <g stroke="#2B4257" stroke-width="1" opacity=".35">
    <line x1="36" y1="24" x2="36" y2="476" stroke-dasharray="2 7"/>
    <line x1="434" y1="24" x2="434" y2="476" stroke-dasharray="2 7"/>
    <line x1="36" y1="250" x2="434" y2="250" stroke-dasharray="2 7"/>
    <path d="M36 64 h10 M36 124 h10 M36 184 h10 M36 314 h10 M36 374 h10 M36 434 h10" />
    <path d="M424 64 h10 M424 124 h10 M424 184 h10 M424 314 h10 M424 374 h10 M424 434 h10"/>
  </g>
  <!-- scaffolding base -->
  <g stroke="#2B4257" stroke-width="2" fill="none" opacity=".28" stroke-linecap="round">
    <path d="M70 470 h330 M96 470 v-66 M186 470 v-66 M284 470 v-66 M374 470 v-66 M96 438 h288 M70 404 h330"/>
    <path d="M96 404 l90 34 M186 404 l-90 34 M284 404 l90 34 M374 404 l-90 34"/>
  </g>
  <!-- crane hook + cable -->
  <g stroke="#2B4257" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <line x1="250" y1="14" x2="250" y2="92"/>
    <path d="M250 92 v16 M236 116 a14 14 0 1 0 28 0 v-8"/>
    <line x1="250" y1="120" x2="176" y2="176"/>
    <line x1="250" y1="120" x2="322" y2="176"/>
  </g>
  <!-- phone being lifted -->
  <g transform="rotate(-7 250 286)">
    <rect x="176" y="150" width="148" height="272" rx="26" fill="url(#scr)" stroke="#2B4257" stroke-width="3"/>
    <rect x="188" y="166" width="124" height="240" rx="16" fill="#fff" stroke="#2B4257" stroke-width="1.4" opacity=".9"/>
    <rect x="230" y="158" width="40" height="7" rx="3.5" fill="#2B4257"/>
    <!-- cornell layout hint -->
    <line x1="224" y1="182" x2="224" y2="356" stroke="#2B4257" stroke-width="1.2" opacity=".55"/>
    <g stroke="#2B4257" stroke-width="2" opacity=".5" stroke-linecap="round">
      <line x1="234" y1="196" x2="300" y2="196"/><line x1="234" y1="212" x2="296" y2="212"/>
      <line x1="234" y1="228" x2="302" y2="228"/><line x1="234" y1="244" x2="288" y2="244"/>
      <line x1="200" y1="196" x2="216" y2="196"/><line x1="200" y1="222" x2="216" y2="222"/>
    </g>
    <!-- waveform (lecture audio) -->
    <g stroke="#B6892F" stroke-width="2.4" stroke-linecap="round">
      <line x1="202" y1="330" x2="202" y2="342"/><line x1="210" y1="322" x2="210" y2="350"/>
      <line x1="218" y1="334" x2="218" y2="338"/><line x1="226" y1="318" x2="226" y2="354"/>
      <line x1="234" y1="328" x2="234" y2="344"/><line x1="242" y1="324" x2="242" y2="348"/>
      <line x1="250" y1="332" x2="250" y2="340"/><line x1="258" y1="320" x2="258" y2="352"/>
      <line x1="266" y1="330" x2="266" y2="342"/><line x1="274" y1="326" x2="274" y2="346"/>
      <line x1="282" y1="334" x2="282" y2="338"/><line x1="290" y1="324" x2="290" y2="348"/>
    </g>
    <rect x="222" y="372" width="56" height="10" rx="5" fill="#B6892F" opacity=".85"/>
  </g>
  <!-- dimension annotation -->
  <g stroke="#B6892F" stroke-width="1.6" opacity=".9">
    <line x1="350" y1="150" x2="386" y2="150"/><line x1="350" y1="422" x2="386" y2="422"/>
    <line x1="368" y1="150" x2="368" y2="422" stroke-dasharray="3 5"/>
  </g>
  <text x="376" y="290" font-family="Inter,sans-serif" font-size="12" fill="#B6892F" transform="rotate(90 376 290)">BUILT TO WORK</text>
</svg>
"""

def feat_icon(p):
    return '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">%s</svg>' % p
IC_MIC = feat_icon('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>')
IC_DOC = feat_icon('<path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 13h8M8 17h6"/>')
IC_CAM = feat_icon('<path d="M3 7h4l2-2h6l2 2h4v12H3z"/><circle cx="12" cy="13" r="3.5"/>')
IC_RULER = feat_icon('<path d="M3 16 16 3l5 5L8 21z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>')
IC_BUILD = feat_icon('<path d="M4 21h16M6 21V9l6-4 6 4v12"/><path d="M10 21v-5h4v5"/>')
IC_SHIP = feat_icon('<path d="M5 16l-2 5h18l-2-5M12 3v13M12 3l5 5M12 3l-5 5"/>')
IC_SPARK = feat_icon('<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>')

# ---------- SHELL ----------
SHELL = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="description" content="{{DESC}}" />
<title>{{TITLE}}</title>
<link rel="icon" type="image/png" href="{{FAV}}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,400;1,500&family=Inter:wght@300;400;500;600;700&family=Noto+Serif+JP:wght@400;500&display=swap" rel="stylesheet">
<style>{{CSS}}{{XCSS}}</style>
</head>
<body>
<header class="site"><div class="wrap nav">
  <a class="brand" href="/"><img class="mk" src="/M.png" alt="M3XI"/> M3XI <span class="jp">三X一</span></a>
  <nav class="menu">
    <a class="lnk {{A_HOME}}" href="/">Home</a>
    <a class="lnk {{A_CORN}}" href="/notetaker/">Cornelia</a>
    <a class="lnk {{A_VIS}}" href="/#vision">Vision</a>
    <a class="lnk {{A_TEAM}}" href="/team/">Team</a>
    <a class="cta" href="/notetaker/#waitlist">Join waitlist</a>
  </nav>
</div></header>
{{BODY}}
<footer class="site"><div class="wrap foot">
  <div>M3XI <span class="jp">三X一</span> · building software that works</div>
  <nav class="lnks">
    <a href="/">Home</a><a href="/notetaker/">Cornelia</a><a href="/team/">Team</a>
    <a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/contact/">Contact</a>
  </nav>
  <div>© 2026 · England &amp; Wales</div>
</div></footer>
</body></html>"""

def page(path, title, desc, body, active="", xcss="", fav="/M.png"):
    html = SHELL
    repl = {
      "{{TITLE}}":title, "{{DESC}}":desc, "{{CSS}}":CSS, "{{XCSS}}":xcss, "{{BODY}}":body, "{{FAV}}":fav,
      "{{A_HOME}}":"active" if active=="home" else "",
      "{{A_CORN}}":"active" if active=="corn" else "",
      "{{A_VIS}}":"active" if active=="vision" else "",
      "{{A_TEAM}}":"active" if active=="team" else "",
    }
    for k,v in repl.items(): html = html.replace(k,v)
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full,"w",encoding="utf-8").write(html)
    print("wrote", path, len(html))

# ---------- WAITLIST SCRIPT (shared, tested) ----------
WL_SCRIPT = """
<script>
 const SUPABASE_URL="https://nfdegwfgrlikmmzakxqw.supabase.co";
 const SUPABASE_KEY="sb_publishable_7ChibjJuhY73-E_PGHz1DA_Pq_SnsNT";
 const EMAIL_RE=/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
 const form=document.getElementById('wl-form'),emailEl=document.getElementById('wl-email'),nameEl=document.getElementById('wl-name'),
 hpEl=form.querySelector('input[name=company]'),btn=document.getElementById('wl-submit'),msg=document.getElementById('wl-msg'),
 okBox=document.getElementById('wl-success'),okMsg=document.getElementById('wl-success-msg');
 function setMsg(t,k){msg.textContent=t||'';msg.className='wl-msg'+(k?' '+k:'');}
 form.addEventListener('submit',async e=>{e.preventDefault();setMsg('');
  const email=(emailEl.value||'').trim().toLowerCase(),name=(nameEl.value||'').trim();
  if(hpEl.value)return; if(!EMAIL_RE.test(email)){setMsg('Please enter a valid email address.','err');emailEl.focus();return;}
  btn.disabled=true;const lb=btn.textContent;btn.textContent='Joining…';
  const p=new URLSearchParams(location.search);
  try{const res=await fetch(SUPABASE_URL+'/rest/v1/waitlist',{method:'POST',headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=minimal'},
   body:JSON.stringify({email,name:name||null,product:'cornelia',source:'website',metadata:{ref:document.referrer||null,utm_source:p.get('utm_source'),ua:navigator.userAgent}})});
   if(res.ok){form.style.display='none';okBox.style.display='block';return;}
   let b={};try{b=await res.json();}catch(_){}
   if(res.status===409||b.code==='23505'){form.style.display='none';okBox.style.display='block';okMsg.textContent="You're already on the list — we'll be in touch.";return;}
   setMsg(b.message||'Something went wrong. Please try again.','err');
  }catch(err){setMsg('Network error. Please try again.','err');}finally{btn.disabled=false;btn.textContent=lb;}
 });
</script>
"""

WAITLIST_BLOCK = """
<section id="waitlist"><div class="wrap"><div class="waitlist">
  <p class="eyebrow c" style="color:#E3C271">Early access</p>
  <h2>Be first to <em>Cornelia.</em></h2>
  <p class="lede">We're opening Cornelia to a first group of students soon. Join the waitlist and we'll email you the moment it's ready — iOS &amp; Android.</p>
  <form class="wl-form" id="wl-form" novalidate>
    <div class="wl-row">
      <div class="f"><label for="wl-name">Name (optional)</label><input id="wl-name" name="name" type="text" autocomplete="name" placeholder="Your name" maxlength="120"></div>
      <div class="f"><label for="wl-email">Email address</label><input id="wl-email" name="email" type="email" autocomplete="email" placeholder="you@university.edu" required></div>
    </div>
    <input class="wl-hp" type="text" name="company" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button id="wl-submit" type="submit">Join the waitlist</button>
    <p class="wl-msg" id="wl-msg" aria-live="polite"></p>
  </form>
  <div class="wl-success" id="wl-success"><div class="tick"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#9fe0b8" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
    <h3>You're on the list.</h3><p id="wl-success-msg">We'll email you the moment Cornelia opens.</p></div>
  <p class="wl-fine">No spam. We only email you about Cornelia's launch.</p>
</div></div></section>
"""

print("shared loaded")

# ===== HOME =====
HOME = """
<section class="hero"><div class="wrap hero-grid">
  <div>
    <p class="eyebrow">M3XI &middot; 三X一</p>
    <h1>We build software that <em>works.</em></h1>
    <p class="lede">M3XI is a small studio making tools that lower barriers and quietly get things done &mdash; from lecture halls to everyday life. Less ornament, more intent.</p>
    <div class="hero-cta"><a class="btn btn-primary" href="/notetaker/">Meet Cornelia &rarr;</a><a class="btn btn-ghost" href="#vision">Our vision</a></div>
  </div>
  <div>__HERO_ART__</div>
</div></section>

<div class="dim">What we're building</div>
<section id="product"><div class="wrap">
  <p class="eyebrow">The product</p>
  <h2>One app, built with <em>care.</em></h2>
  <p class="lede" style="margin-bottom:26px">Our focus right now is Cornelia &mdash; a calm, capable note-taker for students.</p>
  <div class="product">
    <div class="device"><img src="__SHOT0__" alt="Cornelia app screenshot" loading="lazy"></div>
    <div>
      <div class="prod-head"><img src="__ICON__" alt="Cornelia icon"><div><div class="tag">Learning &middot; iOS &amp; Android</div><div class="nm">Cornelia</div></div></div>
      <p class="muted">Record lectures, transcribe speech, and turn it into Cornell, outline and mind-map notes &mdash; plus photo-to-notes for boards and handwritten pages. One calm workflow from mic to exam-ready rows.</p>
      <div class="chips"><span class="chip">Lecture capture</span><span class="chip">Transcripts</span><span class="chip">Cornell layouts</span><span class="chip">Photo-to-notes</span></div>
      <div class="hero-cta" style="margin-top:0"><a class="btn btn-gold" href="/notetaker/#waitlist">Join the waitlist</a><a class="btn btn-ghost" href="/notetaker/">Explore Cornelia</a></div>
    </div>
  </div>
</div></section>

<section id="vision" style="background:rgba(251,246,236,.55);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap center">
  <p class="eyebrow c">M3XI vision</p>
  <h2>Technology that works <em>for your life.</em></h2>
  <p class="lede" style="margin:8px auto 0">We find creative ways to make technology genuinely useful &mdash; on the job and from the home. Painting opportunity through tech, one product at a time.</p>
  <div class="grid3">
    <div class="card"><div class="ic">__IC_SPARK__</div><h3>Opportunity</h3><p>Technology should lower barriers, not raise them. We build tools people can actually reach.</p></div>
    <div class="card"><div class="ic">__IC_RULER__</div><h3>Japanese restraint</h3><p>Fewer surfaces, cleaner type, products that respect your time. 技術と芸術の融合 &mdash; the fusion of technology and art.</p></div>
    <div class="card"><div class="ic">__IC_BUILD__</div><h3>Practical innovation</h3><p>We ship things designed for real-world use &mdash; built to work, not just to demo.</p></div>
  </div>
</div></section>

<section><div class="wrap">
  <p class="eyebrow">How we build</p>
  <h2>From sketch to <em>shipped.</em></h2>
  <div class="steps">
    <div class="step"><div class="no">01</div>__IC_RULER__<h3>Design</h3><p>Start from the problem and the person. Draw it, pressure-test it, keep it simple.</p></div>
    <div class="step"><div class="no">02</div>__IC_BUILD__<h3>Build</h3><p>Real software on real infrastructure &mdash; Expo, React Native, Supabase. Built to last.</p></div>
    <div class="step"><div class="no">03</div>__IC_SHIP__<h3>Ship</h3><p>Put it in hands, listen, refine. Momentum over perfection.</p></div>
  </div>
</div></section>
"""
HOME = (HOME.replace("__HERO_ART__",HERO_ART).replace("__SHOT0__",SHOTW[0]).replace("__ICON__",ICON_S)
  .replace("__IC_SPARK__",IC_SPARK).replace("__IC_RULER__",IC_RULER).replace("__IC_BUILD__",IC_BUILD).replace("__IC_SHIP__",IC_SHIP))

# ===== CORNELIA =====
screens = "".join('<div class="device"><img src="%s" alt="Cornelia screen %d" loading="lazy"></div>' % (u,i+1) for i,u in enumerate(SHOTW))
CORN = """
<section class="hero"><div class="wrap hero-grid">
  <div>
    <p class="eyebrow"><img src="__ICON__" style="width:22px;height:22px;border-radius:6px;vertical-align:middle;margin-right:6px">Cornelia &middot; by M3XI</p>
    <h1>Record once.<br><em>Study with intent.</em></h1>
    <p class="lede">Cornelia captures lectures, transcribes speech, and organises your notes into Cornell, outline, mind-map and box layouts &mdash; plus photo-to-notes for boards and handwritten pages.</p>
    <div class="hero-cta"><a class="btn btn-gold" href="#waitlist">Join the waitlist</a><a class="btn btn-ghost" href="#screens">See the app &rarr;</a></div>
  </div>
  <div style="text-align:center"><div class="device" style="width:252px;margin:0 auto"><img src="__SHOT0__" alt="Cornelia record screen"></div></div>
</div></section>

<div class="dim">Actual UI</div>
<section id="screens"><div class="wrap center">
  <p class="eyebrow c">In-app screens</p>
  <h2>Captured from the <em>real app.</em></h2>
  <div class="screens" style="margin-top:30px">__SCREENS__</div>
</div></section>

<section id="features" style="background:rgba(251,246,236,.55);border-top:1px solid var(--line);border-bottom:1px solid var(--line)"><div class="wrap center">
  <p class="eyebrow c">Flows that matter</p>
  <h2>From waveform to <em>exam-ready rows.</em></h2>
  <p class="lede" style="margin:8px auto 0">Cornelia shares one AI allowance across recording, transcription, notes and photo capture.</p>
  <div class="feat">
    <div class="card"><div class="ic">__IC_MIC__</div><h3>Record &middot; layouts &middot; AI cap</h3><p>Cornell, outline, mind-map or box &mdash; before or after capture. One token-style allowance until you subscribe.</p></div>
    <div class="card"><div class="ic">__IC_DOC__</div><h3>Transcripts + export</h3><p>Jump between Notes, Transcript and Audio. Keywords surface automatically; export to PDF.</p></div>
    <div class="card"><div class="ic">__IC_CAM__</div><h3>Desk &amp; board &rarr; notes</h3><p>Shoot scraps and whiteboards &mdash; the layout engine folds them into your study shelf.</p></div>
  </div>
</div></section>

<section id="reviews"><div class="wrap center">
  <p class="eyebrow c">From students</p>
  <h2>Built for how you <em>revise.</em></h2>
  <div class="reviews">
    <div class="review"><p class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</p><p>&ldquo;The transcript strip and Cornell onboarding finally match how I revise &mdash; fewer pauses, more capture.&rdquo;</p><div class="who"><span class="av">E</span><div><b>Elena</b><small>Biochemistry</small></div></div></div>
    <div class="review"><p class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</p><p>&ldquo;Photo-to-notes bridges my paper mess with searchable rows &mdash; outrageous for exam prep.&rdquo;</p><div class="who"><span class="av">R</span><div><b>Ravi</b><small>Engineering</small></div></div></div>
    <div class="review"><p class="stars">&#9733;&#9733;&#9733;&#9733;&#9734;</p><p>&ldquo;Finally treats full lectures like first-class citizens, not orphaned voice memos.&rdquo;</p><div class="who"><span class="av">M</span><div><b>Maya</b><small>Law</small></div></div></div>
  </div>
</div></section>
""" + WAITLIST_BLOCK + WL_SCRIPT
CORN = (CORN.replace("__ICON__",ICON_S).replace("__SHOT0__",SHOTW[0]).replace("__SCREENS__",screens)
  .replace("__IC_MIC__",IC_MIC).replace("__IC_DOC__",IC_DOC).replace("__IC_CAM__",IC_CAM))

# ===== TEAM =====
TEAM = """
<section class="hero" style="padding-bottom:20px"><div class="wrap">
  <p class="eyebrow">Our people</p>
  <h1>The team behind <em>M3XI.</em></h1>
  <p class="lede">A focused group of builders, thinkers and creators working where technology, creativity and opportunity meet.</p>
</div></section>
<section style="padding-top:10px"><div class="wrap">
  <p class="eyebrow">Leadership</p>
  <div class="people">
    <div class="person"><div class="av">MG</div><div class="role">Chief Executive Officer</div><h3>Michael Gbeleyi</h3><p>Founder and visionary behind M3XI and Cornelia. Driven by the belief that technology should paint opportunity &mdash; making capable tools accessible for work and home life. Building the future of intelligent, creative technology.</p></div>
    <div class="person"><div class="av">MP</div><div class="role">Chief Marketing Officer</div><h3>Michael Parsons</h3><p>Leading brand strategy, growth and creative direction at M3XI. Shaping how the world understands and connects with intelligent technology &mdash; with clarity, precision and artistry.</p></div>
  </div>
</div></section>
<section style="padding-top:0"><div class="wrap">
  <p class="eyebrow">Members</p>
  <h2>Growing the <em>team.</em></h2>
  <p class="lede" style="margin-top:8px">M3XI is expanding. We bring in people who share the vision &mdash; creative thinkers who build with intention.</p>
  <div class="roles">
    <div class="role-card"><div class="k">Development</div><h4>Engineering</h4><p>Building Cornelia and M3XI intelligent systems &mdash; Expo, React Native, Supabase.</p></div>
    <div class="role-card"><div class="k">Design</div><h4>Creative direction</h4><p>Defining the visual language of M3XI &mdash; where Japanese aesthetics meet modern product design.</p></div>
    <div class="role-card"><div class="k">Intelligence</div><h4>M3XI Analysis</h4><p>Building the summary and valuation engine that powers our products' intelligence features.</p></div>
    <div class="role-card"><div class="k">Open role</div><h4>Growth &amp; Partnerships</h4><p>Lead community growth and strategic partnerships. Interested?</p></div>
    <div class="role-card"><div class="k">Open role</div><h4>Robotics research</h4><p>A later phase of M3XI hints at creative robotics. Come help build the foundation.</p></div>
    <div class="role-card"><div class="k">Open role</div><h4>You?</h4><p>If you build with intention and believe technology should better everyday life &mdash; reach out.</p></div>
  </div>
  <p style="margin-top:22px"><a class="btn btn-ghost" href="/contact/">Get in touch &rarr;</a></p>
</div></section>
<section style="background:rgba(251,246,236,.55);border-top:1px solid var(--line)"><div class="wrap center">
  <p class="eyebrow c">M3XI vision</p>
  <h2>Technology that works for <em>your life.</em></h2>
  <p class="lede" style="margin:8px auto 0">We find creative ways to make technology genuinely useful &mdash; on the job and from the home.</p>
  <p class="jp" style="margin-top:14px;letter-spacing:.12em">技術と芸術の融合 &mdash; the fusion of technology and art</p>
</div></section>
"""

# ===== CONTACT =====
IG='<svg viewBox="0 0 24 24"><path d="M7.75 2h8.5A5.75 5.75 0 0 1 22 7.75v8.5A5.75 5.75 0 0 1 16.25 22h-8.5A5.75 5.75 0 0 1 2 16.25v-8.5A5.75 5.75 0 0 1 7.75 2Zm0 1.5A4.25 4.25 0 0 0 3.5 7.75v8.5a4.25 4.25 0 0 0 4.25 4.25h8.5a4.25 4.25 0 0 0 4.25-4.25v-8.5a4.25 4.25 0 0 0-4.25-4.25h-8.5Zm9.12 1.6a1.12 1.12 0 1 1 0 2.24 1.12 1.12 0 0 1 0-2.24ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 1.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/></svg>'
TT='<svg viewBox="0 0 24 24"><path d="M14.5 3h2.2c.16 1.35.92 2.5 2.3 3.1.82.35 1.64.5 2.5.46v2.3a7.15 7.15 0 0 1-4.8-1.62v6.03a5.95 5.95 0 1 1-5.18-5.9v2.35a3.6 3.6 0 1 0 2.98 3.55V3Z"/></svg>'
LI='<svg viewBox="0 0 24 24"><path d="M6.1 8.5v12H2.5v-12h3.6ZM4.3 2A2.3 2.3 0 1 1 4.3 6.6 2.3 2.3 0 0 1 4.3 2Zm5.1 6.5H13v1.64h.05c.5-.95 1.73-1.95 3.56-1.95 3.8 0 4.5 2.4 4.5 5.52v6.74h-3.6v-5.98c0-1.43-.03-3.27-2.1-3.27-2.1 0-2.42 1.56-2.42 3.16v6.09H9.4v-12Z"/></svg>'
CONTACT = """
<section class="hero" style="padding-bottom:20px"><div class="wrap">
  <p class="eyebrow">Get in touch</p>
  <h1>We'd love to <em>hear from you.</em></h1>
  <p class="lede">Cornelia, partnerships, press, or M3XI in general &mdash; reach us at <strong>support@m3xi.com</strong>. We read everything.</p>
</div></section>
<section style="padding-top:10px"><div class="wrap"><div class="contact-grid">
  <div class="contact-card">
    <div class="role" style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);font-weight:600">M3XI</div>
    <a class="email" href="mailto:support@m3xi.com">support@m3xi.com</a>
    <p class="muted" style="margin-top:12px;font-size:14px">All enquiries &mdash; Cornelia, accounts, partnerships, press and general questions.</p>
    <div class="socials" aria-label="M3XI social links">
      <a href="https://www.instagram.com/m3xicorp/" target="_blank" rel="noopener" title="Instagram">__IG__</a>
      <a href="https://www.tiktok.com/@m3xicorp" target="_blank" rel="noopener" title="TikTok">__TT__</a>
      <a href="https://www.linkedin.com/company/111653431/" target="_blank" rel="noopener" title="LinkedIn">__LI__</a>
    </div>
  </div>
  <div class="contact-card">
    <h3 style="margin-bottom:14px">Send a message.</h3>
    <form class="cf" id="cf">
      <label for="cf-name">Name</label><input id="cf-name" type="text" placeholder="Your name">
      <label for="cf-email">Email</label><input id="cf-email" type="email" placeholder="you@example.com">
      <label for="cf-type">Enquiry type</label>
      <select id="cf-type"><option>Cornelia</option><option>General / M3XI</option><option>Partnership / Press</option><option>Investment interest</option></select>
      <label for="cf-msg">Message</label><textarea id="cf-msg" rows="4" placeholder="How can we help?"></textarea>
      <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center">Send message &rarr;</button>
      <p class="muted" id="cf-note" style="font-size:12px;margin-top:10px">Opens your email app addressed to support@m3xi.com.</p>
    </form>
  </div>
</div></div></section>
<script>
 document.getElementById('cf').addEventListener('submit',function(e){e.preventDefault();
  var n=document.getElementById('cf-name').value,em=document.getElementById('cf-email').value,
  t=document.getElementById('cf-type').value,m=document.getElementById('cf-msg').value;
  var sub=encodeURIComponent('['+t+'] enquiry from '+(n||'website'));
  var body=encodeURIComponent((m||'')+'\\n\\n— '+(n||'')+(em?(' ('+em+')'):''));
  window.location.href='mailto:support@m3xi.com?subject='+sub+'&body='+body;
 });
</script>
"""
CONTACT = CONTACT.replace("__IG__",IG).replace("__TT__",TT).replace("__LI__",LI)

# ===== EMIT =====
page("index.html","M3XI — We build software that works","M3XI is a studio building software that lowers barriers and gets things done. Meet Cornelia, our note-taking app for students.",HOME,active="home")
page("notetaker/index.html","Cornelia · Note-taking by M3XI","Cornelia — lecture recording, transcripts, Cornell & outline layouts, photo-to-notes. Join the waitlist.",CORN,active="corn",fav="__FAVICON__")
page("team/index.html","Team — M3XI","The people building M3XI and Cornelia.",TEAM,active="team")
page("contact/index.html","Contact — M3XI","Get in touch with M3XI — support@m3xi.com.",CONTACT)

# cornelia favicon = real app icon
import io
p=os.path.join(OUT,"notetaker/index.html"); html=open(p,encoding="utf-8").read().replace("__FAVICON__",ICON_FAV); open(p,"w",encoding="utf-8").write(html)
print("DONE")

LEGAL_CSS = """
.legal{max-width:790px;margin:0 auto}
.legal .eff{color:var(--ink2);font-size:13px;margin:-2px 0 22px}
.legal h2{font-size:22px;margin:32px 0 10px;padding-top:18px;border-top:1px solid var(--line)}
.legal h3{font-size:15.5px;margin:18px 0 6px;font-family:'Inter',sans-serif;font-weight:600}
.legal p,.legal li{color:#403b32;font-size:15px}
.legal ul{margin:0 0 14px;padding-left:20px}.legal li{margin:5px 0}
.legal table{width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:14px}
.legal td{border:1px solid var(--line);padding:8px 10px;vertical-align:top}
.legal td:first-child{font-weight:600;width:32%;background:var(--paper2)}
.legal a{color:var(--blue);text-decoration:underline}
.legal .lead{font-size:16px;color:#3a362d}
"""

PRIVACY = """
<section class="hero" style="padding:48px 0 8px"><div class="wrap"><div class="legal">
  <p class="eyebrow">Legal</p>
  <h1 style="font-size:clamp(34px,5vw,52px)">Privacy Policy</h1>
  <p class="eff">Effective: 28 April 2026 &middot; Last updated: 28 April 2026</p>
</div></div></section>
<section style="padding-top:6px"><div class="wrap"><div class="legal">
  <p class="lead">This Privacy Policy explains how <strong>M3XI</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) collects, uses, and shares personal data when you use our <strong>mobile applications</strong> (including <strong>Cornelia</strong> &mdash; listed on stores as <strong>NoteTaker</strong> &mdash; and other M3XI apps where offered) and the <strong>M3XI website</strong>. By using our services, you agree to this policy.</p>
  <p><strong>Scope.</strong> Some details apply only to certain apps&mdash;where relevant, we name the product. Features may vary by platform and version.</p>

  <h2>1. Who we are</h2>
  <p><strong>Controller:</strong> M3XI, operating in England and Wales.<br><strong>Privacy &amp; GDPR requests:</strong> <a href="mailto:support@m3xi.com">support@m3xi.com</a>.<br><strong>Mailing address:</strong> available on written request sent to the email above.</p>

  <h2>2. What our apps &amp; website are</h2>
  <ul>
    <li><strong>Cornelia (stores: NoteTaker)</strong> &mdash; lecture recording, transcription, and notes organised using the Cornell note-taking method (cues, main notes, summaries), optional images from camera or gallery, titles and text notes, and account sync.</li>
    <li><strong>M3XI website</strong> &mdash; marketing pages, privacy/terms, and contact.</li>
  </ul>

  <h2>3. Data we collect (by category)</h2>
  <h3>Account and identity</h3>
  <ul><li>Email address, name, avatar or profile basics from your sign-in provider.</li><li>An internal user ID tied to your account.</li></ul>
  <h3>User content</h3>
  <ul><li><strong>Cornelia / NoteTaker:</strong> audio recordings; generated transcripts; images you capture or choose; note text, titles, tags; timestamps and ordering metadata.</li></ul>
  <h3>Device / app telemetry</h3>
  <p>We may collect device type, operating system, app version, and coarse diagnostic data (such as stability information) via platform or third-party tooling where enabled to operate and secure the apps. We do not sell personal data.</p>
  <h3>Payments</h3>
  <p>Payments are handled by <strong>Stripe</strong>. We do not collect or store full card numbers. We receive identifiers and status needed to administer subscriptions&mdash;such as customer ID, plan, and billing state&mdash;from Stripe.</p>

  <h2>4. Purposes</h2>
  <ul><li>Provide the service&mdash;sync, storage, transcription, and related workflows.</li><li>Authentication, security, anti-abuse, and fraud prevention.</li><li>Billing and plan status.</li><li>Support, and enforcement of rules and legal obligations.</li></ul>

  <h2>5. Legal bases (UK / EU / UK GDPR)</h2>
  <ul><li><strong>Contract</strong> &mdash; delivering the apps and requested features.</li><li><strong>Legitimate interests</strong> &mdash; security, debugging, preventing abuse, and improving products (balanced against your rights).</li><li><strong>Consent</strong> &mdash; where required (e.g. non-essential website cookies).</li></ul>

  <h2>6. Third parties (subprocessors)</h2>
  <ul>
    <li><strong>Supabase</strong> &mdash; authentication, Postgres database, and object storage hosting for accounts and your content.</li>
    <li><strong>OpenAI (or successor AI processors we configure)</strong> &mdash; audio and text you provide may be processed for transcription and optional image understanding on Cornelia. Processing follows the provider&rsquo;s API terms for business use.</li>
    <li><strong>Google</strong> &mdash; Google Sign-In OAuth; identity tokens/profile fields required to authenticate you.</li>
    <li><strong>Stripe</strong> &mdash; payment processing and billing records.</li>
    <li><strong>Infrastructure / CDN / hosting</strong> (e.g. Vercel) &mdash; operational delivery of the website and APIs; routing and HTTPS.</li>
  </ul>
  <p>We use each provider under written terms appropriate to processors; we don&rsquo;t sell your personal data.</p>

  <h2>7. AI / cloud versus on-device</h2>
  <p>For Cornelia, certain workflows run in the cloud (including transmission to transcription/AI APIs). Depending on implementation and settings, other steps may occur on your device first (recording, offline caching). Exact routing can vary by OS build and toggle&mdash;consult in-app disclosures where provided. Retention by AI vendors is governed by their policies plus our deletion requests and account workflows.</p>

  <h2>8. Location, storage, security, retention</h2>
  <p><strong>Locations:</strong> data may reside in regions where Supabase, Stripe, AI providers, and hosting operate (possibly including the UK, EEA, and United States). <strong>Transfers:</strong> where personal data transfers outside your country occur, we use appropriate safeguards (including Standard Contractual Clauses where applicable). <strong>Security:</strong> encryption in transit (HTTPS/TLS), least-privilege access controls, and hardened cloud configuration. <strong>Retention:</strong> active accounts retain profile and content unless you delete items or terminate the account&mdash;then we erase or anonymise within a reasonable window (typically within 30 days), except mandatory legal, tax, dispute, or fraud-prevention records.</p>

  <h2>9. App permissions</h2>
  <table>
    <tr><td>Microphone</td><td>Record voice notes and dictation.</td></tr>
    <tr><td>Camera / photos</td><td>Attach images you choose to capture or import for notes.</td></tr>
    <tr><td>Storage / media</td><td>Pick or export files locally when the feature permits.</td></tr>
    <tr><td>Internet</td><td>Sync, sign-in, cloud transcription, backups, subscriptions, and telemetry.</td></tr>
  </table>

  <h2>10. Children</h2>
  <p>Cornelia is not aimed at children under 13; we don&rsquo;t knowingly collect children&rsquo;s personal data outside permitted contexts.</p>

  <h2>11. Your rights</h2>
  <p>Depending on jurisdiction, you may exercise access, correction, deletion, portability, restriction, objection, or complaint rights. Requests: <a href="mailto:support@m3xi.com">support@m3xi.com</a> from your registered email where feasible. UK users may also contact the ICO at <a href="https://ico.org.uk/make-a-complaint/" target="_blank" rel="noopener">ico.org.uk</a>.</p>

  <h2>12. Cookies (website)</h2>
  <p>On this marketing site, we may use strictly necessary operational cookies plus optional analytics aligned with consent tooling if deployed.</p>

  <h2>13. Changes</h2>
  <p>We may update this policy; we will post the revision date at the top and, if material, notify through the app or email.</p>

  <h2>14. More help</h2>
  <p>All privacy and app enquiries: <a href="mailto:support@m3xi.com">support@m3xi.com</a>. See also <a href="/terms/">Terms of Use</a>.</p>
</div></div></section>
"""

TERMS = """
<section class="hero" style="padding:48px 0 8px"><div class="wrap"><div class="legal">
  <p class="eyebrow">Legal</p>
  <h1 style="font-size:clamp(34px,5vw,52px)">Terms &amp; Conditions</h1>
  <p class="eff">Last updated: 28 April 2026</p>
</div></div></section>
<section style="padding-top:6px"><div class="wrap"><div class="legal">
  <p class="lead">These Terms and Conditions govern your use of M3XI&rsquo;s mobile applications (including <strong>Cornelia</strong>) and the M3XI website (collectively, the &ldquo;Platform&rdquo;), operated by M3XI (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;). By using the Platform, you agree to these Terms. If you disagree, you must not use the Platform.</p>

  <h2>1. The Platform</h2>
  <p>Cornelia helps you record lectures, transcribe speech, and organise notes. We provide tooling and services &mdash; we do not guarantee any particular study or academic outcome.</p>

  <h2>2. Eligibility</h2>
  <p>You must be legally capable of entering binding agreements and meet the minimum age for your region and the relevant app store. By using the Platform, you confirm you meet these requirements.</p>

  <h2>3. Accounts and subscriptions</h2>
  <p>You may be required to create an account to access certain features. Some features may require a subscription or unlock fee. You are responsible for all activity conducted through your account.</p>
  <h3>3.1 Payments and refunds</h3>
  <ul><li>All payments are final unless otherwise required by applicable law.</li><li>Refund requests must be submitted within 72 hours of the initial purchase.</li><li>No refunds will be issued after the 72-hour window.</li></ul>

  <h2>4. Your content &amp; IP</h2>
  <h3>4.1 What you retain</h3>
  <p>You retain ownership of your recordings, transcripts, notes, images, and other materials you submit, subject to the licence below.</p>
  <h3>4.2 Licence to M3XI</h3>
  <p>To operate sync, transcription, backups, safety, and product improvement within the Platform, you grant M3XI a worldwide, non-exclusive, royalty-free licence to host, process (including automated and AI-assisted processing), display, transmit, and create incidental copies of your content. You confirm you have the rights to grant this licence.</p>
  <h3>4.3 Third-party rights</h3>
  <p>Do not upload content that infringes others&rsquo; IP or privacy rights. We may remove infringing or unlawful content.</p>

  <h2>5. Prohibited conduct</h2>
  <ul><li>Posting fraudulent, misleading, or deceptive content.</li><li>Impersonating individuals or entities.</li><li>Using the Platform for illegal activities.</li></ul>

  <h2>6. AI disclaimer</h2>
  <p>Transcription and AI-assisted notes are informational and approximate. They are not professional advice&mdash;always confirm material decisions independently. Accuracy may vary across languages or accents.</p>

  <h2>7. Limitation of liability</h2>
  <ul><li>We are not liable for indirect, incidental, consequential, or special damages.</li><li>We are not liable for loss of profits, opportunities, data, or reputation.</li><li>Our total liability shall not exceed the amount paid by you to the Platform in the preceding 12 months.</li></ul>

  <h2>8. Suspension and termination</h2>
  <p>We reserve the right to suspend or terminate accounts without notice for violations of these Terms or applicable laws. We may also remove content that violates these Terms.</p>

  <h2>9. Indemnification</h2>
  <p>You agree to indemnify and hold harmless M3XI, its officers, employees, and affiliates from any claims, damages, or expenses arising from your use of the Platform or your violation of these Terms.</p>

  <h2>10. Governing law</h2>
  <p>These Terms are governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.</p>

  <h2>11. Changes</h2>
  <p>We may modify these Terms at any time. Continued use after changes constitutes acceptance. Material changes will be notified via the app or email.</p>

  <h2>12. Contact</h2>
  <p>For Terms-related enquiries: <a href="mailto:support@m3xi.com">support@m3xi.com</a>.</p>
</div></div></section>
"""

page("privacy/index.html","Privacy Policy — M3XI","How M3XI collects, uses and protects your data across Cornelia and the M3XI website.",PRIVACY,xcss=LEGAL_CSS)
page("terms/index.html","Terms & Conditions — M3XI","The terms governing use of M3XI apps (including Cornelia) and the M3XI website.",TERMS,xcss=LEGAL_CSS)
print("LEGAL DONE")
