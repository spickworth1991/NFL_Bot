// index.js
import 'dotenv/config';
import crypto from 'node:crypto';
import { Client, GatewayIntentBits } from 'discord.js';
import RSSParser from 'rss-parser';
import Database from 'better-sqlite3';

const { DISCORD_TOKEN, FEEDS = '', POLL_SECONDS = '90' } = process.env;

// ===== CRITICAL GUARDS =====
if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env (project root).');
  process.exit(1);
}
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
// ===== END GUARDS =====

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', (e) => console.error('CLIENT ERROR:', e));
client.on('shardError', (e) => console.error('SHARD ERROR:', e));

const parser = new RSSParser();
const db = new Database('state.db');

// --- DB schema ---
db.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (channel_id TEXT PRIMARY KEY)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS channel_feeds (channel_id TEXT, feed TEXT, PRIMARY KEY (channel_id, feed))`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS seen (feed TEXT, linkhash TEXT, PRIMARY KEY (feed, linkhash))`).run();

const addSub = db.prepare('INSERT OR IGNORE INTO subscriptions (channel_id) VALUES (?)');
const delSub = db.prepare('DELETE FROM subscriptions WHERE channel_id = ?');
const addFeed = db.prepare('INSERT OR IGNORE INTO channel_feeds (channel_id, feed) VALUES (?, ?)');
const allSubs = () => db.prepare('SELECT channel_id FROM subscriptions').all();
const feedsFor = db.prepare('SELECT feed FROM channel_feeds WHERE channel_id = ?');
const hasSeen = db.prepare('SELECT 1 FROM seen WHERE feed = ? AND linkhash = ?');
const markSeen = db.prepare('INSERT OR IGNORE INTO seen (feed, linkhash) VALUES (?, ?)');

// --- Defaults for league-wide headlines (/nfl and subscriptions) ---
const defaultFeeds = FEEDS.split(',').map(s => s.trim()).filter(Boolean);

// --- Team directories (codes, labels, feeds) ---
// SB Nation team blogs expose RSS at /rss/index.xml (e.g., Arrowhead Pride, Pride of Detroit).
// Official fallbacks where available: 49ers + Packers.
const TEAM_LABELS = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers', CHI: 'Chicago Bears',   CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys',    DEN: 'Denver Broncos',  DET: 'Detroit Lions',     GB:  'Green Bay Packers',
  HOU: 'Houston Texans',    IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC:  'Kansas City Chiefs',
  LAC: 'Los Angeles Chargers', LAR: 'Los Angeles Rams', LV:  'Las Vegas Raiders',   MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE:  'New England Patriots', NO: 'New Orleans Saints',  NYG: 'New York Giants',
  NYJ: 'New York Jets',     PHI: 'Philadelphia Eagles',  PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks',
  SF:  'San Francisco 49ers', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans',  WAS: 'Washington Commanders',
};

const TEAM_FEEDS = {
  ARI: ['https://www.revengeofthebirds.com/rss/index.xml'],
  ATL: ['https://www.thefalcoholic.com/rss/index.xml'],
  BAL: ['https://www.baltimorebeatdown.com/rss/index.xml'],
  BUF: ['https://www.buffalorumblings.com/rss/index.xml'],
  CAR: ['https://www.catscratchreader.com/rss/index.xml'],
  CHI: ['https://www.windycitygridiron.com/rss/index.xml'],
  CIN: ['https://www.cincyjungle.com/rss/index.xml'],
  CLE: ['https://www.dawgsbynature.com/rss/index.xml'],
  DAL: ['https://www.bloggingtheboys.com/rss/index.xml'],
  DEN: ['https://www.milehighreport.com/rss/index.xml'],
  DET: ['https://www.prideofdetroit.com/rss/index.xml'],               // Lions (SB Nation) – site exists. :contentReference[oaicite:1]{index=1}
  GB:  ['https://www.acmepackingcompany.com/rss/index.xml', 'https://www.packers.com/rss/news'], // Packers official RSS page. :contentReference[oaicite:2]{index=2}
  HOU: ['https://www.battleredblog.com/rss/index.xml'],
  IND: ['https://www.stampedeblue.com/rss/index.xml'],
  JAX: ['https://www.bigcatcountry.com/rss/index.xml'],
  KC:  ['https://www.arrowheadpride.com/rss/index.xml'],               // Chiefs (SB Nation) – site exists. :contentReference[oaicite:3]{index=3}
  LV:  ['https://www.silverandblackpride.com/rss/index.xml'],
  LAC: ['https://www.boltsfromtheblue.com/rss/index.xml'],
  LAR: ['https://www.turfshowtimes.com/rss/index.xml'],
  MIA: ['https://www.thephinsider.com/rss/index.xml'],
  MIN: ['https://www.dailynorseman.com/rss/index.xml'],
  NE:  ['https://www.patspulpit.com/rss/index.xml'],
  NO:  ['https://www.canalstreetchronicles.com/rss/index.xml'],
  NYG: ['https://www.bigblueview.com/rss/index.xml'],
  NYJ: ['https://www.ganggreennation.com/rss/index.xml'],
  PHI: ['https://www.bleedinggreennation.com/rss/index.xml'],
  PIT: ['https://www.behindthesteelcurtain.com/rss/index.xml'],
  SF:  ['https://www.ninersnation.com/rss/index.xml', 'https://www.49ers.com/rss/news'], // 49ers official RSS page. :contentReference[oaicite:4]{index=4}
  SEA: ['https://www.fieldgulls.com/rss/index.xml'],
  TB:  ['https://www.bucsnation.com/rss/index.xml'],
  TEN: ['https://www.musiccitymiracles.com/rss/index.xml'],
  WAS: ['https://www.hogshaven.com/rss/index.xml'],
};

