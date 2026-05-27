import { KissStrategy }       from './strategies/kiss.js';
import { SwingStrategy }      from './strategies/swing.js';
import { ScalpStrategy }      from './strategies/scalp.js';
import { TrendStrategy }      from './strategies/trend.js';
import { ORBStrategy }        from './strategies/orb.js';
import { MomentumStrategy }   from './strategies/momentum.js';
import { SyntheticScalper }   from './strategies/synthetic-scalper.js';
import { CryptoScalper }      from './strategies/crypto-scalper.js';
import { RSIFadeScalper }     from './strategies/rsi-fade.js';
import { RangeBoundaryStrategy } from './strategies/range_boundary.js';
import { VWAPReversionScalper } from './strategies/vwap-reversion.js';
import { CandleSpeedScalper } from './strategies/candle-speed.js';
import { LondonBreakout }     from './strategies/london-breakout.js';
import { NewsFadeScalper }    from './strategies/news-fade.js';
import { UltraScalper }       from './strategies/ultra-scalper.js';
import { CipherStrategy } from './strategies/cipher.js';


// --- ADD THIS MAP ABOVE THE CLASS ---
const STRATEGY_MODULES = {
    h4_kiss: KissStrategy,
    swing: SwingStrategy,
    scalp: ScalpStrategy,
    trend: TrendStrategy,
    orb: ORBStrategy,
    momentum: MomentumStrategy,
    synthetic_scalp: SyntheticScalper,
    crypto_scalp: CryptoScalper,
    rsi_fade: RSIFadeScalper,
    range_boundary: RangeBoundaryStrategy,
    vwap_reversion: VWAPReversionScalper,
    candle_speed: CandleSpeedScalper,
    london_breakout: LondonBreakout,
    news_fade: NewsFadeScalper,
    ultra_scalp: UltraScalper,
    cipher: CipherStrategy,

};

export class StrategyEngine {
    constructor() {
        this.lastSignalTime = 0;
    }

    analyze(strategyType, lowerTFCandles, higherTFCandles, rsiState, atr, symbol = '', rsi = null) {
        let signal = null;

        switch (strategyType) {
            case 'h4_kiss':         signal = KissStrategy.checkEntry(lowerTFCandles, higherTFCandles);                       break;
            case 'swing':           signal = SwingStrategy.checkEntry(lowerTFCandles);                                       break;
            case 'scalp':           signal = ScalpStrategy.checkEntry(lowerTFCandles, rsiState);                             break;
            case 'trend':           signal = TrendStrategy.checkEntry(lowerTFCandles, rsiState);                                       break;
            case 'orb':             signal = ORBStrategy.checkEntry(lowerTFCandles);                                         break;
            case 'momentum':        signal = MomentumStrategy.checkEntry(lowerTFCandles, atr, symbol, higherTFCandles, rsi); break;
            case 'synthetic_scalp': signal = SyntheticScalper.checkEntry(lowerTFCandles, atr);                               break;
            case 'crypto_scalp':    signal = CryptoScalper.checkEntry(lowerTFCandles, atr);                                  break;
            case 'rsi_fade':        signal = RSIFadeScalper.checkEntry(lowerTFCandles, atr);                                 break;
            case 'range_boundary':  signal = RangeBoundaryStrategy.checkEntry(lowerTFCandles, atr);                           break;
            case 'vwap_reversion':  signal = VWAPReversionScalper.checkEntry(lowerTFCandles, atr);                           break;
            case 'candle_speed':    signal = CandleSpeedScalper.checkEntry(lowerTFCandles, atr);                             break;
            case 'london_breakout': signal = LondonBreakout.checkEntry(lowerTFCandles, atr);                                 break;
            case 'news_fade':       signal = NewsFadeScalper.checkEntry(lowerTFCandles, atr);                                break;
            case 'cipher':          signal = CipherStrategy.checkEntry(lowerTFCandles, higherTFCandles, atr, 'engine');      break;
            case 'ultra_scalp':     signal = UltraScalper.checkEntry(lowerTFCandles, atr);                                   break;
        }

        if (signal && lowerTFCandles[lowerTFCandles.length - 1].time > this.lastSignalTime) {
            this.lastSignalTime = lowerTFCandles[lowerTFCandles.length - 1].time;
            return signal;
        }

        return null;
    }

    // --- ADD THIS METHOD AFTER analyze() ---
    registerLoss(strategyType) {
        const module = STRATEGY_MODULES[strategyType];
        if (module && typeof module.registerLoss === 'function') {
            module.registerLoss();
        }
    }
}