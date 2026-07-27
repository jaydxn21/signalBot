#!/bin/bash

# fix-signal-bot.sh - Automatically fixes signal-bot.js with WebSocket support
# Usage: chmod +x fix-signal-bot.sh && ./fix-signal-bot.sh

echo "=========================================="
echo "🔧 NEXUS Signal Bot Fixer"
echo "=========================================="

# Check if file exists
if [ ! -f "signal-bot.js" ]; then
    echo "❌ signal-bot.js not found in current directory"
    exit 1
fi

# Create backup
cp signal-bot.js signal-bot.js.backup
echo "✅ Backup created: signal-bot.js.backup"

# ============================================
# 1. Remove duplicate WebSocket code at the bottom
# ============================================
echo "🔧 Removing duplicate WebSocket code..."

# Find the line where the duplicate WebSocket starts (after the status polling)
sed -i '' '/\/\/ ─────────────────────────────────────────────────────────────$/{
    N
    /\/\/ WEBSOCKET CONNECTION TO RENDER (MT5 Bridge) - reusable helper/d
}' signal-bot.js 2>/dev/null || sed -i '/\/\/ WEBSOCKET CONNECTION TO RENDER (MT5 Bridge) - reusable helper/,/^}$/d' signal-bot.js

# ============================================
# 2. Remove duplicate _engineFor function
# ============================================
echo "🔧 Removing duplicate _engineFor function..."

# Keep the first occurrence, delete subsequent ones
awk '
/^function _engineFor\(botId\) {/ { count++; if (count > 1) { skip=1 } }
skip && /^}$/ { skip=0; next }
skip { next }
{ print }
' signal-bot.js > signal-bot.js.tmp && mv signal-bot.js.tmp signal-bot.js

# ============================================
# 3. Remove duplicate subscribeBot function
# ============================================
echo "🔧 Removing duplicate subscribeBot function..."

awk '
/^function subscribeBot\(bot\) {/ { count++; if (count > 1) { skip=1 } }
skip && /^}$/ { skip=0; next }
skip { next }
{ print }
' signal-bot.js > signal-bot.js.tmp && mv signal-bot.js.tmp signal-bot.js

# ============================================
# 4. Add WebSocket code after imports
# ============================================
echo "🔧 Adding WebSocket connection code..."

# Check if WebSocket code already exists
if grep -q "connectRenderWebSocket" signal-bot.js; then
    echo "   WebSocket code already exists, skipping..."
else
    # Find the line after imports and before SYMBOL_MAP
    sed -i '' '/import { Jump75Strategy }/a\
\
// ─────────────────────────────────────────────────────────────\
// WEBSOCKET CONNECTION TO RENDER (MT5 Bridge)\
// ─────────────────────────────────────────────────────────────\
let renderWS = null;\
let pendingSignals = [];\
\
function connectRenderWebSocket() {\
    if (renderWS && (renderWS.readyState === WebSocket.OPEN || renderWS.readyState === WebSocket.CONNECTING)) {\
        return;\
    }\
\
    console.log("[WS] Connecting to Render WebSocket...");\
    renderWS = new WebSocket("wss://nexus-api-khvt.onrender.com/mt5");\
\
    renderWS.onopen = () => {\
        console.log("✅ WebSocket connected to Render");\
        log("Connected to MT5 bridge", "info");\
        const indicator = document.getElementById("mt5-indicator");\
        if (indicator) indicator.className = "status-dot status-online";\
        SessionState.set({ mt5Connected: true });\
\
        if (pendingSignals.length > 0) {\
            console.log(`📤 Flushing ${pendingSignals.length} pending signals...`);\
            for (const sig of pendingSignals) {\
                try { renderWS.send(JSON.stringify(sig)); } catch(e) { console.warn("[WS] flush failed", e); }\
            }\
            pendingSignals = [];\
        }\
    };\
\
    renderWS.onerror = (err) => {\
        console.error("WebSocket error:", err);\
        const indicator = document.getElementById("mt5-indicator");\
        if (indicator) indicator.className = "status-dot status-offline";\
    };\
\
    renderWS.onclose = () => {\
        console.log("WebSocket disconnected, reconnecting in 5s...");\
        const indicator = document.getElementById("mt5-indicator");\
        if (indicator) indicator.className = "status-dot status-offline";\
        SessionState.set({ mt5Connected: false });\
        setTimeout(connectRenderWebSocket, 5000);\
    };\
\
    renderWS.onmessage = (event) => {\
        try {\
            const data = JSON.parse(event.data);\
            if (data.type === "trade_result") {\
                log(`MT5 Trade Result: ${data.outcome} ${data.symbol} P&L: ${data.pnl}`, "info");\
            }\
        } catch(e) {\
            console.log("WebSocket message:", event.data);\
        }\
    };\
}\
' signal-bot.js
fi

