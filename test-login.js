import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN'); process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => console.log(`✅ READY as ${client.user.tag}`));
client.on('error', console.error);
client.login(process.env.DISCORD_TOKEN).catch(console.error);
