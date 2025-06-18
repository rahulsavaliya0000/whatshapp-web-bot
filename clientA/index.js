
require('dotenv').config();

console.log(`this is my new branch but new one `);
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');


const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENAI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });


const OWNER_NUMBER = '916356545412@c.us'; 


let queryCounter = 0;
let activeQueries = {}; 
let recentQueries = {}; 


const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}


const counterPath = path.join(__dirname, 'query_counter.json');
try {
  const data = JSON.parse(fs.readFileSync(counterPath, 'utf-8'));
  queryCounter = data.counter || 0;
  activeQueries = data.activeQueries || {};
  recentQueries = data.recentQueries || {};
  console.log('✅ Query state loaded.');
} catch (error) {
  console.log('⚠️ No query state file found, starting fresh.');
}

function saveQueryState() {
  try {
    fs.writeFileSync(counterPath, JSON.stringify({
      counter: queryCounter,
      activeQueries: activeQueries,
      recentQueries: recentQueries
    }, null, 2));
  } catch (error) {
    console.error('❌ Error saving query state:', error);
  }
}


let groups = {};
const groupsPath = path.join(__dirname, 'groups.json');
try {
  groups = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
  console.log('✅ Groups loaded:', Object.keys(groups));
} catch (error) {
    groups = {"LAPTOP": [], "MONITOR": [], "PENDRIVE": [], "MOUSE": []};
  console.log('⚠️ groups.json not found. Created a template. Please add your group IDs.');
  fs.writeFileSync(groupsPath, JSON.stringify(groups, null, 2));
}


let sellerConversations = {};


const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session', clientId: "product-inquiry-bot-v3" }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});



client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('📱 Scan QR to log in.'); });
client.on('ready', () => console.log('✅ WhatsApp Bot is ready and listening!'));
client.on('auth_failure', msg => console.error('❌ Authentication failed:', msg));
client.on('disconnected', reason => console.log('🔌 Client was logged out:', reason));

client.on('message', async msg => {
  try {
    if (!msg.from || msg.from === 'status@broadcast') return;
   
    const from = msg.from;
    const body = msg.body ? msg.body.trim() : '';
    const hasMedia = msg.hasMedia;

    console.log(`📨 Message from ${from}: hasMedia=${hasMedia}, body="${body}"`);

    
    if (from === OWNER_NUMBER) {
      await handleOwnerMessage(msg, body);
    }
    
    else if (!from.endsWith('@g.us')) {
      await handleSellerMessage(msg, from, body, hasMedia);
    }
  } catch (error) {
    console.error('❌ Unhandled error in message handler:', error);
  }
});


async function handleOwnerMessage(msg, body) {
  
  if (body.toLowerCase() === 'restart') {
    try {
      
      queryCounter = 0;
      activeQueries = {};
      recentQueries = {};
      sellerConversations = {};
      
      
      saveQueryState();
      
      console.log('🔄 SYSTEM RESTART: All data reset by owner');
      await msg.reply('🔄 **SYSTEM RESTARTED**\n\n✅ Query counter reset to 0\n✅ All active queries cleared\n✅ Recent queries cleared\n✅ Seller conversations reset\n\n🚀 Ready for fresh start!');
      return;
    } catch (error) {
      console.error('❌ Error during restart:', error);
      await msg.reply('❌ Error during restart. Please try again.');
      return;
    }
  }

  
  if (body.toLowerCase().startsWith('close')) {
    const queryNum = body.split(' ')[1];
    if (queryNum && activeQueries[queryNum]) {
      activeQueries[queryNum].status = 'closed';
      saveQueryState();
      await msg.reply(`✅ Query #${queryNum} (${activeQueries[queryNum].keyword}) has been closed.`);
      console.log(`🔒 Query #${queryNum} closed by owner.`);
    } else {
      await msg.reply(`❌ Invalid command. Use "close <number>" (e.g., "close 12").`);
    }
    return;
  }
 
  
  const keyword = Object.keys(groups).find(k => body.toUpperCase().includes(k.toUpperCase()));
  if (!keyword) {
    await msg.reply(`🤖 No valid product keyword found in "${body}". Available: ${Object.keys(groups).join(', ')}`);
    return;
  }

  queryCounter++;
  const qNum = queryCounter;
  
  
  activeQueries[qNum] = { 
    keyword, 
    timestamp: new Date().toISOString(), 
    status: 'active', 
    responses: [],
    originalQuery: body 
  };
  
  
  recentQueries[keyword] = {
    text: body,
    timestamp: new Date().toISOString(),
    queryNumber: qNum
  };
  
  saveQueryState();
  console.log(`🚀 New Query #${qNum} for "${keyword}" from owner: "${body}"`);

  
  const inquiryText = `I am looking for : ${body} if you have Reply Privately`;
  const groupIds = groups[keyword] || [];
  
  if (groupIds.length === 0) {
    await msg.reply(`❌ No groups configured for "${keyword}". Please add group IDs to groups.json`);
    return;
  }

  let successCount = 0;
  for (const gid of groupIds) {
    console.log(`📤 Attempting to send to group: ${gid}`);
    if (await safeSendMessage(gid, inquiryText)) {
      successCount++;
      console.log(`✅ Successfully sent to group: ${gid}`);
    } else {
      console.log(`❌ Failed to send to group: ${gid}`);
    }
  }

  await msg.reply(`👍 Query #${qNum} for "${keyword}" sent to ${successCount}/${groupIds.length} groups.`);
  
  if (successCount === 0) {
    await msg.reply(`⚠️ Warning: Message was not sent to any groups. Please check your group IDs in groups.json`);
  }
}


