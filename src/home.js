/*
 * m3xi.com/ — the M3XI homepage's own script. The header and footer are
 * /shared/site-chrome.js. The page needs no script to read; this only looks
 * after old links.
 *
 * CallMe used to be this page, and then the Breeze waitlist was. Their old
 * in-page links follow them to where they live now.
 */
function forward() {
  const h = location.hash;
  if (h === '#faq') location.replace('/questions/');
  else if (/^#q-(basics|calls|safety|cost)$/.test(h)) location.replace('/questions/' + h);
  else if (h === '#safety') location.replace('/safety/');
  else if (/^#(how|dog|new|screens|get|create|questions|team|contact)$/.test(h)) location.replace('/callme/' + h);
  else if (/^#(waitlist|how-it-works|preview|join)$/.test(h)) location.replace('/breeze/' + location.search + h);
}
forward();
window.addEventListener('hashchange', forward);
