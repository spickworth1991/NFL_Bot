// register.js
import 'dotenv/config';
import { REST, Routes } from '@discordjs/rest';
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

const { DISCORD_TOKEN, APPLICATION_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !APPLICATION_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / APPLICATION_ID / GUILD_ID in .env');
  process.exit(1);
}

// Shared choices for the /nfl "source" option
const SOURCE_CHOICES = [
  ['rotowire', 'rotowire'],
  ['cbs', 'cbs'],
  ['espn', 'espn'],
  ['all (default)', 'all'],
];

const commands = [
  new SlashCommandBuilder()
    .setName('nfl')
    .setDescription('Latest NFL headlines from default sources (or a specific source)')
    .addIntegerOption(o =>
      o.setName('count')
       .setDescription('How many (1–5)')
       .setMinValue(1).setMaxValue(5)
    )
    .addStringOption(o =>
      o.setName('source')
       .setDescription('Choose a specific source')
       .addChoices(...SOURCE_CHOICES.map(([name, value]) => ({ name, value })))
    ),

  // Admin-only by default (ManageGuild required)
  new SlashCommandBuilder()
    .setName('subscribe')
    .setDescription('Subscribe this channel to default NFL headlines')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('unsubscribe')
    .setDescription('Unsubscribe this channel from NFL headlines')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('team')
    .setDescription('Latest headlines for a specific NFL team')
    .addStringOption(o =>
      o.setName('team')
       .setDescription('Team name (autocomplete)')
       .setRequired(true)
       .setAutocomplete(true)
    )
    .addIntegerOption(o =>
      o.setName('count')
       .setDescription('How many (1–5)')
       .setMinValue(1).setMaxValue(5)
    ),

  // New: quick fantasy + injuries
  new SlashCommandBuilder()
    .setName('fantasynews')
    .setDescription('Latest NFL fantasy player news (RotoWire)')
    .addIntegerOption(o =>
      o.setName('count').setDescription('How many (1–5)').setMinValue(1).setMaxValue(5)
    ),

  new SlashCommandBuilder()
    .setName('injuries')
    .setDescription('Latest NFL injury headlines (filtered)')
    .addIntegerOption(o =>
      o.setName('count').setDescription('How many (1–5)').setMinValue(1).setMaxValue(5)
    ),

  // New: bot health/status
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Bot heartbeat, next tick ETA, feed counts, last error'),
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID),
  { body: commands },
);

console.log('✅ Guild commands registered.');