async function handleSellerMessage(msg, from, body, hasMedia) {
  let conversation = sellerConversations[from];

  
  if (!conversation || conversation.status === 'completed' || conversation.status === 'expired') {
    
    const detectedQuery = detectQueryFromMessage(body);
    
    
    sellerConversations[from] = {
      status: 'collecting_response',
      startTime: new Date(),
      images: [],
      textResponse: '',
      linkedQuery: detectedQuery 
    };
    
    conversation = sellerConversations[from];

    
    let instructions = `Thanks for replying privately from the group!\n\n`;
    
    if (detectedQuery) {
      instructions += `📋 *Query you're responding to:*\n"${detectedQuery.text}"\n\n`;
    }
    
    instructions += `Please send:\n\n• 💰 Price details\n• ⭐ Quality information\n• 🚚 Delivery time\n• 🏢 Company name\n• 📸 Product photos (if available)\n\n*You can send text and images in any order. When you're done, type "FINISHED" to submit everything.*`;
    
    await safeSendMessage(from, instructions);
    
    
    return;
  }

  
  switch (conversation.status) {
    case 'collecting_response':
      await handleResponseCollection(msg, from, body, hasMedia, conversation);
      break;
     
    case 'waiting_for_completion':
      await handleCompletionConfirmation(msg, from, body, conversation);
      break;
  }
}


function detectQueryFromMessage(messageBody) {
  
  for (const keyword of Object.keys(recentQueries)) {
    if (messageBody && messageBody.toUpperCase().includes(keyword.toUpperCase())) {
      return recentQueries[keyword];
    }
  }
  
  
  const recentKeywords = Object.keys(recentQueries);
  if (recentKeywords.length > 0) {
    const mostRecentKeyword = recentKeywords.reduce((latest, current) => {
      return new Date(recentQueries[current].timestamp) > new Date(recentQueries[latest].timestamp) ? current : latest;
    });
    return recentQueries[mostRecentKeyword];
  }
  
  return null;
}


async function handleResponseCollection(msg, from, body, hasMedia, conversation) {
  console.log(`📝 Collecting response from ${from}: hasMedia=${hasMedia}, body="${body}"`);
 
  
  if (hasMedia) {
    try {
      console.log('📥 Processing incoming media...');
      const media = await msg.downloadMedia();
     
      if (media) {
        conversation.images.push({
          media: media,
          timestamp: new Date().toISOString(),
          caption: body || ''
        });
        console.log(`✅ Image saved. Total images: ${conversation.images.length}`);
        await msg.reply(`📸 Image received! (${conversation.images.length} total)\n\nSend more details/images or type "FINISHED" when done.`);
      } else {
        console.log('❌ Failed to download media');
        await msg.reply('❌ Failed to receive image. Please try again.');
      }
    } catch (error) {
      console.error('❌ Error processing media:', error);
      await msg.reply('❌ Error processing image. Please try again.');
    }
    return;
  }
 
  
  if (body && body.toLowerCase() !== 'finished') {
    conversation.textResponse += (conversation.textResponse ? '\n\n' : '') + body;
    console.log(`✅ Text added. Current response length: ${conversation.textResponse.length}`);
    await msg.reply(`✅ Information received!\n\nSend more details/images or type "FINISHED" when done.`);
    return;
  }
 
  
  if (body && body.toLowerCase() === 'finished') {
    if (conversation.textResponse || conversation.images.length > 0) {
      conversation.status = 'waiting_for_completion';
      const summary = `📋 *SUMMARY OF YOUR RESPONSE:*\n\n📝 *Text Details:* ${conversation.textResponse ? 'Yes' : 'None'}\n📸 *Images:* ${conversation.images.length} photo(s)\n\nType "CONFIRM" to send this to the buyer, or "CANCEL" to start over.`;
      await safeSendMessage(from, summary);
    } else {
      await msg.reply('❌ Please provide some information (text or images) before finishing.');
    }
  }
}


async function handleCompletionConfirmation(msg, from, body, conversation) {
  if (body.toLowerCase() === 'confirm') {
    await processAndForwardResponse(from, conversation);
  } else if (body.toLowerCase() === 'cancel') {
    
    conversation.status = 'collecting_response';
    conversation.textResponse = '';
    conversation.images = [];
    await safeSendMessage(from, '🔄 Response cleared. Please provide your details again.\n\nSend text and images, then type "FINISHED" when done.');
  } else {
    await safeSendMessage(from, 'Please type "CONFIRM" to send your response or "CANCEL" to start over.');
  }
}


