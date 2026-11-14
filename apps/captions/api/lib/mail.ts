/**
 * Email through Resend (resend.com), on this server's own key: RESEND_API_KEY and MAIL_FROM in .env
 * (MAIL_FROM like `Creator Toolset <invites@example.com>`, on a domain verified at Resend). Without both, nothing is sent
 * and the screens that would send show no email field.
 */
export const mailOn = (): boolean => Boolean(process.env.RESEND_API_KEY?.trim() && process.env.MAIL_FROM?.trim());

export const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;

/** One plain-text email. Throws with the reason when Resend refuses it. */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!mailOn()) throw new Error("Email isn't set up on this server");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM!.trim(), to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const why = ((await res.json().catch(() => ({}))) as { message?: string }).message;
    throw new Error(`The email was not sent${why ? `: ${why}` : ""}`);
  }
}
