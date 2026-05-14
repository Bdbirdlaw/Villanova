/* =====================================================================
   Nova Nation Exchange — server
   SQLite + magic-link auth + Stripe Connect + Resend email.

   Run:
     cd server
     cp .env.example .env  (fill in keys)
     npm install
     npm run seed
     npm run dev

   In a second terminal (for webhooks during local dev):
     stripe listen --forward-to localhost:4242/api/webhooks/stripe
   ===================================================================== */
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import Stripe from 'stripe';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { sendEmail, wrap } from './email.js';
import {
  requestMagicLink, verifyMagicToken,
  createSession, destroySession,
  attachUser, requireAuth,
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

const PORT       = process.env.PORT || 4242;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const stripe     = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing', {
  apiVersion: '2024-09-30.acacia',
});

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('⚠  STRIPE_SECRET_KEY missing — Stripe endpoints will fail until configured.');
}

/* ----- Pricing math (single source of truth, server-side) ----- */
const VASE_BPS = 1000;  // 10.00%
const FEE_BPS  =  750;  //  7.50% service
const PROC_BPS =  250;  //  2.50% processing
function breakdown(askCents) {
  const fee  = Math.round(askCents * FEE_BPS  / 10000);
  const proc = Math.round(askCents * PROC_BPS / 10000);
  const vase = Math.round(askCents * VASE_BPS / 10000);
  const total = askCents + fee + proc + vase;
  return { ticket: askCents, fee, proc, vase, total, app_fee: fee + proc + vase };
}

const app = express();

/* =====================================================================
   1. WEBHOOKS — must use raw body, register BEFORE express.json().
   ===================================================================== */
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'account.updated': {
        const acct = event.data.object;
        db.prepare(`UPDATE users SET charges_enabled = ?, payouts_enabled = ? WHERE stripe_account_id = ?`)
          .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, acct.id);
        break;
      }
      case 'charge.refunded': {
        const c = event.data.object;
        if (c.payment_intent) {
          db.prepare(`UPDATE transactions SET status = 'refunded' WHERE stripe_payment_intent_id = ?`).run(c.payment_intent);
        }
        break;
      }
    }
  } catch (e) {
    console.error('[webhook] handler error:', e);
  }
  res.json({ received: true });
});

