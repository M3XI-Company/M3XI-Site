import { Resend } from "resend";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed." });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.SUBSCRIBE_NOTIFY_EMAIL;
  const senderEmail = process.env.SUBSCRIBE_SENDER_EMAIL;

  if (!apiKey || !notifyEmail || !senderEmail) {
    return res.status(500).json({
      message: "Subscription service is not configured yet."
    });
  }

  const body = normalizeBody(req.body);
  const email = String(body?.email || "").trim().toLowerCase();

  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ message: "Please provide a valid email." });
  }

  try {
    const resend = new Resend(apiKey);

    await resend.emails.send({
      from: senderEmail,
      to: notifyEmail,
      replyTo: email,
      subject: "New StartUp subscriber",
      text: `New subscriber: ${email}`
    });

    await resend.emails.send({
      from: senderEmail,
      to: email,
      subject: "Thank you for subscribing to StartUp",
      text: "Thank you for subscribing to StartUp. We will keep you updated."
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Subscribe error:", error);
    return res.status(502).json({
      message: "We could not send your subscription right now. Please try again."
    });
  }
}
