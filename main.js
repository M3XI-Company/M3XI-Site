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
  subscribeForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(subscribeForm);
    const email = String(formData.get("email") || "").trim();
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!isValidEmail) {
      subscribeMessage.textContent = "Please enter a valid email address.";
      return;
    }

    // Placeholder success flow. Replace with backend/API call for real subscriptions.
    subscribeMessage.textContent = "Thanks for subscribing to M3XI.StartUp updates.";
    subscribeForm.reset();
  });
}

if (feedbackForm && feedbackMessage) {
  feedbackForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(feedbackForm);
    const feedback = String(formData.get("feedback") || "").trim();

    if (feedback.length < 8) {
      feedbackMessage.textContent = "Please add a bit more detail before sending.";
      return;
    }

    const subject = encodeURIComponent("StartUp User Feedback");
    const body = encodeURIComponent(feedback);
    window.location.href = `mailto:StartUp.support@m3xi.com?subject=${subject}&body=${body}`;
    feedbackMessage.textContent = "Opening your email app to send feedback.";
    feedbackForm.reset();
  });
}