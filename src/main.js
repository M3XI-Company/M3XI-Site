/*
 * m3xi.com/ — the CallMe front page's own script. The header, the footer and
 * the store badges (and the App Store flag) are /shared/site-chrome.js.
 * The page reads fine without this: it only tidies up after old links and
 * missing pictures.
 */

// The full FAQ and the safety strip moved to their own pages; old deep links
// follow them there.
function forward() {
  const h = location.hash;
  if (h === '#faq') location.replace('/questions/');
  else if (/^#q-(basics|calls|safety|cost)$/.test(h)) location.replace('/questions/' + h);
  else if (h === '#safety') location.replace('/safety/');
}
forward();
window.addEventListener('hashchange', forward);

// An image that names a fallback swaps to that picture if it fails. (The
// screenshots in phone frames have their own fallback, on every page, in
// /shared/site-chrome.js.)
function whenBroken(img, fn) {
  // A lazy image not fetched yet is not `complete`, so this only catches
  // images that have already failed before this module ran.
  if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fn();
  else img.addEventListener('error', fn, { once: true });
}

document.querySelectorAll('img[data-fallback]').forEach((img) => {
  whenBroken(img, () => { img.src = img.dataset.fallback; });
});