// --- Utils ---
const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');

async function fetchFeed(url) {
  try {
    return await parser.parseURL(url);
  } catch (e) {
    console.error('Feed error:', url, e.message);
    return { items: [] };
  }
}

async function getFresh(feedUrl, limit = 2) {
  const feed = await fetchFeed(feedUrl);
  const items = (feed.items || []).sort(
    (a, b) => new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0)
  );
  const fresh = [];
  for (const it of items) {
    const link = it.link || it.guid || it.id || '';
    if (!link) continue;
    const key = sha1(link);
    if (!hasSeen.get(feedUrl, key)) {
      fresh.push(it);
      markSeen.run(feedUrl, key);
    }
  }
  return fresh.slice(0, limit);
}

// Aggregate across multiple feeds (used by /team)
async function getFromFeeds(urls = [], limit = 5) {
  const all = [];
  for (const url of urls) {
    const f = await fetchFeed(url);
    all.push(...(f.items || []));
  }
  all.sort((a, b) => new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0));
  const seen = new Set(), out = [];
  for (const it of all) {
    const k = (it.link || it.title || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

// --- background ticker for subscribed channels ---
async function tick() {
  for (const { channel_id } of allSubs()) {
    const channel = await client.channels.fetch(channel_id).catch(() => null);
    if (!channel) continue;
    const rows = feedsFor.all(channel_id);
    const feeds = rows.length ? rows.map(r => r.feed) : defaultFeeds;

    for (const url of feeds) {
      const fresh = await getFresh(url, 2);
      for (const n of fresh) {
        const title = (n.title || '').trim();
        const link  = (n.link  || '').trim();
        if (!title || !link) continue;
        const src = url.includes('espn.com') ? 'ESPN' :
                    url.includes('nbcsports.com') ? 'ProFootballTalk' : 'Source';
        await channel.send(`**${title}** — ${link}\n_${src}_`);
        await new Promise(r => setTimeout(r, 700));
      }
    }
  }
}

// --- lifecycle ---
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  setInterval(tick, Math.max(20, Number(POLL_SECONDS)) * 1000);
});

// --- interactions (autocomplete + commands) ---
client.on('interactionCreate', async (i) => {
  try {
    // Autocomplete for /team team:<value>
    if (i.isAutocomplete() && i.commandName === 'team') {
      const q = (i.options.getFocused() || '').toLowerCase();
      const entries = Object.entries(TEAM_LABELS)
        .map(([code, label]) => ({ code, label }))
        .filter(({ code, label }) => !q || code.toLowerCase().includes(q) || label.toLowerCase().includes(q))
        .slice(0, 25); // Discord hard cap
      return i.respond(entries.map(e => ({ name: e.label, value: e.code })));
    }

    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'nfl') {
      await i.deferReply();
      const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
      const all = [];
      for (const url of defaultFeeds) {
        const f = await fetchFeed(url);
        all.push(...(f.items || []));
      }
      all.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
      const seen = new Set(), out = [];
      for (const it of all) {
        const k = (it.link || it.title || '').trim();
        if (!k || seen.has(k)) continue;
        seen.add(k); out.push(it);
        if (out.length >= count) break;
      }
      return i.editReply(out.length
        ? out.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
        : 'No headlines right now.');
    }

    if (i.commandName === 'subscribe') {
      addSub.run(i.channelId);
      for (const f of defaultFeeds) addFeed.run(i.channelId, f);
      return i.reply({ content: `✅ Subscribed. Polling every ${POLL_SECONDS}s.`, ephemeral: true });
    }

    if (i.commandName === 'unsubscribe') {
      delSub.run(i.channelId);
      return i.reply({ content: '✅ Unsubscribed.', ephemeral: true });
    }

    if (i.commandName === 'team') {
      const code = i.options.getString('team', true); // e.g., 'DET'
      const feeds = TEAM_FEEDS[code];
      const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
      if (!feeds) return i.reply({ content: 'Unknown team code.', ephemeral: true });

      await i.deferReply();
      const posts = await getFromFeeds(feeds, count);
      return i.editReply(posts.length
        ? posts.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
        : 'No team headlines right now.');
    }
  } catch (err) {
    console.error('CLIENT ERROR:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content: 'Something went wrong handling that command.', ephemeral: true }); } catch {}
    }
  }
});

client.login(DISCORD_TOKEN)
  .then(() => console.log('🔌 login() called, awaiting READY…'))
  .catch((err) => console.error('❌ Login failed immediately:', err));
