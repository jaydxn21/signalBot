# -*- coding: utf-8 -*-
from flask import Flask, request, jsonify
from flask_cors import CORS
from trade_learner import TradeLearner

app = Flask(__name__)

# Enable CORS for all origins (especially Vercel)
CORS(app, resources={r"/*": {"origins": "*"}})

learner = TradeLearner()

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.json or {}
        
        # Clean features to match trained model
        if 'rsi' in data:
            del data['rsi']
        
        prob = learner.predict(data)
        return jsonify({
            "win_probability": prob,
            "recommendation": "APPROVE" if prob >= 53 else "REJECT",
            "ai_confidence": "HIGH" if prob >= 68 else "MEDIUM" if prob >= 53 else "LOW"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/train', methods=['POST'])
def train():
    success = learner.train()
    return jsonify({"status": "success" if success else "failed"})

if __name__ == "__main__":
    print("AI Server running at http://localhost:5000 with CORS enabled")
    print("   POST /predict  -> Get win probability")
    print("   POST /train    -> Retrain model")
    app.run(port=5000, debug=False)