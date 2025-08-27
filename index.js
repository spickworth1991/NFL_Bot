import 'dotenv/config';
import { MessageFlags } from 'discord.js';
import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import RSSParser from 'rss-parser';
import Database from 'better-sqlite3';
// health-server.js (add to your bot)

import './health-server.js';




// ===== ENV =====
const {
  DISCORD_TOKEN,
  FEEDS = '',
  POLL_SECONDS = '90',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env (project root).');
  process.exit(1);
}

// ===== GLOBALS / SAFETY =====
process.on('unhandledRejection', (err) => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.on('error', (e) => console.error('CLIENT ERROR:', e));
client.on('shardError', (e) => console.error('SHARD ERROR:', e));

const parser = new RSSParser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BallsvilleBot/1.0',
    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  },
})

const db = new Database('state.db');

// ===== DB =====
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

// ===== FEEDS & HELPERS =====
const defaultFeeds = FEEDS.split(',').map(s => s.trim()).filter(Boolean);

// Known, reliable sources you can request via /nfl source=
const FEED_MAP = {
  espn:     'https://www.espn.com/espn/rss/nfl/news',
  cbs:      'https://www.cbssports.com/rss/headlines/nfl',
  rotowire: 'https://www.rotowire.com/rss/news.php?sport=NFL',
};

async function fetchManyFeeds(urls = []) {
  const all = [];
  for (const u of urls) {
    const f = await fetchFeed(String(u));
    if (Array.isArray(f.items)) all.push(...f.items);
  }
  return all;
}


const INJURY_REGEX = /\b(acl|mcl|achilles|hamstring|concussion|pcl|meniscus|groin|ankle|foot|hand|shoulder|back|neck|hip|rib|oblique|sprain|strain|pup|nfi|doubtful|questionable|out|ir|injur|designated to return|placed on (ir|injured reserve))\b/i;

const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');

async function fetchFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    return feed;
  } catch (e) {
    console.error('Feed error:', url, e.message);
    return { items: [] };
  }
}

function uniqueNewest(items, limit) {
  const seen = new Set();
  const out = [];
  for (const it of items.sort((a,b) =>
    new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0))) {
    const key = (it.link || it.guid || it.id || it.title || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

async function getFresh(feedUrl, limit = 2) {
  const feed = await fetchFeed(feedUrl);
  const items = (feed.items || []).sort((a, b) =>
    new Date(b.pubDate || b.isoDate || 0) - new Date(a.pubDate || a.isoDate || 0)
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

// ===== Buttons row (always appended) =====
function linkButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('ESPN NFL').setStyle(ButtonStyle.Link).setURL('https://www.espn.com/nfl/'),
    new ButtonBuilder().setLabel('CBS NFL').setStyle(ButtonStyle.Link).setURL('https://www.cbssports.com/nfl/'),
    new ButtonBuilder().setLabel('PFT').setStyle(ButtonStyle.Link).setURL('https://www.nbcsports.com/nfl/profootballtalk'),
    new ButtonBuilder().setLabel('Yahoo NFL').setStyle(ButtonStyle.Link).setURL('https://sports.yahoo.com/nfl/'),
    new ButtonBuilder().setLabel('FOX NFL').setStyle(ButtonStyle.Link).setURL('https://www.foxsports.com/nfl')
  );
}
function linkButtonsRow2() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Guardian NFL').setStyle(ButtonStyle.Link).setURL('https://www.theguardian.com/sport/nfl'),
    new ButtonBuilder().setLabel('PFF').setStyle(ButtonStyle.Link).setURL('https://www.pff.com/news'),
    new ButtonBuilder().setLabel('RotoWire NFL').setStyle(ButtonStyle.Link).setURL('https://www.rotowire.com/football/')
  );
}

// ===== Scheduler / Status =====
let intervalMs = Math.max(20, Number(POLL_SECONDS)) * 1000;
let nextTickAt = null;
let lastError = null;

