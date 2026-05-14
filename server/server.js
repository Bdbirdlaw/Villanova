/* =============================================================
   Nova Nation Exchange — Stripe Connect backend (minimal)

   Run:
     cd server
     cp .env.example .env   # then fill in your Stripe test keys
     npm install
     npm run dev

   In a second terminal (for webhooks during local dev):
     stripe listen --forward-to localhost:4242/api/webhooks/stripe

   Then open http://localhost:4242 — the existing index.html is
   served from the parent directory.

   How the 10% → VASE math works on Stripe:
   - Buyer pays one charge for: ticket + service fee + processing + VASE.
   - We use a Checkout Session with `payment_intent_data.transfer_data`
     pointing at the seller's connected (Express) account.
   - `application_fee_amount` = (service fee + processing + VASE share).
     Stripe holds that on the platform account. The remainder
     (ticket price) is paid to the seller automatically.
   - Quarterly, the platform initiates an ACH payout from its
     Stripe balance to the VASE Fund. That part is operational
     (Stripe Treasury or manual ACH); not coded here.

   Production hardening TODO (intentionally NOT done in this scaffold):
   - Real ticket DB + atomic "hold" so two buyers can't claim
     the same seat. Currently we trust the in-memory mock.
   - Idempotency keys on Checkout Session creation.
   - Auth: tie the buyer/seller IDs to real user accounts.
   - Apple Wallet pass generation (PKPass signing) after
     payment_intent.succeeded webhook fires.
   ============================================================= */

import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

const PORT       = process.env.PORT || 4242;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠  STRIPE_SECRET_KEY is missing. Copy server/.env.example to server/.env and fill in your Stripe test keys.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing', {
  apiVersion: '2024-09-30.acacia',
});

const app = express();

/* -------------------------------------------------------------
   1. WEBHOOKS — must use raw body, registered BEFORE express.json()
   ------------------------------------------------------------- */
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const vaseCents = s.metadata?.vase_cents
          ? parseInt(s.metadata.vase_cents, 10)
          : 0;
        const ticketId  = s.metadata?.ticket_id || '?';
        console.log(
          `[VASE] Session ${s.id} completed. Ticket=${ticketId} ` +
          `VASE share=$${(vaseCents / 100).toFixed(2)} ` +
          `buyer=${s.customer_details?.email || '?'}`
        );
        // TODO: persist VASE accrual; trigger Apple Wallet pass; email buyer.
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        console.log(`[PAY] PI ${pi.id} succeeded for $${(pi.amount / 100).toFixed(2)}`);
        break;
      }
      case 'account.updated': {
        const acct = event.data.object;
        console.log(
          `[CONNECT] Account ${acct.id} updated. charges_enabled=${acct.charges_enabled} ` +
          `payouts_enabled=${acct.payouts_enabled}`
        );
        break;
      }
      case 'charge.refunded': {
        const c = event.data.object;
        console.log(`[REFUND] Charge ${c.id} refunded $${(c.amount_refunded / 100).toFixed(2)}`);
        // TODO: claw back VASE accrual.
        break;
      }
      default:
        // Ignore.
    }
    res.json({ received: true });
  }
);

app.use(express.json());

/* -------------------------------------------------------------
   2. MOCK TICKET STORE
   In production: real DB query, with row-level lock so the
   same seat can't be checked out twice. Prices MUST be looked
   up server-side — never trust the client for the amount.
   ------------------------------------------------------------- */
const TICKETS = {
  T01: { label: 'Villanova vs UConn — Sec 109 R F S 12',     priceCents: 18500 },
  T02: { label: 'Villanova @ Georgetown — Sec 107 R C S 8',  priceCents:  9500 },
  T03: { label: 'Villanova vs Marquette — Sec 102 R J S 21', priceCents: 12000 },
  T04: { label: 'Villanova vs Creighton — Sec 104 R D S 4',  priceCents: 11000 },
  T05: { label: "Villanova @ St. John's — Sec 224 R K S 17", priceCents:  8500 },
  T06: { label: 'Villanova vs Xavier — Sec 111 R G S 6',     priceCents:  9000 },
  T07: { label: 'Villanova vs Butler — Sec 113 R L S 14',    priceCents:  7500 },
  T08: { label: 'Villanova vs Providence — Sec 106 R B S 2', priceCents:  8000 },
  T09: { label: 'Villanova vs DePaul — Sec 108 R M S 22',    priceCents:  5500 },
  T10: { label: 'Villanova @ Seton Hall — Sec 108 R F S 9',  priceCents:  6500 },
  T11: { label: 'Villanova vs UConn (Big East) — Sec 108 R A S 1', priceCents: 39500 },
  T12: { label: 'Villanova vs UConn (W) — Sec 105 R C S 6',  priceCents:  4000 },
  T13: { label: 'Villanova vs Marquette (W) — Sec 110 R E S 11', priceCents: 3000 },
  T14: { label: 'Villanova vs Delaware (FB) — NE 14/34',     priceCents:  3500 },
  T15: { label: 'Villanova vs Richmond (FB) — W 8/20',       priceCents:  2500 },
  T16: { label: 'Villanova vs Notre Dame (M LAX) — GA',      priceCents:  2500 },
  T17: { label: 'Villanova vs Penn State (W LAX) — GA',      priceCents:  2000 },
  T18: { label: 'Villanova vs Georgetown (BSB) — GA',        priceCents:  1500 },
};