async function processAndForwardResponse(from, conversation) {
  const sellerPhone = from.replace('@c.us', '');
  
  console.log(`📤 Processing final response from ${sellerPhone}`);
  console.log(`📊 Response summary: ${conversation.images.length} images, ${conversation.textResponse.length} chars text`);
 
  try {
    
    if (conversation.images.length > 0) {
      console.log(`📸 Forwarding ${conversation.images.length} images to owner...`);
     
      for (let i = 0; i < conversation.images.length; i++) {
        const imageData = conversation.images[i];
        try {
          
          const mediaMessage = new MessageMedia(imageData.media.mimetype, imageData.media.data, `image_${i + 1}.jpg`);
         
          
          let caption = `📸 Image ${i + 1}/${conversation.images.length} from ‪+${sellerPhone}‬\n`;
          
          if (conversation.linkedQuery) {
            caption += `📋 Reply to: "${conversation.linkedQuery.text}"\n`;
          }
          
          caption += `(seller replied privately from group)`;
          
          if (imageData.caption) {
            caption += `\n📝 Caption: ${imageData.caption}`;
          }
         
          await client.sendMessage(OWNER_NUMBER, mediaMessage, { caption });
         
          console.log(`✅ Image ${i + 1}/${conversation.images.length} sent to owner`);
         
          
          await new Promise(resolve => setTimeout(resolve, 1500));
         
        } catch (imageError) {
          console.error(`❌ Failed to send image ${i + 1}:`, imageError);
        }
      }
    }
   
    
    let processedText = conversation.textResponse || 'No text details provided';
    if (conversation.textResponse) {
      try {
        const extractPrompt = `Extract and format the following seller information in clean, simple format without excessive asterisks or bold formatting:\n\n"${conversation.textResponse}"\n\nFormat it with simple sections like:\nPrice: [amount]\nQuality: [description]\nDelivery: [time]\nCompany: [name]\n\nKeep it clean and readable.`;
        const result = await model.generateContent(extractPrompt);
        processedText = result.response.text().trim();
      } catch (aiError) {
        console.error('⚠️ AI processing failed, using raw text:', aiError.message);
      }
    }
   
    
    let summaryMessage = `SELLER RESPONSE\n\nFrom: +${sellerPhone}\n\n`;
    
    
    if (conversation.linkedQuery) {
      summaryMessage += `📋 *Original Query:*\n"${conversation.linkedQuery.text}"\n\n`;
    }
    
    summaryMessage += `Product Information\n\n${processedText}\n\n---\nOriginal Message:\n"${conversation.textResponse || 'No text provided'}"\n\nImages: ${conversation.images.length} photo(s)\nTimestamp: ${new Date().toLocaleString()}`;
   
    await safeSendMessage(OWNER_NUMBER, summaryMessage);
   
    
    await safeSendMessage(from, '✅ Perfect! Your response has been sent to the buyer. Thank you for your submission!');
    conversation.status = 'completed';
   
    console.log(`🎉 Successfully processed response from ${sellerPhone} - ${conversation.images.length} images + text forwarded to owner`);
   
  } catch (error) {
    console.error('❌ Error in processAndForwardResponse:', error);
    await safeSendMessage(from, '❌ Sorry, there was an error processing your response. Please try again.');
  }
}


async function safeSendMessage(to, text, options = {}) {
  try {
    console.log(`🔄 Attempting to send message to: ${to}`);
    await client.sendMessage(to, text, options);
    console.log(`✅ Message sent successfully to: ${to}`);
    return true;
  } catch (e) {
    console.error(`❌ Failed to send message to ${to}:`, e.message);
    console.error(`❌ Full error:`, e);
    return false;
  }
}


setInterval(() => {
  const now = Date.now();
  const EXPIRE_TIME = 2 * 60 * 60 * 1000; 
  const QUERY_EXPIRE_TIME = 24 * 60 * 60 * 1000; 
 
  
  for (const from in sellerConversations) {
    const conv = sellerConversations[from];
    if (conv.status !== 'completed' && now - new Date(conv.startTime).getTime() > EXPIRE_TIME) {
      console.log(`🧹 Cleaning up expired conversation from ${from}`);
      sellerConversations[from].status = 'expired';
    }
  }
  
  
  for (const keyword in recentQueries) {
    if (now - new Date(recentQueries[keyword].timestamp).getTime() > QUERY_EXPIRE_TIME) {
      console.log(`🧹 Cleaning up old query for ${keyword}`);
      delete recentQueries[keyword];
    }
  }
  
  saveQueryState();
}, 15 * 60 * 1000); 


process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  saveQueryState();
});

const cleanup = async (signal) => {
  console.log(`\n🔄 Received ${signal}. Saving state and shutting down...`);
  saveQueryState();
  if (client) {
    try {
      await client.destroy();
    } catch (error) {
      console.error('❌ Error during client shutdown:', error.message);
    }
  }
  console.log('✅ Shutdown complete.');
  process.exit(0);
};

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

process.on('uncaughtException', (err, origin) => {
  console.error(`💥 Uncaught Exception at: ${origin}`, err);
  saveQueryState();
  process.exit(1);
});


console.log('🚀 Initializing Bot v3 with Enhanced Query Display System...');
client.initialize();