async function tick() {
  for (const { channel_id } of allSubs()) {
    const channel = await client.channels.fetch(channel_id).catch(() => null);
    if (!channel) continue;

    const rows = feedsFor.all(channel_id);
    const rawFeeds = rows.length ? rows.map(r => r.feed) : defaultFeeds;

    // flatten & coerce
    const flatFeeds = [];
    for (const f of rawFeeds) {
      if (Array.isArray(f)) { flatFeeds.push(...f); continue; }
      if (typeof f === 'string' && f.trim().startsWith('[')) {
        try { const arr = JSON.parse(f); if (Array.isArray(arr)) { flatFeeds.push(...arr); continue; } } catch {}
      }
      if (typeof f === 'string') flatFeeds.push(f);
    }

   for (const url of flatFeeds) {
        const fresh = await getFresh(url, 2);
        for (const n of fresh) {
            const title = (n.title || '').trim();
            const link  = (n.link  || '').trim();
            if (!title || !link) continue;

            const src = url.includes('espn.com') ? 'ESPN'
            : url.includes('cbssports.com') ? 'CBS'
            : url.includes('rotowire.com') ? 'RotoWire'
            : 'Source';

            await channel.send({
            content: `**${title}** — ${link}\n_${src}_`,
            components: [linkButtonsRow(), linkButtonsRow2()],
            });
            await new Promise(r => setTimeout(r, 650));
        }
        }

  }
}

async function runTick() {
  try {
    await tick();
    lastError = null;
  } catch (e) {
    console.error('tick() error:', e);
    lastError = String(e?.stack || e?.message || e);
  } finally {
    nextTickAt = new Date(Date.now() + intervalMs);
  }
}

function etaStr(date) {
  if (!date) return '—';
  const ms = date - Date.now();
  if (ms <= 0) return 'imminent';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return `${m}m ${rs}s`;
}

// ===== TEAM MAPS (autocomplete uses labels; /team expects code) =====
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
// (Keep whatever team feed mapping you’ve been using; shown here with a few examples & safe fallbacks)
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

// ===== READY =====
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  nextTickAt = new Date(Date.now() + intervalMs);
  // Kick off immediately, then interval
  runTick();
  setInterval(runTick, intervalMs);
});

