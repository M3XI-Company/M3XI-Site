import { Resend } from "resend";

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
      message: "Feedback service is not configured yet."
    });
  }

  const body = normalizeBody(req.body);
  const feedback = String(body?.feedback || "").trim();

  if (feedback.length < 8) {
    return res.status(400).json({
      message: "Please add a bit more detail before sending."
    });
  }

  try {
    const resend = new Resend(apiKey);

    await resend.emails.send({
      from: senderEmail,
      to: notifyEmail,
      subject: "New StartUp feedback",
      text: `Feedback submitted:\n\n${feedback}`
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Feedback error:", error);
    return res.status(502).json({
      message: "We could not send feedback right now. Please try again."
    });
  }
}
