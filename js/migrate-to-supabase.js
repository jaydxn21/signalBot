// scripts/migrate-to-supabase.js
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from root
dotenv.config({ path: path.join(__dirname, '../.env') });

// ─── CONFIG ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── MAP USERNAME TO USER ID ──────────────────────────────
// You'll need to map your existing bots to a user.
// Option 1: Use skipper2 from your screenshot
const DEFAULT_USERNAME = 'skipper2';

async function getUserId(username) {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('username', username)
    .single();
  
  if (error) {
    console.error(`❌ User "${username}" not found:`, error.message);
    return null;
  }
  
  return data.id;
}

// ─── MIGRATE FUNCTION ──────────────────────────────────────
async function migrate() {
  console.log('🚀 Starting migration to Supabase...');
  
  // 1. Get user ID
  const userId = await getUserId(DEFAULT_USERNAME);
  if (!userId) {
    console.log('❌ Cannot proceed without valid user');
    console.log('💡 Run: node scripts/seed-users.js to create a user first');
    process.exit(1);
  }
  console.log(`✅ Using user: ${DEFAULT_USERNAME} (${userId})`);
  
  // 2. Read local store file
  const storePath = path.join(__dirname, '../data/engine-store.json');
  if (!fs.existsSync(storePath)) {
    console.log('❌ No store file found at:', storePath);
    console.log('💡 Make sure your engine has run at least once to create the store file');
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  console.log(`📦 Found ${data.bots?.length || 0} bots, ${data.trades?.length || 0} trades`);
  
  // ─── MIGRATE BOTS ──────────────────────────────────────
  if (data.bots && data.bots.length > 0) {
    console.log('🤖 Migrating bots...');
    let migrated = 0;
    
    for (const bot of data.bots) {
      try {
        // Check if bot already exists
        const { data: existing } = await supabase
          .from('bots')
          .select('id')
          .eq('id', bot.id)
          .maybeSingle();
        
        if (existing) {
          console.log(`⏭️ Bot ${bot.id} already exists, skipping...`);
          continue;
        }
        
        const { error } = await supabase
          .from('bots')
          .insert({
            id: bot.id || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            user_id: userId,
            name: `Bot ${bot.id}`,
            strategy_config: bot.config || {},
            is_active: bot.isActive || false,
            wins: bot.wins || 0,
            losses: bot.losses || 0,
            pnl: bot.pnl || 0,
            open_signal: bot.openSignal || null,
            account_equity: bot.accountEquity || 10000,
            session_start: bot.sessionStart ? new Date(bot.sessionStart).toISOString() : null,
            last_fired_ms: bot.lastFiredMs || 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        
        if (error) {
          console.error(`❌ Failed to migrate bot ${bot.id}:`, error.message);
        } else {
          migrated++;
          console.log(`✅ Migrated bot ${bot.id}`);
        }
      } catch (error) {
        console.error(`❌ Error migrating bot ${bot.id}:`, error.message);
      }
    }
    console.log(`✅ Migrated ${migrated} bots`);
  }
  
  // ─── MIGRATE TRADES ──────────────────────────────────
  if (data.trades && data.trades.length > 0) {
    console.log(`💰 Migrating ${data.trades.length} trades...`);
    let migrated = 0;
    
    for (const trade of data.trades) {
      try {
        // Find the bot ID for this trade
        const botId = trade.botId || trade.bot_id;
        if (!botId) {
          console.log('⚠️ Trade missing botId, skipping...');
          continue;
        }
        
        const { error } = await supabase
          .from('trades')
          .insert({
            bot_id: botId,
            symbol: trade.symbol || 'Unknown',
            strategy: trade.strategy || 'unknown',
            type: trade.type || 'BUY',
            entry: trade.entry || 0,
            sl: trade.sl || 0,
            tp: trade.tp || 0,
            outcome: trade.outcome || 'PENDING',
            pnl: trade.pnl || 0,
            lot_size: trade.lotSize || 0.01,
            confidence: trade.confidence || {},
            timestamp: trade.time ? new Date(trade.time).toISOString() : new Date().toISOString(),
          });
        
        if (error) {
          console.error(`❌ Failed to migrate trade:`, error.message);
        } else {
          migrated++;
        }
      } catch (error) {
        console.error(`❌ Error migrating trade:`, error.message);
      }
    }
    console.log(`✅ Migrated ${migrated} trades`);
  }
  
  // ─── MIGRATE LOGS ────────────────────────────────────
  if (data.logs && data.logs.length > 0) {
    console.log(`📝 Migrating ${data.logs.length} logs...`);
    let migrated = 0;
    
    // Only migrate last 100 logs to avoid spam
    const logsToMigrate = data.logs.slice(-100);
    
    for (const log of logsToMigrate) {
      try {
        const { error } = await supabase
          .from('logs')
          .insert({
            user_id: userId,
            text: log.text || 'No message',
            type: log.type || 'info',
            time: log.time ? new Date(log.time).toISOString() : new Date().toISOString(),
          });
        
        if (error) {
          console.error(`❌ Failed to migrate log:`, error.message);
        } else {
          migrated++;
        }
      } catch (error) {
        console.error(`❌ Error migrating log:`, error.message);
      }
    }
    console.log(`✅ Migrated ${migrated} logs`);
  }
  
  // ─── VERIFICATION ────────────────────────────────────
  console.log('\n🔍 Verifying migration...');
  
  const { data: botCount } = await supabase
    .from('bots')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  
  const { data: tradeCount } = await supabase
    .from('trades')
    .select('id', { count: 'exact', head: true });
  
  console.log(`📊 Final counts:`);
  console.log(`   Bots: ${botCount || 0}`);
  console.log(`   Trades: ${tradeCount || 0}`);
  
  console.log('\n✅ Migration complete!');
  console.log('💡 You can now run the engine with SUPABASE sync enabled');
}

// ─── RUN MIGRATION ──────────────────────────────────────────
migrate().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});