// ===== INTERACTIONS =====
client.on('interactionCreate', async (i) => {
  try {
    // ===== AUTOCOMPLETE for /team =====
    if (i.isAutocomplete()) {
        try {
            const focused = i.options.getFocused()?.toLowerCase() || '';
            const entries = Object.entries(TEAM_LABELS)
            .map(([code, label]) => ({ code, label }))
            .filter(x => x.label.toLowerCase().includes(focused) || x.code.toLowerCase().includes(focused))
            .slice(0, 25);

            // respond once, quickly
            await i.respond(entries.map(e => ({ name: e.label, value: e.code })));
        } catch (err) {
            // If the UI moved on, don’t crash the bot.
            if (err?.code !== 10062 && err?.code !== 40060) console.error('AUTO ERR:', err);
        }
        return;
        }



    // ===== /nfl =====
    if (i.commandName === 'nfl') {
      await i.deferReply();
      const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
      const sourceKey = (i.options.getString('source') || 'all').toLowerCase();

      let feedUrls = [];
      if (sourceKey === 'all') {
        feedUrls = defaultFeeds.length ? defaultFeeds : Object.values(FEED_MAP);
      } else if (FEED_MAP[sourceKey]) {
        feedUrls = [FEED_MAP[sourceKey]];
      } else {
        // allow user to pass a literal URL in future; for now ignore unknown
        feedUrls = defaultFeeds.length ? defaultFeeds : Object.values(FEED_MAP);
      }

      const all = [];
      for (const url of feedUrls) {
        const f = await fetchFeed(url);
        all.push(...(f.items || []));
      }
      const out = uniqueNewest(all, count);

      const text = out.length
        ? out.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
        : 'No headlines right now.';

      return i.editReply({
        content: text,
        components: [linkButtonsRow(), linkButtonsRow2()],
      });
    }

    // ===== /subscribe (admin only by default; double-guard here too) =====
    if (i.commandName === 'subscribe') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '⛔ Requires **Manage Server**.', flags: MessageFlags.Ephemeral });
      }
      addSub.run(i.channelId);
      // seed channel with whatever default feeds are configured
      for (const f of (defaultFeeds.length ? defaultFeeds : Object.values(FEED_MAP))) {
        addFeed.run(i.channelId, f);
      }
      return i.reply({
        content: `✅ Subscribed. Polling every ${Math.round(intervalMs/1000)}s.`,
        flags: MessageFlags.Ephemeral 
      });
    }

    // ===== /unsubscribe (admin only by default; double-guard here too) =====
    if (i.commandName === 'unsubscribe') {
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return i.reply({ content: '⛔ Requires **Manage Server**.', flags: MessageFlags.Ephemeral });
      }
      delSub.run(i.channelId);
      return i.reply({ content: '✅ Unsubscribed.', flags: MessageFlags.Ephemeral });
    }

    // ===== /team (on-demand; not in the subscription firehose) =====
    if (i.commandName === 'team') {
        const code = i.options.getString('team', true);
        const sources = TEAM_FEEDS[code];
        const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
        if (!sources) return i.reply({ content: 'Unknown team.', flags: MessageFlags.Ephemeral });

        await i.deferReply();
        const feedList = Array.isArray(sources) ? sources : [sources];
        const items = uniqueNewest(await fetchManyFeeds(feedList), count);
        const text = items.length ? items.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
                                    : 'No team headlines right now.';
        return i.editReply({ content: text, components: [linkButtonsRow(), linkButtonsRow2()] });
        }



    // ===== /fantasynews (RotoWire) =====
    if (i.commandName === 'fantasynews') {
      await i.deferReply();
      const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
      const f = await fetchFeed(FEED_MAP.rotowire);
      const items = uniqueNewest(f.items || [], count);
      const text = items.length
        ? items.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
        : 'No fantasy headlines right now.';
      return i.editReply({
        content: text,
        components: [linkButtonsRow(), linkButtonsRow2()],
      });
    }

    // ===== /injuries (filter from RotoWire feed) =====
    if (i.commandName === 'injuries') {
      await i.deferReply();
      const count = Math.min(5, Math.max(1, i.options.getInteger('count') ?? 3));
      const f = await fetchFeed(FEED_MAP.rotowire);
      const items = (f.items || [])
        .filter(n =>
          INJURY_REGEX.test(n.title || '') ||
          INJURY_REGEX.test(n.contentSnippet || '') ||
          INJURY_REGEX.test(n.content || '')
        );
      const out = uniqueNewest(items, count);
      const text = out.length
        ? out.map(n => `• **${(n.title||'').trim()}** — ${n.link}`).join('\n')
        : 'No injury headlines right now.';
      return i.editReply({
        content: text,
        components: [linkButtonsRow(), linkButtonsRow2()],
      });
    }

    // ===== /status =====
    if (i.commandName === 'status') {
      const subCount = allSubs().length;
      const feedCount = defaultFeeds.length ? defaultFeeds.length : Object.keys(FEED_MAP).length;

      const embed = new EmbedBuilder()
        .setTitle('NFL Bot Status')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Next Tick', value: nextTickAt ? `${nextTickAt.toLocaleString()} (~${etaStr(nextTickAt)})` : '—', inline: false },
          { name: 'Interval', value: `${Math.round(intervalMs/1000)}s`, inline: true },
          { name: 'Subscribed Channels', value: String(subCount), inline: true },
          { name: 'Default Feed Count', value: String(feedCount), inline: true },
          { name: 'Last Error', value: lastError ? `\`\`\`\n${String(lastError).slice(0, 500)}\n\`\`\`` : 'None', inline: false },
        )
        .setTimestamp(new Date());

      return i.reply({
        embeds: [embed],
        components: [linkButtonsRow(), linkButtonsRow2()],
        flags: MessageFlags.Ephemeral // only the admin who runs it sees it
      });
    }
  } catch (err) {
    console.error('INTERACTION ERROR:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content: '⚠️ Something went wrong handling that command.', flags: MessageFlags.Ephemeral });; } catch {}
    }
  }
});

client.login(DISCORD_TOKEN)
  .then(() => console.log('🔌 login() called, awaiting READY…'))
  .catch((err) => console.error('❌ Login failed immediately:', err));
