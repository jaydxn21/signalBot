# -*- coding: utf-8 -*-
import pandas as pd
import json
import joblib
import os
from sklearn.ensemble import RandomForestClassifier

class TradeLearner:
    def __init__(self, model_path="models/trade_model.pkl"):
        self.model_path = model_path
        os.makedirs("models", exist_ok=True)
        self.model = None

    def load_data(self, json_file="mt5_trades.json"):
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        df = pd.DataFrame(data)
        
        # === SAFE FEATURE ENGINEERING ===
        df['rr_ratio'] = abs(df['tp'] - df['entry']) / (abs(df['sl'] - df['entry']) + 0.0001)
        
        # ATR fallback
        if 'atr' in df.columns:
            df['atr_ratio'] = abs(df['entry'] - df['sl']) / (df['atr'] + 0.0001)
        else:
            df['atr_ratio'] = 1.5  # default fallback
        
        df['is_win'] = (df['outcome'] == 'TP').astype(int)
        
        # Safe mode check
        if 'mode' in df.columns:
            df['is_breakout'] = df['mode'].str.contains('BREAKOUT', na=False).astype(int)
        else:
            df['is_breakout'] = 0
        
        # Symbol type
        df['symbol_type'] = df['symbol'].apply(lambda x: 
            1 if '75' in str(x) else 2 if '10' in str(x) else 3)
        
        # Hour
        df['hour'] = pd.to_datetime(df['close_time'], unit='s', errors='coerce').dt.hour
        df['hour'] = df['hour'].fillna(12)
        
        # Fill any remaining NaN
        numeric_cols = ['rr_ratio', 'atr_ratio', 'is_breakout', 'hour', 'symbol_type']
        df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())
        
        print(f"Loaded {len(df)} trades | Columns: {list(df.columns)}")
        return df

    def train(self, json_file="mt5_trades.json"):
        df = self.load_data(json_file)
        
        features = ['rr_ratio', 'atr_ratio', 'is_breakout', 'hour', 'symbol_type']
        
        X = df[features]
        y = df['is_win']

        self.model = RandomForestClassifier(
            n_estimators=400,
            max_depth=12,
            min_samples_leaf=2,
            random_state=42,
            class_weight='balanced'
        )
        self.model.fit(X, y)
        
        joblib.dump(self.model, self.model_path)
        
        accuracy = self.model.score(X, y)
        print(f"\n✅ Model trained successfully on {len(df)} trades!")
        print(f"Accuracy: {accuracy:.1%}")

        # FEATURE IMPORTANCE
        importance = pd.Series(self.model.feature_importances_, index=features).sort_values(ascending=False)
        print("\n🤖 FEATURE IMPORTANCE:")
        for feat, imp in importance.items():
            print(f"   {feat:12} : {imp:.4f}")
        
        return True

    def predict(self, features_dict):
        if self.model is None:
            if os.path.exists(self.model_path):
                self.model = joblib.load(self.model_path)
            else:
                return 50.0
                
        df = pd.DataFrame([features_dict])
        prob = self.model.predict_proba(df)[0][1]
        return round(prob * 100, 1)


# Run training
if __name__ == "__main__":
    learner = TradeLearner()
    learner.train()