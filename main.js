const yearNode = document.querySelector("#year");
const revealSections = document.querySelectorAll(".reveal");
const subscribeForm = document.querySelector("#subscribe-form");
const subscribeMessage = document.querySelector("#subscribe-message");
const feedbackForm = document.querySelector("#feedback-form");
const feedbackMessage = document.querySelector("#feedback-message");

if (yearNode) {
  yearNode.textContent = String(new Date().getFullYear());
}

if (revealSections.length > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
        } else {
          entry.target.classList.remove("is-visible");
        }
      });
    },
    {
      threshold: 0.25
    }
  );

  revealSections.forEach((section) => observer.observe(section));
}

if (subscribeForm && subscribeMessage) {
  subscribeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(subscribeForm);
    const email = String(formData.get("email") || "").trim();
    const submitButton = subscribeForm.querySelector("button[type=\"submit\"]");
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!isValidEmail) {
      subscribeMessage.textContent = "Please enter a valid email address.";
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }
    subscribeMessage.textContent = "Subscribing...";

    try {
      const response = await fetch("/api/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email })
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        subscribeMessage.textContent =
          payload?.message || "Unable to subscribe right now. Please try again.";
        return;
      }

      subscribeMessage.textContent = "Thank you for subscribing to StartUp.";
      subscribeForm.reset();
    } catch (error) {
      subscribeMessage.textContent =
        "Network error. Please try again in a moment.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });
}

if (feedbackForm && feedbackMessage) {
  feedbackForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(feedbackForm);
    const feedback = String(formData.get("feedback") || "").trim();
    const submitButton = feedbackForm.querySelector("button[type=\"submit\"]");

    if (feedback.length < 8) {
      feedbackMessage.textContent = "Please add a bit more detail before sending.";
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }
    feedbackMessage.textContent = "Sending feedback...";

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ feedback })
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        feedbackMessage.textContent =
          payload?.message || "Unable to send feedback right now. Please try again.";
        return;
      }

      feedbackMessage.textContent = "Thanks. Your feedback has been sent.";
      feedbackForm.reset();
    } catch (error) {
      feedbackMessage.textContent = "Network error. Please try again in a moment.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });
}

/* App Showcase Carousel */
(function initCarousel() {
  const showcase = document.querySelector(".app-showcase");
  if (!showcase) return;

  const track = showcase.querySelector(".carousel-track");
  const slides = showcase.querySelectorAll(".carousel-slide");
  const dots = showcase.querySelectorAll(".carousel-dot");
  const panels = showcase.querySelectorAll(".feature-panel");
  const prevBtn = showcase.querySelector(".carousel-prev");
  const nextBtn = showcase.querySelector(".carousel-next");

  const total = slides.length;
  if (total === 0) return;

  let current = 0;
  let touchStartX = 0;
  let touchEndX = 0;

  function goTo(index) {
    current = ((index % total) + total) % total;
    track.style.transform = `translateX(-${current * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle("active", i === current));
    panels.forEach((p, i) => p.classList.toggle("active", i === current));
  }

  dots.forEach((dot, i) => {
    dot.addEventListener("click", () => goTo(i));
  });

  if (prevBtn) prevBtn.addEventListener("click", () => goTo(current - 1));
  if (nextBtn) nextBtn.addEventListener("click", () => goTo(current + 1));

  showcase.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  showcase.addEventListener("touchend", (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 50) {
      goTo(diff > 0 ? current + 1 : current - 1);
    }
  }, { passive: true });
})();