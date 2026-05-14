/* Seed the games table with the verified 2025-26 schedule.
   Idempotent: rerun any time the schedule changes. */
import './db.js';
import { db } from './db.js';

const GAMES = [
  // === Men's Basketball ===
  { id: 'M01', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'BYU',        is_home: 0, is_neutral: 1, date_label: 'Mon, Nov 3',  date_iso: '2025-11-03T21:30:00-08:00', time_label: '9:30 PM', venue: 'T-Mobile Arena, Las Vegas', note: 'Hall of Fame Series' },
  { id: 'M02', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'Temple',     is_home: 1, is_neutral: 0, date_label: 'Mon, Dec 1',  date_iso: '2025-12-01T19:00:00-05:00', time_label: '7:00 PM', venue: 'Finneran Pavilion',         note: 'Big 5' },
  { id: 'M03', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'Seton Hall', is_home: 0, is_neutral: 0, date_label: 'Tue, Dec 23', date_iso: '2025-12-23T19:00:00-05:00', time_label: '7:00 PM', venue: 'Prudential Center, Newark', note: 'Big East opener' },
  { id: 'M04', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'DePaul',     is_home: 1, is_neutral: 0, date_label: 'Wed, Dec 31', date_iso: '2025-12-31T14:00:00-05:00', time_label: '2:00 PM', venue: 'Finneran Pavilion',         note: null },
  { id: 'M05', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'Creighton',  is_home: 1, is_neutral: 0, date_label: 'Wed, Jan 7',  date_iso: '2026-01-07T19:30:00-05:00', time_label: '7:30 PM', venue: 'Finneran Pavilion',         note: null },
  { id: 'M06', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'Marquette',  is_home: 0, is_neutral: 0, date_label: 'Sat, Jan 10', date_iso: '2026-01-10T14:30:00-06:00', time_label: '2:30 PM', venue: 'Fiserv Forum, Milwaukee',   note: null },
  { id: 'M07', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'UConn',      is_home: 1, is_neutral: 0, date_label: 'Sat, Jan 24', date_iso: '2026-01-24T16:30:00-05:00', time_label: '4:30 PM', venue: 'Finneran Pavilion',         note: null },
  { id: 'M08', sport: 'mbb', sport_label: "Men's Basketball", opponent: 'UConn',      is_home: 0, is_neutral: 0, date_label: 'Sat, Feb 21', date_iso: '2026-02-21T18:00:00-05:00', time_label: '6:00 PM', venue: 'Gampel Pavilion, Storrs',   note: null },

  // === Women's Basketball ===
  { id: 'W01', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'Temple',     is_home: 1, is_neutral: 0, date_label: 'Sat, Nov 22', date_iso: '2025-11-22T14:00:00-05:00', time_label: '2:00 PM',  venue: 'Finneran Pavilion',           note: 'Big 5' },
  { id: 'W02', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'La Salle',   is_home: 0, is_neutral: 0, date_label: 'Tue, Nov 25', date_iso: '2025-11-25T19:00:00-05:00', time_label: '7:00 PM',  venue: 'Tom Gola Arena, Philadelphia', note: 'Big 5' },
  { id: 'W03', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'Creighton',  is_home: 1, is_neutral: 0, date_label: 'Thu, Jan 1',  date_iso: '2026-01-01T12:00:00-05:00', time_label: '12:00 PM', venue: 'Finneran Pavilion',           note: null },
  { id: 'W04', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'UConn',      is_home: 0, is_neutral: 0, date_label: 'Thu, Jan 15', date_iso: '2026-01-15T19:00:00-05:00', time_label: '7:00 PM',  venue: 'Gampel Pavilion, Storrs',     note: null },
  { id: 'W05', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'Butler',     is_home: 1, is_neutral: 0, date_label: 'Sun, Jan 18', date_iso: '2026-01-18T14:00:00-05:00', time_label: '2:00 PM',  venue: 'Finneran Pavilion',           note: null },
  { id: 'W06', sport: 'wbb', sport_label: "Women's Basketball", opponent: "St. John's", is_home: 0, is_neutral: 0, date_label: 'Sat, Jan 24', date_iso: '2026-01-24T14:00:00-05:00', time_label: '2:00 PM',  venue: 'Carnesecca Arena, Queens',    note: null },
  { id: 'W07', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'Providence', is_home: 1, is_neutral: 0, date_label: 'Tue, Jan 27', date_iso: '2026-01-27T19:00:00-05:00', time_label: '7:00 PM',  venue: 'Finneran Pavilion',           note: null },
  { id: 'W08', sport: 'wbb', sport_label: "Women's Basketball", opponent: 'DePaul',     is_home: 1, is_neutral: 0, date_label: 'Sat, Jan 31', date_iso: '2026-01-31T14:00:00-05:00', time_label: '2:00 PM',  venue: 'Finneran Pavilion',           note: null },
];

const upsert = db.prepare(`
  INSERT INTO games (id, sport, sport_label, opponent, is_home, is_neutral, date_label, date_iso, time_label, venue, note)
  VALUES (@id, @sport, @sport_label, @opponent, @is_home, @is_neutral, @date_label, @date_iso, @time_label, @venue, @note)
  ON CONFLICT(id) DO UPDATE SET
    sport       = excluded.sport,
    sport_label = excluded.sport_label,
    opponent    = excluded.opponent,
    is_home     = excluded.is_home,
    is_neutral  = excluded.is_neutral,
    date_label  = excluded.date_label,
    date_iso    = excluded.date_iso,
    time_label  = excluded.time_label,
    venue       = excluded.venue,
    note        = excluded.note
`);

const tx = db.transaction(rows => { for (const r of rows) upsert.run(r); });
tx(GAMES);
console.log(`✓ Seeded ${GAMES.length} games.`);
