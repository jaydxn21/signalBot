from flask import Flask, request, jsonify
from flask_cors import CORS
import joblib
import pandas as pd
import os
import json
from datetime import datetime

app = Flask(__name__)
# Enable CORS for all routes and all origins (important for Railway)
CORS(app, resources={r"/*": {"origins": "*"}})

# Load model
model = None
model_path = "models/trade_model.pkl"

if os.path.exists(model_path):
    try:
        model = joblib.load(model_path)
        print("✅ Model loaded successfully")
    except Exception as e:
        print(f"⚠️ Failed to load model: {e}")
        model = None
else:
    print("⚠️ No model found - will use fallback")

# ============================================================
# HEALTH CHECK ENDPOINT
# ============================================================
@app.route('/health', methods=['GET', 'HEAD', 'OPTIONS'])
def health():
    """Health check endpoint for monitoring"""
    return jsonify({
        "status": "healthy",
        "service": "ai-prediction-engine",
        "version": "2.0.0",
        "ready": model is not None,
        "model_loaded": model is not None,
        "timestamp": datetime.now().isoformat(),
        "endpoints": ["/health", "/predict", "/status", "/api/health"]
    })

# ============================================================
# API HEALTH ENDPOINT
# ============================================================
@app.route('/api/health', methods=['GET', 'HEAD', 'OPTIONS'])
def api_health():
    """Alternative health check endpoint"""
    return jsonify({
        "status": "ok",
        "timestamp": datetime.now().isoformat()
    })

# ============================================================
# STATUS ENDPOINT
# ============================================================
@app.route('/status', methods=['GET', 'HEAD', 'OPTIONS'])
def status():
    """Status endpoint"""
    return jsonify({
        "status": "running",
        "model_loaded": model is not None,
        "service": "ai-prediction-engine",
        "environment": "railway"
    })

# ============================================================
# PREDICTION ENDPOINT - SUPPORTS BOTH GET AND POST
# ============================================================
@app.route('/predict', methods=['GET', 'POST', 'HEAD', 'OPTIONS'])
def predict():
    """Main prediction endpoint - supports both GET and POST"""
    
    # Handle preflight/OPTIONS
    if request.method == 'OPTIONS':
        response = jsonify({})
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
        response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
        return response
    
    # Handle HEAD (for testing)
    if request.method == 'HEAD':
        return '', 200
    
    # Handle GET (for browser testing)
    if request.method == 'GET':
        return jsonify({
            "message": "Use POST method with features to get prediction",
            "example": {
                "rr_ratio": 2.5,
                "atr_ratio": 1.5,
                "is_breakout": 1,
                "hour": 12,
                "symbol_type": 1
            },
            "endpoint": "https://ai-server-production-8bc5.up.railway.app/predict"
        })
    
    # Handle POST (actual prediction)
    try:
        data = request.json or {}
        
        # Remove RSI if present (not used in model)
        if 'rsi' in data:
            del data['rsi']
        
        # Handle test request
        if data.get('test'):
            return jsonify({"status": "ok", "message": "Server is ready"})
        
        # If no model, use fallback
        if model is None:
            win_prob = _fallback_prediction(data)
            return jsonify({
                "win_probability": win_prob,
                "recommendation": "APPROVE" if win_prob >= 53 else "REJECT",
                "ai_confidence": "HIGH" if win_prob >= 68 else "MEDIUM" if win_prob >= 53 else "LOW",
                "mode": "fallback"
            })
        
        # Prepare features for model
        df = pd.DataFrame([data])
        
        # Ensure all required columns exist
        required_cols = ['rr_ratio', 'atr_ratio', 'is_breakout', 'hour', 'symbol_type']
        for col in required_cols:
            if col not in df.columns:
                df[col] = 0  # Default value
        
        # Make prediction
        prob = model.predict_proba(df)[0][1] * 100
        prob = round(prob, 1)
        
        return jsonify({
            "win_probability": prob,
            "recommendation": "APPROVE" if prob >= 53 else "REJECT",
            "ai_confidence": "HIGH" if prob >= 68 else "MEDIUM" if prob >= 53 else "LOW",
            "mode": "model"
        })
        
    except Exception as e:
        print(f"Prediction error: {e}")
        return jsonify({"error": str(e)}), 500

# ============================================================
# ROOT ENDPOINT
# ============================================================
@app.route('/', methods=['GET', 'HEAD', 'OPTIONS'])
def root():
    """Root endpoint - API information"""
    return jsonify({
        "service": "AI Prediction Engine",
        "version": "2.0.0",
        "url": "https://ai-server-production-8bc5.up.railway.app",
        "endpoints": {
            "GET /": "This info",
            "GET /health": "Health check",
            "GET /api/health": "Alternative health check",
            "GET /status": "Service status",
            "GET /predict": "Usage info (test with browser)",
            "POST /predict": "Get win probability prediction"
        },
        "features": ["rr_ratio", "atr_ratio", "is_breakout", "hour", "symbol_type"],
        "ready": model is not None
    })

# ============================================================
# CATCH-ALL FOR UNDEFINED ROUTES
# ============================================================
@app.errorhandler(404)
def not_found(e):
    return jsonify({
        "error": "Endpoint not found",
        "available_endpoints": ["/", "/health", "/api/health", "/status", "/predict"],
        "server": "https://ai-server-production-8bc5.up.railway.app"
    }), 404

# ============================================================
# HELPER FUNCTIONS
# ============================================================

def _fallback_prediction(data):
    """Fallback prediction when model isn't loaded"""
    rr = data.get('rr_ratio', 2.0)
    is_breakout = data.get('is_breakout', 0)
    
    # Simple heuristic:
    # Higher risk-reward ratio = higher win probability
    # Breakouts have slightly higher probability
    base = 50 + (rr - 1.5) * 8
    if is_breakout:
        base += 5
    
    return round(min(85, max(35, base)), 1)

# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"🚀 AI Server running on port {port}")
    print(f"   URL: https://ai-server-production-8bc5.up.railway.app")
    print(f"   Health check: https://ai-server-production-8bc5.up.railway.app/health")
    print(f"   Predict endpoint: https://ai-server-production-8bc5.up.railway.app/predict")
    print(f"   Model loaded: {model is not None}")
    app.run(host="0.0.0.0", port=port, debug=False)