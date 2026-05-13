# -*- coding: utf-8 -*-
from flask import Flask, request, jsonify
from trade_learner import TradeLearner

app = Flask(__name__)
learner = TradeLearner()

@app.route('/predict', methods=['POST'])
def predict():
    try:
        data = request.json
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
    print("AI Server running at http://localhost:5000")
    print("   POST /predict  -> Get win probability")
    print("   POST /train    -> Retrain model")
    app.run(port=5000, debug=False)