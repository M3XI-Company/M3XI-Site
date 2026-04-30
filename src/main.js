import './style.css';

// Section reveal on scroll (no WebGL / petals)
const sections = document.querySelectorAll('section');

sections.forEach(section => {
  section.classList.add('section-reveal');
});

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, {
  threshold: 0.1,
  rootMargin: '0px 0px -40px 0px',
});

sections.forEach(section => observer.observe(section));