async function handleCheckoutCompleted(session) {
  const txId = session.metadata?.transaction_id && parseInt(session.metadata.transaction_id, 10);
  if (!txId) return;

  db.prepare(`
    UPDATE transactions
    SET status = 'paid',
        stripe_payment_intent_id = ?,
        paid_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(session.payment_intent || null, txId);

  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!tx) return;

  // Mark listing sold (only if still active).
  db.prepare(`UPDATE listings SET status = 'sold' WHERE id = ? AND status = 'active'`).run(tx.listing_id);

  // Create transfer record + VASE ledger entry (idempotent on UNIQUE constraint).
  try {
    db.prepare('INSERT INTO transfers (transaction_id, status) VALUES (?, ?)').run(tx.id, 'awaiting_seller');
  } catch { /* already exists */ }
  db.prepare('INSERT INTO vase_ledger (transaction_id, amount_cents) VALUES (?, ?)').run(tx.id, tx.vase_cents);

  // Fetch full row for emails.
  const row = db.prepare(`
    SELECT l.section, l.row, l.seat,
           g.opponent, g.date_label, g.time_label, g.venue, g.is_home, g.is_neutral,
           sellers.email AS seller_email
    FROM listings l
    JOIN games g       ON g.id = l.game_id
    JOIN users sellers ON sellers.id = l.seller_id
    WHERE l.id = ?
  `).get(tx.listing_id);

  const prefix = row.is_home || row.is_neutral ? 'vs' : '@';
  const matchup = `Villanova ${prefix} ${row.opponent}`;
  const seatLine = `Section ${row.section}${row.row ? ' · Row ' + row.row : ''}${row.seat ? ' · Seat ' + row.seat : ''}`;
  const saleUrl = `${PUBLIC_URL}/?sale=${tx.id}`;

  // Buyer.
  await sendEmail({
    to: tx.buyer_email,
    subject: `You got tickets — ${matchup}`,
    html: wrap(`
      <h2 style="font-size:22px;margin:0 0 10px 0;font-weight:600">Tickets confirmed.</h2>
      <p style="font-size:15px;line-height:1.6"><strong>${matchup}</strong></p>
      <p style="font-size:14px;color:#5C6478;margin:4px 0">${row.date_label} · ${row.time_label} · ${row.venue}</p>
      <p style="font-size:14px;color:#5C6478;margin:4px 0">${seatLine}</p>
      <p style="font-size:15px;line-height:1.6;margin-top:20px">Your seller will initiate the Apple Wallet / Ticketmaster transfer to this email shortly. Watch for the Ticketmaster transfer notice.</p>
      <p style="font-size:14px;color:#0F1F47;background:#F1ECDF;padding:14px;border-radius:8px;margin-top:18px">
        <strong>$${(tx.vase_cents/100).toFixed(2)} of this purchase has been routed to the VASE Fund.</strong> Thank you for funding the next banner.
      </p>
      <p style="font-size:12px;color:#5C6478;margin-top:18px">Status / dispute: <a href="${saleUrl}" style="color:#0F1F47">${saleUrl}</a></p>
    `),
  }).catch(e => console.error('[email buyer]', e));

  // Seller.
  await sendEmail({
    to: row.seller_email,
    subject: `Your listing sold — ${matchup}`,
    html: wrap(`
      <h2 style="font-size:22px;margin:0 0 10px 0;font-weight:600">Your listing sold.</h2>
      <p style="font-size:15px;line-height:1.6"><strong>${matchup}</strong> — ${seatLine}</p>
      <p style="font-size:14px;line-height:1.7;margin-top:14px">
        <strong>Buyer email:</strong> ${tx.buyer_email}<br/>
        <strong>Your payout:</strong> $${(tx.ticket_cents/100).toFixed(2)} (paid via Stripe in 2–7 business days)
      </p>
      <p style="font-size:14px;line-height:1.7;margin-top:14px">Please initiate the Ticketmaster transfer to the buyer's email within 24 hours.</p>
      <p style="margin:22px 0"><a href="${saleUrl}" style="display:inline-block;background:#0F1F47;color:#FBF8F1;padding:12px 20px;border-radius:8px;font-weight:600;text-decoration:none">Mark transfer sent →</a></p>
    `),
  }).catch(e => console.error('[email seller]', e));
}

/* =====================================================================
   2. Middleware (after webhook).
   ===================================================================== */
app.use(cookieParser());
app.use(express.json());
app.use(attachUser);

/* =====================================================================
   3. AUTH
   ===================================================================== */
app.post('/api/auth/request', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !/.+@.+\..+/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
    await requestMagicLink(email, PUBLIC_URL);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/request]', e);
    res.status(500).json({ error: 'send_failed' });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const user = verifyMagicToken(token);
  if (!user) return res.redirect('/?auth=expired');
  const session = createSession(user.id);
  res.cookie('nne_session', session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: PUBLIC_URL.startsWith('https'),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
  res.redirect('/?auth=ok');
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      displayName: req.user.display_name,
      classYear: req.user.class_year,
      city: req.user.city,
      stripeAccountId: req.user.stripe_account_id || null,
      chargesEnabled: !!req.user.charges_enabled,
      payoutsEnabled: !!req.user.payouts_enabled,
    },
  });
});

app.patch('/api/auth/me', requireAuth, (req, res) => {
  const { displayName, classYear, city } = req.body || {};
  db.prepare(`UPDATE users SET display_name = ?, class_year = ?, city = ? WHERE id = ?`)
    .run((displayName || '').trim() || null, (classYear || '').trim() || null, (city || '').trim() || null, req.user.id);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(req.cookies?.nne_session);
  res.clearCookie('nne_session', { path: '/' });
  res.json({ ok: true });
});

/* =====================================================================
   4. GAMES
   ===================================================================== */
app.get('/api/games', (_req, res) => {
  const games = db.prepare(`SELECT * FROM games ORDER BY date_iso ASC`).all();
  res.json({ games });
});

/* =====================================================================
   5. LISTINGS
   ===================================================================== */
app.get('/api/listings', (req, res) => {
  const sport = req.query.sport;
  const home  = req.query.home === '1';
  let sql = `
    SELECT l.id, l.game_id, l.section, l.row, l.seat, l.qty,
           l.face_cents, l.ask_cents, l.note,
           g.sport, g.sport_label, g.opponent, g.is_home, g.is_neutral,
           g.date_label, g.date_iso, g.time_label, g.venue, g.note AS game_note,
           users.display_name AS seller_name, users.class_year AS seller_class
    FROM listings l
    JOIN games g ON g.id = l.game_id
    JOIN users   ON users.id = l.seller_id
    WHERE l.status = 'active'
  `;
  const args = [];
  if (sport === 'mbb' || sport === 'wbb') { sql += ' AND g.sport = ?'; args.push(sport); }
  if (home) sql += ' AND g.is_home = 1';
  sql += ' ORDER BY g.date_iso ASC, l.ask_cents ASC';
  res.json({ listings: db.prepare(sql).all(...args) });
});

app.get('/api/listings/mine', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, g.opponent, g.date_label, g.time_label, g.venue, g.is_home, g.is_neutral, g.sport_label
    FROM listings l
    JOIN games g ON g.id = l.game_id
    WHERE l.seller_id = ?
    ORDER BY l.created_at DESC
  `).all(req.user.id);
  res.json({ listings: rows });
});

