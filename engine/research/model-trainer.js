// engine/research/model-trainer.js
// Invokes trade_learner.py as a child process to retrain the RandomForest
// trade-outcome model on the growing pool of labeled trades (live
// mt5_trades.json + Auto-Researcher walk-forward trades), and versions the
// resulting model artifact so a bad retrain can be rolled back.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

function runPython(pythonBin, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`trade_learner.py exited with code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseResultJson(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('RESULT_JSON:'.length));
  } catch (_) {
    return null;
  }
}

// Retrains the model using every data file that exists, writing a
// timestamp-versioned .pkl plus updating models/latest.pkl so the live
// prediction server (ai_server_production.py) always loads the newest
// successfully-trained model.
export async function retrainModel({
  rootDir,
  pythonBin = 'python3',
  dataFiles = ['mt5_trades.json', 'data/research-trades.json'],
} = {}) {
  const existingData = dataFiles
    .map((f) => path.join(rootDir, f))
    .filter((f) => fs.existsSync(f));

  if (!existingData.length) {
    throw new Error('No trade data files found to train on');
  }

  const versionTag = new Date().toISOString().replace(/[:.]/g, '-');
  const versionedPath = path.join(rootDir, 'models', `trade_model_${versionTag}.pkl`);
  const latestPath = path.join(rootDir, 'models', 'latest.pkl');

  const args = ['trade_learner.py', '--out', versionedPath, '--print-json'];
  for (const f of existingData) args.push('--data', f);

  const stdout = await runPython(pythonBin, args, rootDir);
  const result = parseResultJson(stdout) || {};
  if (result.error) throw new Error(result.error);

  // Point models/latest.pkl at the new version (copy, not symlink, so it
  // works identically on Windows/HP setups without symlink permissions).
  fs.mkdirSync(path.dirname(latestPath), { recursive: true });
  fs.copyFileSync(versionedPath, latestPath);
  // Keep the repo's original default path in sync too, since
  // ai_server_production.py currently hardcodes models/trade_model.pkl.
  fs.copyFileSync(versionedPath, path.join(rootDir, 'models', 'trade_model.pkl'));

  return {
    versionTag,
    modelPath: versionedPath,
    trainedOnCount: result.trained_on_count,
    accuracy: result.accuracy,
    featureImportance: result.feature_importance,
    dataFilesUsed: existingData,
    timestamp: Date.now(),
  };
}
