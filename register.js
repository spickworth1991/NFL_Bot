// register.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

// fail fast with a clear message
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Missing one of: DISCORD_TOKEN, CLIENT_ID, GUILD_ID in .env');
  console.log({
    hasToken: !!DISCORD_TOKEN,
    CLIENT_ID,
    GUILD_ID,
  });
  process.exit(1);
}

// commands (team uses autocomplete; no "choices" to avoid the 25-choice cap)
const commands = [
  new SlashCommandBuilder()
    .setName('nfl')
    .setDescription('Latest NFL headlines from default sources')
    .addIntegerOption(o =>
      o.setName('count').setDescription('How many (1–5)').setMinValue(1).setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe this channel to default NFL headlines'),

  new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('Unsubscribe this channel from NFL headlines'),

  new SlashCommandBuilder()
    .setName('team')
    .setDescription('Latest headlines for a specific NFL team')
    .addStringOption(o =>
      o.setName('team').setDescription('Team name (autocomplete)').setRequired(true).setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName('count').setDescription('How many (1–5)').setMinValue(1).setMaxValue(5)
    ),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
  { body: commands }
);

console.log('✅ Guild commands registered.');