app.post('/api/listings', requireAuth, (req, res) => {
  try {
    const { gameId, section, row, seat, qty, faceCents, askCents, note } = req.body || {};
    if (!gameId || !section || !askCents) return res.status(400).json({ error: 'missing_fields' });
    const game = db.prepare('SELECT id FROM games WHERE id = ?').get(gameId);
    if (!game) return res.status(404).json({ error: 'unknown_game' });
    const ask  = Math.max(100, Math.round(Number(askCents)));    // min $1
    const face = Math.max(0,   Math.round(Number(faceCents) || 0));
    const result = db.prepare(`
      INSERT INTO listings (game_id, seller_id, section, row, seat, qty, face_cents, ask_cents, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      gameId, req.user.id,
      String(section).trim(),
      (row || '').toString().trim() || null,
      (seat || '').toString().trim() || null,
      Math.max(1, parseInt(qty || 1, 10)),
      face, ask,
      (note || '').toString().trim() || null
    );
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    console.error('[listings/create]', e);
    res.status(500).json({ error: 'create_failed' });
  }
});

app.delete('/api/listings/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  if (l.seller_id !== req.user.id) return res.status(403).json({ error: 'not_owner' });
  if (l.status !== 'active') return res.status(400).json({ error: 'cannot_cancel' });
  db.prepare(`UPDATE listings SET status = 'cancelled' WHERE id = ?`).run(id);
  res.json({ ok: true });
});

/* =====================================================================
   6. STRIPE CONNECT — seller onboarding
   ===================================================================== */
app.post('/api/connect/onboard', requireAuth, async (req, res) => {
  try {
    let accountId = req.user.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: req.user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: 'individual',
        metadata: { source: 'nova-nation-exchange', user_id: String(req.user.id) },
      });
      accountId = account.id;
      db.prepare('UPDATE users SET stripe_account_id = ? WHERE id = ?').run(accountId, req.user.id);
    }
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${PUBLIC_URL}/?connect=refresh`,
      return_url:  `${PUBLIC_URL}/?connect=return`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) {
    console.error('[connect/onboard]', e);
    res.status(500).json({ error: 'onboard_failed' });
  }
});

app.get('/api/connect/status', requireAuth, async (req, res) => {
  if (!req.user.stripe_account_id) return res.json({ connected: false });
  try {
    const acct = await stripe.accounts.retrieve(req.user.stripe_account_id);
    db.prepare('UPDATE users SET charges_enabled = ?, payouts_enabled = ? WHERE id = ?')
      .run(acct.charges_enabled ? 1 : 0, acct.payouts_enabled ? 1 : 0, req.user.id);
    res.json({
      connected: true,
      accountId: acct.id,
      chargesEnabled: acct.charges_enabled,
      payoutsEnabled: acct.payouts_enabled,
      detailsSubmitted: acct.details_submitted,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =====================================================================
   7. CHECKOUT
   ===================================================================== */
app.get('/api/listings/:id/preview', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const l = db.prepare(`
    SELECT l.*, g.opponent, g.date_label, g.time_label, g.venue, g.is_home, g.is_neutral, g.sport_label
    FROM listings l
    JOIN games g ON g.id = l.game_id
    WHERE l.id = ?
  `).get(id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  res.json({ listing: l, breakdown: breakdown(l.ask_cents) });
});

app.post('/api/checkout/create-session', async (req, res) => {
  try {
    const { listingId, buyerEmail, roundupCents } = req.body || {};
    if (!buyerEmail || !/.+@.+\..+/.test(buyerEmail)) return res.status(400).json({ error: 'email_required' });

    const l = db.prepare(`
      SELECT l.*, users.stripe_account_id, users.charges_enabled,
             g.opponent, g.is_home, g.is_neutral, g.date_label, g.time_label, g.venue, g.sport_label
      FROM listings l
      JOIN users ON users.id = l.seller_id
      JOIN games g ON g.id = l.game_id
      WHERE l.id = ?
    `).get(parseInt(listingId, 10));
    if (!l || l.status !== 'active') return res.status(404).json({ error: 'unavailable' });

    const b = breakdown(l.ask_cents);
    // Round-up donation must be 0–499 cents (next-$5 roll).
    const ru = Math.max(0, Math.min(499, Math.round(Number(roundupCents) || 0)));

    // Round-up rides on top of the base ticket bundle, all credited to VASE.
    const txVase   = b.vase    + ru;
    const txTotal  = b.total   + ru;
    const txAppFee = b.app_fee + ru;

    const txr = db.prepare(`
      INSERT INTO transactions
        (listing_id, buyer_email, ticket_cents, fee_cents, proc_cents, vase_cents, total_cents, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(l.id, buyerEmail, b.ticket, b.fee, b.proc, txVase, txTotal);
    const txId = txr.lastInsertRowid;

    const prefix = l.is_home || l.is_neutral ? 'vs' : '@';
    const line_items = [{
      price_data: {
        currency: 'usd',
        unit_amount: b.total,
        product_data: {
          name: `Villanova ${prefix} ${l.opponent} · Sec ${l.section}`,
          description: `${l.date_label} · ${l.time_label} · ${l.venue}. Includes 10% VASE Fund contribution.`,
        },
      },
      quantity: 1,
    }];
    if (ru > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          unit_amount: ru,
          product_data: {
            name: 'VASE Fund · round-up donation',
            description: '100% of this round-up routed to Villanova Athletics Strategic Excellence.',
          },
        },
        quantity: 1,
      });
    }

    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: buyerEmail,
      line_items,
      success_url: `${PUBLIC_URL}/?checkout=success&tx=${txId}`,
      cancel_url:  `${PUBLIC_URL}/?checkout=cancel&tx=${txId}`,
      metadata: {
        transaction_id: String(txId),
        listing_id:     String(l.id),
        vase_cents:     String(txVase),
        roundup_cents:  String(ru),
      },
    };
    if (l.stripe_account_id && l.charges_enabled) {
      sessionParams.payment_intent_data = {
        application_fee_amount: txAppFee,
        transfer_data: { destination: l.stripe_account_id },
        metadata: { transaction_id: String(txId), vase_cents: String(txVase), roundup_cents: String(ru) },
      };
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    db.prepare('UPDATE transactions SET stripe_session_id = ? WHERE id = ?').run(session.id, txId);
    res.json({ url: session.url, transactionId: txId });
  } catch (e) {
    console.error('[checkout/create-session]', e);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

/* =====================================================================
   8. TRANSFERS
   ===================================================================== */
app.get('/api/sale/:txId', (req, res) => {
  const txId = parseInt(req.params.txId, 10);
  const row = db.prepare(`
    SELECT tx.*, l.section, l.row, l.seat, l.seller_id,
           g.opponent, g.date_label, g.time_label, g.venue, g.is_home, g.is_neutral, g.sport_label,
           tr.id AS transfer_id, tr.status AS transfer_status,
           tr.seller_marked_at, tr.buyer_confirmed_at
    FROM transactions tx
    JOIN listings l ON l.id = tx.listing_id
    JOIN games g    ON g.id = l.game_id
    LEFT JOIN transfers tr ON tr.transaction_id = tx.id
    WHERE tx.id = ?
  `).get(txId);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ sale: row });
});

app.post('/api/transfers/:txId/mark-sent', requireAuth, async (req, res) => {
  const txId = parseInt(req.params.txId, 10);
  const tx = db.prepare(`
    SELECT tx.*, l.seller_id, tr.id AS transfer_id
    FROM transactions tx
    JOIN listings l ON l.id = tx.listing_id
    LEFT JOIN transfers tr ON tr.transaction_id = tx.id
    WHERE tx.id = ?
  `).get(txId);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  if (tx.seller_id !== req.user.id) return res.status(403).json({ error: 'not_seller' });
  if (!tx.transfer_id) return res.status(400).json({ error: 'no_transfer' });
  db.prepare(`UPDATE transfers SET status = 'sent', seller_marked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(tx.transfer_id);
  sendEmail({
    to: tx.buyer_email,
    subject: 'Your Villanova tickets are on the way',
    html: wrap(`
      <h2 style="font-size:22px;margin:0 0 10px 0;font-weight:600">Transfer initiated.</h2>
      <p style="font-size:15px;line-height:1.6">Your seller has initiated the Ticketmaster transfer. Watch your email (and spam) for the Ticketmaster transfer notice. Accept on your iPhone and the tickets will land in Apple Wallet within a minute.</p>
      <p style="margin-top:18px"><a href="${PUBLIC_URL}/?sale=${tx.id}" style="color:#0F1F47">Confirm receipt →</a></p>
    `),
  }).catch(e => console.error('[email mark-sent]', e));
  res.json({ ok: true });
});

app.post('/api/transfers/:txId/confirm', (req, res) => {
  const txId = parseInt(req.params.txId, 10);
  const tx = db.prepare(`
    SELECT tx.*, tr.id AS transfer_id
    FROM transactions tx
    LEFT JOIN transfers tr ON tr.transaction_id = tx.id
    WHERE tx.id = ?
  `).get(txId);
  if (!tx || !tx.transfer_id) return res.status(404).json({ error: 'not_found' });
  // Auth is light here — anyone with the link can confirm receipt. Ties to buyer_email in the email.
  db.prepare(`UPDATE transfers SET status = 'confirmed', buyer_confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(tx.transfer_id);
  res.json({ ok: true });
});

/* =====================================================================
   9. DEAL REDEMPTIONS + LEADERBOARD
   ===================================================================== */
app.post('/api/deals/redeem', requireAuth, (req, res) => {
  const { dealSlug, businessName, neighborhood, code, matchCents } = req.body || {};
  if (!dealSlug || !businessName || !code) return res.status(400).json({ error: 'missing_fields' });
  const match = Math.max(0, Math.round(Number(matchCents) || 0));

  // Cap to one redemption per business per calendar day (UTC) to prevent gaming.
  const today = new Date().toISOString().slice(0, 10);
  const dup = db.prepare(`
    SELECT id FROM redemptions
    WHERE user_id = ? AND deal_slug = ? AND substr(created_at, 1, 10) = ?
  `).get(req.user.id, dealSlug, today);
  if (dup) return res.json({ ok: true, alreadyRedeemed: true });

  db.prepare(`
    INSERT INTO redemptions (user_id, deal_slug, business_name, neighborhood, code, vase_match_cents)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, dealSlug, businessName, neighborhood || null, code, match);
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => {
  const period = (req.query.period || 'month').toLowerCase();
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit || '10', 10)));
  // SQLite date math: filter by created_at within window.
  let dateWhere = '';
  if (period === 'month') {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 1);
    dateWhere = `AND r.created_at >= '${cutoff.toISOString()}'`;
  } else if (period === 'week') {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    dateWhere = `AND r.created_at >= '${cutoff.toISOString()}'`;
  } // 'season' = all-time

  const rows = db.prepare(`
    SELECT
      u.id              AS user_id,
      COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1)) AS display_name,
      u.class_year,
      u.city,
      SUM(r.vase_match_cents) AS matched_cents,
      COUNT(r.id)             AS redemption_count
    FROM redemptions r
    JOIN users u ON u.id = r.user_id
    WHERE 1=1 ${dateWhere}
    GROUP BY u.id
    ORDER BY matched_cents DESC, redemption_count DESC
    LIMIT ?
  `).all(limit);

  // Total VASE matched across all users for the period (the thermometer).
  const total = db.prepare(`
    SELECT COALESCE(SUM(vase_match_cents), 0) AS total, COUNT(*) AS count
    FROM redemptions r
    WHERE 1=1 ${dateWhere}
  `).get();

  // The current user's row (rank + total), if signed in.
  let me = null;
  if (req.user) {
    const allRanked = db.prepare(`
      SELECT user_id, SUM(vase_match_cents) AS matched_cents
      FROM redemptions r
      WHERE 1=1 ${dateWhere}
      GROUP BY user_id
      ORDER BY matched_cents DESC, COUNT(*) DESC
    `).all();
    const idx = allRanked.findIndex(r => r.user_id === req.user.id);
    if (idx >= 0) me = { rank: idx + 1, matchedCents: allRanked[idx].matched_cents };
  }
  res.json({ period, leaders: rows, totals: total, me });
});

/* =====================================================================
   10. HEALTH + STATIC
   ===================================================================== */
app.get('/api/health', (_req, res) => {
  const userCount    = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const gameCount    = db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
  const listingCount = db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE status = 'active'`).get().n;
  res.json({
    ok: true,
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing-keys',
    email:  process.env.RESEND_API_KEY    ? 'configured' : 'console-fallback',
    db: { users: userCount, games: gameCount, activeListings: listingCount },
  });
});

app.use(express.static(ROOT));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));

app.listen(PORT, () => {
  console.log(`Nova Nation Exchange server running on ${PUBLIC_URL}`);
});