const VASE_BPS = 1000; // 10.00%
const FEE_BPS  =  750; //  7.50% service fee
const PROC_BPS =  250; //  2.50% processing

function breakdown(ticketCents) {
  const feeCents  = Math.round(ticketCents * FEE_BPS  / 10000);
  const procCents = Math.round(ticketCents * PROC_BPS / 10000);
  const vaseCents = Math.round(ticketCents * VASE_BPS / 10000);
  const totalCents = ticketCents + feeCents + procCents + vaseCents;
  // application_fee_amount = what the PLATFORM keeps:
  // service fee + processing + VASE share. Seller gets the rest (ticket).
  const appFeeCents = feeCents + procCents + vaseCents;
  return { ticketCents, feeCents, procCents, vaseCents, totalCents, appFeeCents };
}

/* -------------------------------------------------------------
   3. CHECKOUT SESSION
   ------------------------------------------------------------- */
app.post('/api/checkout/create-session', async (req, res) => {
  try {
    const { ticketId, buyerEmail, sellerAccountId } = req.body || {};
    const ticket = TICKETS[ticketId];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const b = breakdown(ticket.priceCents);

    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: buyerEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: b.totalCents,
            product_data: {
              name: ticket.label,
              description:
                'Includes 10% VASE Fund contribution (Villanova Athletics Strategic Excellence). ' +
                'Built by Wildcats. For Wildcats.',
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${PUBLIC_URL}/?checkout=success&sid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${PUBLIC_URL}/?checkout=cancel`,
      metadata: {
        ticket_id:    ticketId,
        ticket_cents: String(b.ticketCents),
        vase_cents:   String(b.vaseCents),
        fee_cents:    String(b.feeCents),
        proc_cents:   String(b.procCents),
      },
    };

    // If a seller Connect account is supplied, route via destination charge.
    // Otherwise the entire amount sits on the platform (useful for the
    // demo/test path until a real seller has onboarded).
    if (sellerAccountId) {
      sessionParams.payment_intent_data = {
        application_fee_amount: b.appFeeCents,
        transfer_data: { destination: sellerAccountId },
        metadata: {
          ticket_id:  ticketId,
          vase_cents: String(b.vaseCents),
        },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({
      url: session.url,
      id: session.id,
      breakdown: b,
    });
  } catch (e) {
    console.error('create-session failed:', e);
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------------------------
   4. SELLER ONBOARDING — Stripe Connect Express
   ------------------------------------------------------------- */
app.post('/api/connect/onboard', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const account = await stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
      business_type: 'individual',
      metadata: { source: 'nova-nation-exchange' },
    });

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${PUBLIC_URL}/?connect=refresh`,
      return_url:  `${PUBLIC_URL}/?connect=return&acct=${account.id}`,
      type: 'account_onboarding',
    });

    res.json({ accountId: account.id, url: link.url });
  } catch (e) {
    console.error('connect/onboard failed:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/connect/status/:accountId', async (req, res) => {
  try {
    const acct = await stripe.accounts.retrieve(req.params.accountId);
    res.json({
      id: acct.id,
      chargesEnabled: acct.charges_enabled,
      payoutsEnabled: acct.payouts_enabled,
      detailsSubmitted: acct.details_submitted,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------------------------------------------------
   5. PRICE-PREVIEW (used by the modal to show the live receipt
      from the canonical server math, not client-side rounding).
   ------------------------------------------------------------- */
app.get('/api/tickets/:id/preview', (req, res) => {
  const t = TICKETS[req.params.id];
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json({ id: req.params.id, label: t.label, ...breakdown(t.priceCents) });
});

/* -------------------------------------------------------------
   6. HEALTH + STATIC
   ------------------------------------------------------------- */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing-keys',
    publicUrl: PUBLIC_URL,
  });
});

// Serve the existing front-end (parent directory).
app.use(express.static(ROOT));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, () => {
  console.log(`Nova Nation Exchange server running on ${PUBLIC_URL}`);
  console.log(`10% of every transaction → VASE. Built by Wildcats. For Wildcats.`);
});