# ============================================
# 5. Add connectRenderWebSocket() call to init()
# ============================================
echo "🔧 Adding WebSocket connection to init()..."

# Check if already added
if grep -q "connectRenderWebSocket();" signal-bot.js; then
    echo "   WebSocket call already exists in init(), skipping..."
else
    sed -i '' '/async function init() {/a\
    // Connect to MT5 bridge WebSocket\
    connectRenderWebSocket();\
' signal-bot.js
fi

# ============================================
# 6. Replace MT5 push with WebSocket version
# ============================================
echo "🔧 Replacing MT5 push with WebSocket version..."

# Create a temporary file with the replacement
cat > /tmp/ws_mt5_push.txt << 'EOF'
    // MT5 Push - WebSocket Version
    if (document.getElementById('auto-mt5')?.checked) {
        const derivDisplay = symbolMap[bot.config.symbol] || SYMBOL_MAP[bot.config.symbol] || bot.config.symbol;
        const mt5Symbol    = MT5_SYMBOL_MAP[bot.config.symbol]
                          || MT5_SYMBOL_MAP[derivDisplay]
                          || derivDisplay;

        const clampedLot = Math.max(0.01, parseFloat((Math.round(lotSize / 0.01) * 0.01).toFixed(2)));

        const signalMsg = {
            action: type.toLowerCase(),
            symbol: mt5Symbol,
            price: parseFloat(bar.close.toFixed(5)),
            sl: parseFloat(sl.toFixed(5)),
            tp: parseFloat(tp.toFixed(5)),
            lotSize: clampedLot,
            label: label,
            timestamp: bar.time * 1000
        };

        if (!renderWS || renderWS.readyState !== WebSocket.OPEN) {
            log('MT5 bridge not connected - queuing signal', 'warn');
            pendingSignals.push(signalMsg);
            connectRenderWebSocket();
        } else {
            renderWS.send(JSON.stringify(signalMsg));
            log(`→ MT5 (WS): ${type} ${mt5Symbol} @ ${bar.close} | lot ${clampedLot}`, 'info');
            document.getElementById('mt5-indicator').className = 'status-dot status-online';
            SessionState.set({ mt5Connected: true });
        }
    }
EOF

# Find and replace the MT5 push section (looks for fetch('/api/signal'))
sed -i '' '/fetch('\/api\/signal')/,/^        }/c\
'"$(cat /tmp/ws_mt5_push.txt)" signal-bot.js 2>/dev/null || \
sed -i '' '/fetch(.api.signal.)/,/^        }/ {
    /fetch(.api.signal.)/r /tmp/ws_mt5_push.txt
    d
}' signal-bot.js

# ============================================
# 7. Remove any empty lines and fix syntax
# ============================================
echo "🔧 Cleaning up syntax..."

# Remove duplicate blank lines
sed -i '' '/^$/N;/^\n$/D' signal-bot.js

# Fix any missing semicolons
sed -i '' 's/}$/};/g' signal-bot.js 2>/dev/null || true

# ============================================
# Done
# ============================================
echo ""
echo "=========================================="
echo "✅ Fixes applied!"
echo "=========================================="
echo ""
echo "📁 Backup saved as: signal-bot.js.backup"
echo ""
echo "🔄 Next steps:"
echo "   1. Refresh your browser"
echo "   2. Check console for: '✅ WebSocket connected to Render'"
echo "   3. Start your Jump75 bot"
echo ""
echo "⚠️  If you see errors, restore backup with:"
echo "   cp signal-bot.js.backup signal-bot.js"
echo ""