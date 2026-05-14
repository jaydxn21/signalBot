from flask import Flask, request, jsonify
from flask_cors import CORS
import joblib
import pandas as pd
import os

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Load model
model = None
model_path = "models/trade_model.pkl"

if os.path.exists(model_path):
    model = joblib.load(model_path)
    print("✅ Model loaded successfully")
else:
    print("⚠️ No model found - will use fallback")

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.json or {}
        if 'rsi' in data:
            del data['rsi']
            
        if model is None:
            return jsonify({"win_probability": 50, "recommendation": "NEUTRAL"})
        
        df = pd.DataFrame([data])
        prob = model.predict_proba(df)[0][1] * 100
        prob = round(prob, 1)
        
        return jsonify({
            "win_probability": prob,
            "recommendation": "APPROVE" if prob >= 53 else "REJECT",
            "ai_confidence": "HIGH" if prob >= 68 else "MEDIUM" if prob >= 53 else "LOW"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"🚀 AI Server running on port {port}")
    app.run(host="0.0.0.0", port=port)