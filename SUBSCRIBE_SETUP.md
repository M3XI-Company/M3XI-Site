# StartUp Subscribe Setup

This project now sends subscriptions through `api/subscribe.js` and feedback through `api/feedback.js`.

Resend is used with the official SDK in `api/subscribe.js`:

```javascript
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

await resend.emails.send({
  from: process.env.SUBSCRIBE_SENDER_EMAIL,
  to: process.env.SUBSCRIBE_NOTIFY_EMAIL,
  subject: "New StartUp subscriber",
  html: "<p>A new user has subscribed.</p>"
});
```

## Required environment variables (local + production)

- `RESEND_API_KEY` - API key from Resend
- `SUBSCRIBE_SENDER_EMAIL` - sender address (must be verified in Resend), example: `hello@m3xi.com`
- `SUBSCRIBE_NOTIFY_EMAIL` - your inbox that receives new subscriber notifications

Use these values for your current setup:

- `SUBSCRIBE_SENDER_EMAIL=startup@m3xi.com`
- `SUBSCRIBE_NOTIFY_EMAIL=startup@m3xi.com`
- `RESEND_API_KEY=re_xxxxxxxxx` (replace with your real key)

## Steps

1. Create a [Resend](https://resend.com) account.
2. Verify your domain in Resend (recommended: `m3xi.com`).
3. Create an API key in Resend.
4. Put the variables in local `.env` for local testing.
5. Put the same variables in your hosting provider environment settings.
6. Redeploy.

## Hosting notes

- Render (Web Service): use `npm install && npm run build` as Build Command and `npm run start` as Start Command.
- Render: open your service > Environment > add the 3 variables > Save > redeploy.
- Vercel: open project settings > Environment Variables > add the 3 variables > redeploy.
- Do not commit real keys; keep real values only in `.env` and hosting env settings.

## What happens after setup

- User submits email on `startup.html`.
- Your email (`SUBSCRIBE_NOTIFY_EMAIL`) receives a "New StartUp subscriber" message.
- Subscriber receives an automatic thank-you email.
- Feedback submitted on `startup.html` is sent to `SUBSCRIBE_NOTIFY_EMAIL`.
