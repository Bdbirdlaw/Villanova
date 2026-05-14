/* Email sender — Resend when configured, console fallback in dev. */
import { Resend } from 'resend';

const KEY  = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM || 'Nova Nation Exchange <onboarding@resend.dev>';
const resend = KEY ? new Resend(KEY) : null;

export async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    console.log('\n──────── EMAIL (dev fallback — set RESEND_API_KEY to send) ────────');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || stripHtml(html));
    console.log('───────────────────────────────────────────────────────────────────\n');
    return { id: 'dev-' + Date.now() };
  }
  try {
    return await resend.emails.send({ from: FROM, to, subject, html, text });
  } catch (e) {
    console.error('[email] Resend failed:', e?.message || e);
    throw e;
  }
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

/* Reusable email body — minimal styling, mostly inline so it survives mail clients. */
export function wrap(bodyHtml) {
  return `
<!doctype html><html><body style="margin:0;padding:0;background:#FBF8F1;font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#0F1F47">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <div style="font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:#5C6478;margin-bottom:8px">Nova Nation Exchange</div>
    <hr style="border:none;border-top:1px solid #1B2A47;margin:0 0 20px 0"/>
    ${bodyHtml}
    <hr style="border:none;border-top:1px dashed #D6CFB6;margin:32px 0 14px 0"/>
    <div style="font-size:11px;color:#5C6478;line-height:1.6">
      Nova Nation Exchange is a fan-built ticket platform.
      Not officially affiliated with Villanova University.
      10% of every transaction is routed quarterly to the VASE Fund.
    </div>
  </div>
</body></html>`;
}
