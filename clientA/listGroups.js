require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: { headless: true }
});

client.on('ready', async () => {
  console.log('✅ WhatsApp client is ready—listing your groups:\n');
  const chats = await client.getChats();

  // Filter only group chats, then print name and ID
  chats
    .filter(chat => chat.isGroup)
    .forEach(group => {
      console.log(`• ${group.name} → ${group.id._serialized}`);
    });

  process.exit(0);  // we’re done
});

client.initialize();
