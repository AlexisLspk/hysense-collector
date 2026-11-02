/**
 * 🧠 Analyseur de Sentiment Intelligent avec Compromise
 *
 * Analyseur avancé qui utilise Compromise + vocabulaire financier
 * avec détection dynamique des tickers depuis le dashboard.
 *
 * --- Logique spécifique Reddit (robustesse) ---
 * - Ordre "factuel négatif d'abord" : price drop, trial/drug failure, sinks X%
 *   sont testés avant les patterns hype positifs pour éviter "buy the dip" + "sinks 15%" → bullish.
 * - Négation avant mots positifs courts : "don't buy", "never pump" ne déclenchent pas bullish.
 * - Quand le sentiment vient d'un pattern critique, le semanticScore n'est pas ajouté (pas de dilution).
 * - Confiance plancher 0.6 quand le sentiment est déterminé par un pattern critique.
 * - Intensité bearish renforcée pour patterns "sévères" (sinks X%, trial flop, endpoint not met).
 * - Logs CRITICAL NEGATIVE / PRICE DROP / LIQUIDATION uniquement si DEBUG_SENTIMENT=1.
 */

/** Logs de debug sentiment : définir DEBUG_SENTIMENT=1 en env pour activer. */
const DEBUG_SENTIMENT = process.env.DEBUG_SENTIMENT === '1';

// Import CommonJS de compromise (fonctionne avec TypeScript)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nlp = require('compromise');

// Vocabulaire positif étendu - Finance moderne
const POSITIVE_FINANCE_WORDS = [
  // Général positif
  'bullish', 'bull', 'bullrun', 'bullmarket', 'moon', 'rocket', 'pump', 'gains', 'profit', 'win', 'winning',
  'breakout', 'rally', 'surge', 'explosive', 'massive', 'incredible', 'amazing', 'epic', 'legendary',
  'diamond hands', 'hodl', 'buy', 'buying', 'accumulate', 'accumulation', 'dip buy', 'buy the dip',
  'strong', 'powerful', 'dominant', 'leading', 'champion', 'winner', 'success', 'victory',
  
  // Reddit spécifique - Actions urgentes et hype
  'explode', 'exploding', 'burst', 'bursting', 'ready to explode', 'about to burst', 'going to explode',
  'gainz', 'gainzz', 'gains', 'easy gainz', 'easy 10% gainz', 'free gainz', 'massive gainz',
  'going to', 'gonna', 'about to', 'ready to', 'set to', 'poised to', 'prepared to',
  'everyone get in', 'get in', 'get in now', 'get in before', 'before it\'s too late', 'last chance',
  'taking off', 'taking off now', 'lift off', 'blast off', 'skyrocketing', 'soaring',
  'insane volume', 'massive volume', 'volume explosion', 'volume surge', 'volume breakout',
  'up today', 'going up', 'moving up', 'rising', 'climbing', 'ascending',
  
  // Crypto spécifique
  'to the moon', 'lambo', 'tendies', 'yolo', 'fomo', 'fomo in', 'ape in', 'ape', 'apes together strong',
  'wen moon', 'wen lambo', 'number go up', 'line go up', 'stocks only go up', 'crypto only go up',
  'ath', 'all time high', 'new high', 'record high', 'milestone', 'breakthrough', 'adoption',
  'institutional', 'institutional adoption', 'partnership', 'upgrade', 'improvement', 'innovation',
  'decentralized', 'defi', 'nft', 'metaverse', 'web3', 'blockchain', 'smart contract',
  
  // Actions spécifique
  'squeeze', 'short squeeze', 'gamma squeeze', 'melt up', 'meltdown', 'moon shot', 'rocket ship',
  'diamond hands', 'paper hands', 'retard strength', 'autist', 'autistic', 'tendie town',
  'stocks go brrr', 'money printer go brrr', 'fed printer', 'stimulus', 'stimmy', 'free money',
  'earnings beat', 'revenue growth', 'profit margin', 'market share', 'competitive advantage',
  
  // Expressions de prix et targets
  'going to', 'gonna hit', 'hitting', 'target price', 'price target', 'price prediction',
  'to $', 'to 1$', 'to 50 cents', 'to 50c', 'going to 1$', 'gonna hit $',
  'news came out', 'news released', 'positive news', 'good news', 'great news',
  
  // Emojis et expressions
  '🚀', '🌙', '💎', '🙌', '💪', '🔥', '📈', '💰', '💎🙌', '🚀🌙', 'to the moon!', 'mooning',
  'pumping', 'pump it', 'let\'s go', 'lfg', 'this is the way', 'hodl gang', 'diamond hands gang',
  '🚀🚀🚀', '🌙🌙🌙', '💎🙌💎🙌', '📈📈📈', '💰💰💰', '🔥🔥🔥',
  '⬆️', '⬆️⬆️⬆️', '🚀🚀', '🌙🌙', '📈📈', '💰💰', '🔥🔥'
];

// Vocabulaire négatif étendu - Finance moderne
const NEGATIVE_FINANCE_WORDS = [
  // Général négatif
  'bearish', 'bear', 'bearmarket', 'dump', 'crash', 'crash and burn', 'sell', 'selling', 'panic', 'fear',
  'scam', 'rug pull', 'ponzi', 'bubble', 'overvalued', 'overpriced', 'correction', 'dip', 'decline',
  'fall', 'falling', 'dropping', 'plummeting', 'tanking', 'bleeding', 'red', 'red day', 'red week',
  'weak', 'failing', 'losing', 'defeat', 'failure', 'disaster', 'catastrophe', 'collapse',
  
  // Crypto spécifique
  'rekt', 'get rekt', 'rekted', 'liquidated', 'liquidation', 'liquidations', 'margin call', 'stop loss', 'stop out', 'paper hands',
  'sell off', 'massive sell off', 'whale dump', 'whale selling', 'institutional selling', 'fud',
  'fear uncertainty doubt', 'bear trap', 'dead cat bounce', 'fake pump', 'pump and dump',
  'hack', 'exploit', 'vulnerability', 'security breach', 'rug pull', 'exit scam',
  'massive liquidations', 'billions liquidated', 'liquidated in', 'forced liquidation',
  'cascade liquidation', 'liquidation cascade', 'liquidation event', 'liquidation storm',
  'over leveraged', 'overleveraged', 'margin called', 'margin calls', 'leverage ratio',
  'funding rate', 'funding rates', 'perpetual', 'futures', 'derivatives crash',
  'options expiry', 'gamma squeeze', 'delta hedging', 'volatility spike',
  
  // Actions spécifique
  'bag holder', 'holding bags', 'bag holding', 'bagged', 'trapped', 'stuck', 'underwater',
  'margin call', 'forced liquidation', 'short attack', 'bear raid', 'manipulation', 'rigged',
  'hedge fund', 'hedgies', 'hedge fund attack', 'dark pool', 'naked short', 'synthetic shares',
  'earnings miss', 'revenue decline', 'profit loss', 'market share loss', 'competitive disadvantage',
  
  // Emojis et expressions
  '📉', '🔴', '💀', '☠️', '😭', '😢', '😱', '💸', '📉🔴', 'crashing', 'dumping', 'bleeding red',
  'paper hands', 'weak hands', 'sell out', 'give up', 'capitulation', 'surrender',
  '📉📉📉', '🔴🔴🔴', '💀💀💀', '😭😭😭', '💸💸💸'
];

// Vocabulaire neutre mais important
const NEUTRAL_FINANCE_WORDS = [
  'consolidation', 'sideways', 'ranging', 'support', 'resistance', 'breakout', 'breakdown',
  'volume', 'liquidity', 'volatility', 'volatile', 'stable', 'stability', 'equilibrium',
  'analysis', 'technical analysis', 'fundamental', 'fundamentals', 'valuation', 'fair value',
  'market cap', 'market capitalization', 'circulating supply', 'total supply', 'max supply',
  'trading', 'investing', 'portfolio', 'diversification', 'risk management'
];

// Interface pour le résultat d'analyse
export interface IntelligentSentimentResult {
  score: number; // -1 à 1
  confidence: number; // 0 à 1
  positiveWords: string[];
  negativeWords: string[];
  neutralWords: string[];
  mentions: { ticker: string; count: number; context: string[] }[];
  marketSentiment: 'bullish' | 'bearish' | 'neutral';
  intensity: 'low' | 'medium' | 'high' | 'extreme';
  summary: string;
  contextAnalysis: {
    isQuestion: boolean;
    isExclamation: boolean;
    hasNegation: boolean;
    emotionalIntensity: number;
  };
  emojiAnalysis: {
    positiveEmojis: string[];
    negativeEmojis: string[];
    emojiScore: number;
  };
  learningData: {
    textLength: number;
    wordCount: number;
    sentimentWordsCount: number;
    tickerMentionsCount: number;
  };
}

// Interface pour les tickers dynamiques
export interface DynamicTicker {
  symbol: string;
  name: string;
  type: 'crypto' | 'stock';
  keywords: string[];
  priority: number;
}

// Classe pour l'analyseur intelligent
export class IntelligentSentimentAnalyzer {
  private dynamicTickers: DynamicTicker[] = [];
  private learningData: any[] = [];
  
  /**
   * Tickers listés sur le dashboard (fournis par le collecteur à chaque exécution)
   */
  setDynamicTickers(tickers: DynamicTicker[]): void {
    this.dynamicTickers = tickers;
  }
  
  /**
   * Analyse le sentiment avec Compromise + vocabulaire financier
   */
  async analyzeSentiment(text: string): Promise<IntelligentSentimentResult> {
    
    const doc = nlp(text);
    const lowerText = text.toLowerCase();
    
    // Analyse de base avec Compromise v14+
    let compromiseScore = 0;
    try {
      // Compromise v14+ utilise une API différente
      const positive = doc.match('#Positive').length;
      const negative = doc.match('#Negative').length;
      const total = positive + negative;
      compromiseScore = total > 0 ? (positive - negative) / total : 0;
    } catch (error) {
      // Fallback si les tags ne fonctionnent pas
      console.warn('⚠️ Compromise sentiment analysis failed, using fallback');
      compromiseScore = 0;
    }
    
    // Analyse du vocabulaire financier
    const financeAnalysis = this.analyzeFinanceVocabulary(lowerText);
    
    // Analyse des tickers dynamiques
    const tickerMentions = this.detectDynamicTickers(lowerText);
    
    // Analyse du contexte
    const contextAnalysis = this.analyzeContext(doc, text);
    
    // Analyse des emojis
    const emojiAnalysis = this.analyzeEmojis(text);
    
    // Déterminer le sentiment du marché AVANT de combiner les scores
    const marketSentiment = this.determineMarketSentiment(0, text);
    
    // ADVANCED SCORE CALCULATION with semantic and syntactic analysis
    let finalScore = 0;
    if (marketSentiment === 'bearish') {
      // Score variable selon l'intensité détectée
      finalScore = this.calculateIntensityScore(text, 'bearish');
    } else if (marketSentiment === 'bullish') {
      // Score variable selon l'intensité détectée  
      finalScore = this.calculateIntensityScore(text, 'bullish');
    } else {
      // Combiner les scores normalement pour les cas neutres
      finalScore = this.combineScores(compromiseScore, financeAnalysis.score, emojiAnalysis.emojiScore);
    }
    
    // Apply semantic and syntactic adjustments (sans dilution si sentiment issu d'un pattern critique)
    const fromCriticalPattern = marketSentiment !== 'neutral';
    finalScore = this.applyAdvancedAnalysis(finalScore, contextAnalysis, fromCriticalPattern);
    
    // Calculer la confiance (plancher 0.6 si sentiment déterminé par un pattern critique)
    let confidence = this.calculateConfidence(financeAnalysis, tickerMentions, contextAnalysis);
    if (fromCriticalPattern) {
      confidence = Math.max(confidence, 0.6);
    }
    
    // Déterminer l'intensité
    const intensity = this.determineIntensity(finalScore, contextAnalysis.emotionalIntensity);
    
    // Générer le résumé
    const summary = this.generateSummary(finalScore, marketSentiment, intensity, tickerMentions);
    
    // Données d'apprentissage
    const learningData = {
      textLength: text.length,
      wordCount: doc.terms().length,
      sentimentWordsCount: financeAnalysis.positiveCount + financeAnalysis.negativeCount,
      tickerMentionsCount: tickerMentions.length
    };
    
    // Stocker pour l'apprentissage
    this.storeLearningData({
      text,
      result: {
        score: finalScore,
        confidence,
        marketSentiment,
        intensity,
        tickerMentions
      },
      learningData
    });
    
    return {
      score: finalScore,
      confidence,
      positiveWords: financeAnalysis.positiveWords,
      negativeWords: financeAnalysis.negativeWords,
      neutralWords: financeAnalysis.neutralWords,
      mentions: tickerMentions,
      marketSentiment,
      intensity,
      summary,
      contextAnalysis,
      emojiAnalysis,
      learningData
    };
  }
  
  /**
   * Analyse le vocabulaire financier
   */
  private analyzeFinanceVocabulary(text: string): {
    score: number;
    positiveCount: number;
    negativeCount: number;
    positiveWords: string[];
    negativeWords: string[];
    neutralWords: string[];
  } {
    const lowerText = text.toLowerCase();
    const words = lowerText.split(/\s+/);
    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;
    
    const foundPositiveWords: string[] = [];
    const foundNegativeWords: string[] = [];
    const foundNeutralWords: string[] = [];
    
    // DÉTECTION PRIORITAIRE DES PATTERNS MULTI-MOTS (avant analyse mot par mot)
    // Patterns positifs multi-mots (plus précis)
    const positivePhrasePatterns = [
      /ready to explode/i,
      /about to burst/i,
      /going to explode/i,
      /set to explode/i,
      /poised to/i,
      /ready to/i,
      /everyone get in/i,
      /get in now/i,
      /get in before/i,
      /before it's too late/i,
      /last chance/i,
      /taking off/i,
      /lift off/i,
      /blast off/i,
      /skyrocketing/i,
      /soaring/i,
      /insane volume/i,
      /massive volume/i,
      /volume explosion/i,
      /volume surge/i,
      /volume breakout/i,
      /up today/i,
      /going up/i,
      /moving up/i,
      /news came out/i,
      /news released/i,
      /positive news/i,
      /good news/i,
      /great news/i,
      /easy \d+% gainz?/i,
      /going to \$\d+/i,
      /gonna hit \$\d+/i,
      /to \$\d+/i,
      /to \d+ cents?/i,
      /to \d+c/i,
      /is ready/i,
      /rn exploding/i,
      /right now/i
    ];
    
    positivePhrasePatterns.forEach(pattern => {
      if (pattern.test(text)) {
        positiveCount += 2; // Poids double pour les phrases complètes
        foundPositiveWords.push(pattern.toString());
      }
    });
    
    // Analyser chaque mot
    words.forEach(word => {
      const cleanWord = word.replace(/[^\w]/g, '').toLowerCase();
      const originalWord = word.toLowerCase();
      
      // Vérifier dans les listes de vocabulaire (case-insensitive)
      const isPositive = POSITIVE_FINANCE_WORDS.some(w => 
        w.toLowerCase() === cleanWord || w.toLowerCase() === originalWord
      );
      const isNegative = NEGATIVE_FINANCE_WORDS.some(w => 
        w.toLowerCase() === cleanWord || w.toLowerCase() === originalWord
      );
      const isNeutral = NEUTRAL_FINANCE_WORDS.some(w => 
        w.toLowerCase() === cleanWord || w.toLowerCase() === originalWord
      );
      
      if (isPositive) {
        positiveCount++;
        foundPositiveWords.push(word);
      } else if (isNegative) {
        negativeCount++;
        foundNegativeWords.push(word);
      } else if (isNeutral) {
        neutralCount++;
        foundNeutralWords.push(word);
      }
    });
    
    // Analyser les phrases complètes (pour expressions comme "to the moon")
    const sentences = text.split(/[.!?]+/);
    sentences.forEach(sentence => {
      const trimmedSentence = sentence.trim().toLowerCase();
      POSITIVE_FINANCE_WORDS.forEach(phrase => {
        if (trimmedSentence.includes(phrase.toLowerCase())) {
        positiveCount++;
          foundPositiveWords.push(phrase);
        }
      });
      NEGATIVE_FINANCE_WORDS.forEach(phrase => {
        if (trimmedSentence.includes(phrase.toLowerCase())) {
        negativeCount++;
          foundNegativeWords.push(phrase);
      }
      });
    });
    
    // Détecter les patterns de liquidations avec montants (très négatif)
    const liquidationPatterns = [
      /over\s+\$[\d,]+(?:\.\d+)?[bmkt]?\s+(?:were\s+)?liquidated/i,
      /\$[\d,]+(?:\.\d+)?[bmkt]?\s+(?:were\s+)?liquidated/i,
      /liquidated\s+\$[\d,]+(?:\.\d+)?[bmkt]?/i,
      /massive\s+liquidations/i,
      /billions?\s+(?:were\s+)?liquidated/i,
      /millions?\s+(?:were\s+)?liquidated/i,
      /trillions?\s+(?:were\s+)?liquidated/i,
      /cascade\s+liquidation/i,
      /liquidation\s+cascade/i,
      /forced\s+liquidation/i,
      /liquidation\s+storm/i
    ];
    
    liquidationPatterns.forEach(pattern => {
      if (pattern.test(text)) {
        negativeCount += 3; // Poids triple pour les liquidations
        foundNegativeWords.push('massive liquidations detected');
        if (DEBUG_SENTIMENT) {
          console.log(`🚨 LIQUIDATION DETECTED: "${text.substring(0, 100)}..."`);
        }
      }
    });
    
    // BONUS: Détecter les titres très courts avec mots-clés positifs (ex: "VIVK is ready to explode")
    // Ces posts sont souvent très positifs mais peuvent être mal analysés
    const shortPositivePatterns = [
      /^(?:[A-Z]{2,5}|[a-z]+)\s+(?:is|will|gonna|going to|ready to|about to|set to)\s+(?:explode|burst|moon|pump|rocket|surge|rally|breakout|soar|skyrocket|take off)/i,
      /^(?:[A-Z]{2,5}|[a-z]+)\s+(?:exploding|bursting|mooning|pumping|rocketing|surging|rallying|soaring|taking off)/i,
      /^(?:[A-Z]{2,5}|[a-z]+)\s+(?:has|with)\s+(?:massive|insane|huge|big)\s+volume/i,
      /^(?:[A-Z]{2,5}|[a-z]+)\s+(?:easy|free|massive)\s+\d+%\s+gainz?/i
    ];
    
    const isShortText = text.split(/\s+/).length <= 10; // Texte court (10 mots ou moins)
    shortPositivePatterns.forEach(pattern => {
      if (pattern.test(text) && isShortText) {
        positiveCount += 3; // Poids triple pour les titres courts très positifs
        foundPositiveWords.push('short positive title detected');
      }
    });
    
    // BONUS: Détecter les emojis positifs répétés (🚀🚀🚀, 📈📈📈, etc.)
    const emojiPatterns = [
      /🚀{2,}/g,
      /🌙{2,}/g,
      /📈{2,}/g,
      /💰{2,}/g,
      /🔥{2,}/g,
      /💎🙌{2,}/g,
      /⬆️{2,}/g
    ];
    
    emojiPatterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        positiveCount += matches.length * 2; // Poids double pour chaque répétition
        foundPositiveWords.push('repeated positive emojis');
      }
    });
    
    const totalSentimentWords = positiveCount + negativeCount;
    const score = totalSentimentWords > 0 ? (positiveCount - negativeCount) / totalSentimentWords : 0;
    
    return {
      score,
      positiveCount,
      negativeCount,
      positiveWords: [...new Set(foundPositiveWords)],
      negativeWords: [...new Set(foundNegativeWords)],
      neutralWords: [...new Set(foundNeutralWords)]
    };
  }
  
  /**
   * Détecte les tickers dynamiquement
   */
  private detectDynamicTickers(text: string): { ticker: string; count: number; context: string[] }[] {
    const mentions: { [key: string]: { count: number; context: string[] } } = {};
    
    this.dynamicTickers.forEach(ticker => {
      ticker.keywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        const matches = text.match(regex);
        if (matches) {
          if (!mentions[ticker.symbol]) {
            mentions[ticker.symbol] = { count: 0, context: [] };
          }
          mentions[ticker.symbol].count += matches.length;
          mentions[ticker.symbol].context.push(keyword);
        }
      });
    });
    
    return Object.entries(mentions).map(([ticker, data]) => ({
      ticker,
      count: data.count,
      context: [...new Set(data.context)]
    }));
  }
  
  /**
   * Advanced syntax and semantic analysis with Compromise
   */
  private analyzeContext(doc: any, text: string): {
    isQuestion: boolean;
    isExclamation: boolean;
    hasNegation: boolean;
    emotionalIntensity: number;
    // Advanced analysis
    isRhetoricalQuestion: boolean;
    isHyperbole: boolean;
    isIrony: boolean;
    isPrediction: boolean;
    isComparison: boolean;
    isSuperlative: boolean;
    isConditional: boolean;
    isUrgent: boolean;
    isHistorical: boolean;
    isFuture: boolean;
    semanticScore: number;
    syntacticComplexity: number;
  } {
    // Basic Compromise analysis
    let questions: any[] = [];
    let exclamations: any[] = [];
    let negations: any[] = [];
    
    try {
      questions = doc.questions();
      exclamations = doc.exclamations();
      negations = doc.negations();
    } catch (error) {
      questions = doc.match('?').out('array');
      exclamations = doc.match('!').out('array');
      negations = doc.match('#Negative').out('array');
    }
    
    // ADVANCED SEMANTIC ANALYSIS
    const lowerText = text.toLowerCase();
    
    // Rhetorical questions detection
    const rhetoricalPatterns = [
      /why\s+(would|should|do)\s+(you|we|anyone)/i,
      /what\s+(are\s+you|is\s+this)/i,
      /how\s+(can|could|would)\s+(you|anyone)/i,
      /who\s+(would|should|does)/i,
      /is\s+this\s+(a\s+)?joke/i,
      /are\s+you\s+(serious|kidding)/i
    ];
    const isRhetoricalQuestion = rhetoricalPatterns.some(pattern => pattern.test(text));
    
    // Hyperbole detection
    const hyperbolePatterns = [
      /\b(never|always|all|every|none|nothing|everything)\b.*\b(again|before|time|way|day|moment)\b/i,
      /\b(incredible|amazing|insane|crazy|unbelievable|epic|legendary|massive|huge|enormous)\b/i,
      /\b(perfect|flawless|infallible|unstoppable|invincible)\b/i,
      /\b(100|1000|million|billion|trillion)\s+(percent|times|dollars|shares)\b/i
    ];
    const isHyperbole = hyperbolePatterns.some(pattern => pattern.test(text));
    
    // Irony/Sarcasm detection
    const ironyPatterns = [
      /\b(sure|yeah|right|okay|great|wonderful|fantastic)\b.*\b(not|never|no|bad|terrible|awful)\b/i,
      /\b(obviously|clearly|definitely|absolutely)\b.*\b(wrong|false|incorrect|bad)\b/i,
      /\b(thanks|thank\s+you)\b.*\b(ruin|destroy|crash|dump)\b/i,
      /\b(genius|brilliant|smart)\b.*\b(idea|plan|move|decision)\b.*\b(terrible|awful|bad|wrong)\b/i
    ];
    const isIrony = ironyPatterns.some(pattern => pattern.test(text));
    
    // Prediction detection
    const predictionPatterns = [
      /\b(will|going\s+to|gonna|shall|would|could|should)\b.*\b(go|rise|fall|crash|pump|moon|dump)\b/i,
      /\b(predict|forecast|expect|anticipate|believe|think|hope|wish)\b/i,
      /\b(soon|eventually|eventually|finally|ultimately|in\s+the\s+end)\b/i,
      /\b(guaranteed|certain|sure|definitely|absolutely)\b.*\b(win|lose|profit|loss)\b/i
    ];
    const isPrediction = predictionPatterns.some(pattern => pattern.test(text));
    
    // Comparison detection
    const comparisonPatterns = [
      /\b(better|worse|best|worst|more|less|most|least)\b.*\b(than|compared\s+to|vs|versus)\b/i,
      /\b(similar|like|unlike|different|same|identical)\b/i,
      /\b(beats|outperforms|underperforms|surpasses|exceeds)\b/i,
      /\b(stronger|weaker|higher|lower|bigger|smaller)\b/i
    ];
    const isComparison = comparisonPatterns.some(pattern => pattern.test(text));
    
    // Superlative detection
    const superlativePatterns = [
      /\b(the\s+)?(best|worst|greatest|smallest|biggest|highest|lowest|fastest|slowest)\b/i,
      /\b(most|least|top|bottom|number\s+one|#1)\b/i,
      /\b(ultimate|supreme|perfect|flawless|infallible)\b/i,
      /\b(champion|winner|loser|king|queen|boss|master)\b/i
    ];
    const isSuperlative = superlativePatterns.some(pattern => pattern.test(text));
    
    // Conditional detection
    const conditionalPatterns = [
      /\b(if|when|unless|provided|assuming|supposing)\b.*\b(then|will|would|should|could)\b/i,
      /\b(in\s+case|as\s+long\s+as|so\s+long\s+as)\b/i,
      /\b(depending\s+on|based\s+on|contingent\s+on)\b/i
    ];
    const isConditional = conditionalPatterns.some(pattern => pattern.test(text));
    
    // Urgency detection
    const urgencyPatterns = [
      /\b(now|immediately|urgent|asap|right\s+now|this\s+instant)\b/i,
      /\b(hurry|quick|fast|rush|emergency|critical)\b/i,
      /\b(don't\s+wait|act\s+now|buy\s+now|sell\s+now)\b/i,
      /\b(last\s+chance|final|deadline|expires)\b/i
    ];
    const isUrgent = urgencyPatterns.some(pattern => pattern.test(text));
    
    // Historical context detection
    const historicalPatterns = [
      /\b(yesterday|last\s+week|last\s+month|last\s+year|ago|before|previously)\b/i,
      /\b(remember|recall|history|past|used\s+to|was|were)\b/i,
      /\b(back\s+then|in\s+the\s+day|old\s+times|traditionally)\b/i
    ];
    const isHistorical = historicalPatterns.some(pattern => pattern.test(text));
    
    // Future context detection
    const futurePatterns = [
      /\b(tomorrow|next\s+week|next\s+month|next\s+year|soon|later|eventually)\b/i,
      /\b(future|ahead|coming|upcoming|forthcoming|prospective)\b/i,
      /\b(plan|plans|planning|intend|intention|goal|target)\b/i
    ];
    const isFuture = futurePatterns.some(pattern => pattern.test(text));
    
    // Calculate semantic score based on detected patterns
    let semanticScore = 0;
    if (isRhetoricalQuestion) semanticScore += 0.2;
    if (isHyperbole) semanticScore += 0.3;
    if (isIrony) semanticScore -= 0.4; // Irony often indicates opposite sentiment
    if (isPrediction) semanticScore += 0.2;
    if (isComparison) semanticScore += 0.1;
    if (isSuperlative) semanticScore += 0.3;
    if (isConditional) semanticScore += 0.1;
    if (isUrgent) semanticScore += 0.4;
    if (isHistorical) semanticScore += 0.1;
    if (isFuture) semanticScore += 0.2;
    
    // Syntactic complexity analysis
    let syntacticComplexity = 0;
    
    // Sentence structure complexity
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const avgWordsPerSentence = sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length;
    syntacticComplexity += Math.min(avgWordsPerSentence / 20, 0.3);
    
    // Subordinate clauses
    const subordinateClauses = (text.match(/\b(that|which|who|whom|whose|where|when|why|how|if|unless|because|since|although|though|while|as|so|but|and|or)\b/gi) || []).length;
    syntacticComplexity += Math.min(subordinateClauses / 10, 0.3);
    
    // Complex punctuation
    const complexPunctuation = (text.match(/[;:—–-]/g) || []).length;
    syntacticComplexity += Math.min(complexPunctuation / 5, 0.2);
    
    // Parenthetical expressions
    const parenthetical = (text.match(/\([^)]+\)/g) || []).length;
    syntacticComplexity += Math.min(parenthetical / 3, 0.2);
    
    // Calculate emotional intensity with advanced factors
    let emotionalIntensity = 0;
    
    // Basic intensity factors
    const exclamationCount = (text.match(/!/g) || []).length;
    emotionalIntensity += exclamationCount * 0.1;
    
    const capsWords = text.match(/\b[A-Z]{2,}\b/g) || [];
    emotionalIntensity += capsWords.length * 0.05;
    
    const repeatedChars = text.match(/(.)\1{2,}/g) || [];
    emotionalIntensity += repeatedChars.length * 0.1;
    
    // Advanced intensity factors
    if (isHyperbole) emotionalIntensity += 0.3;
    if (isUrgent) emotionalIntensity += 0.4;
    if (isSuperlative) emotionalIntensity += 0.2;
    if (isRhetoricalQuestion) emotionalIntensity += 0.2;
    
    return {
      isQuestion: questions.length > 0,
      isExclamation: exclamations.length > 0,
      hasNegation: negations.length > 0,
      emotionalIntensity: Math.min(emotionalIntensity, 1),
      // Advanced analysis
      isRhetoricalQuestion,
      isHyperbole,
      isIrony,
      isPrediction,
      isComparison,
      isSuperlative,
      isConditional,
      isUrgent,
      isHistorical,
      isFuture,
      semanticScore: Math.max(-1, Math.min(1, semanticScore)),
      syntacticComplexity: Math.min(syntacticComplexity, 1)
    };
  }
  
  /**
   * Analyse les emojis
   */
  private analyzeEmojis(text: string): {
    positiveEmojis: string[];
    negativeEmojis: string[];
    emojiScore: number;
  } {
    const emojiRegex = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
    const emojis = text.match(emojiRegex) || [];
    
    const positiveEmojis: string[] = [];
    const negativeEmojis: string[] = [];
    
    emojis.forEach(emoji => {
      if (POSITIVE_FINANCE_WORDS.includes(emoji)) {
        positiveEmojis.push(emoji);
      } else if (NEGATIVE_FINANCE_WORDS.includes(emoji)) {
        negativeEmojis.push(emoji);
      }
    });
    
    const emojiScore = emojis.length > 0 ? (positiveEmojis.length - negativeEmojis.length) / emojis.length : 0;
    
    return {
      positiveEmojis: [...new Set(positiveEmojis)],
      negativeEmojis: [...new Set(negativeEmojis)],
      emojiScore
    };
  }
  
  /**
   * Combine les scores de différentes sources
   */
  private combineScores(compromiseScore: number, financeScore: number, emojiScore: number): number {
    // Poids : 40% Compromise, 50% vocabulaire financier, 10% emojis
    const combinedScore = (compromiseScore * 0.4) + (financeScore * 0.5) + (emojiScore * 0.1);
    return Math.max(-1, Math.min(1, combinedScore));
  }
  
  /**
   * Calcule la confiance
   */
  private calculateConfidence(financeAnalysis: any, tickerMentions: any[], contextAnalysis: any): number {
    let confidence = 0;
    
    // Confiance basée sur le nombre de mots de sentiment
    const sentimentWords = financeAnalysis.positiveCount + financeAnalysis.negativeCount;
    confidence += Math.min(sentimentWords / 10, 0.4);
    
    // Confiance basée sur les mentions de tickers
    confidence += Math.min(tickerMentions.length / 5, 0.3);
    
    // Confiance basée sur l'intensité émotionnelle
    confidence += contextAnalysis.emotionalIntensity * 0.3;
    
    return Math.min(confidence, 1);
  }
  
  /**
   * Apply advanced semantic and syntactic analysis to adjust the score.
   * Quand fromCriticalPattern est true, on n'ajoute pas le semanticScore pour éviter de diluer
   * un signal bearish/bullish déjà très fiable (ex. "sinks 15%", "trial flop").
   */
  private applyAdvancedAnalysis(baseScore: number, contextAnalysis: any, fromCriticalPattern = false): number {
    let adjustedScore = baseScore;

    // Semantic adjustments (désactivés si le sentiment vient d'un pattern critique)
    if (!fromCriticalPattern) {
      adjustedScore += contextAnalysis.semanticScore * 0.3;
    }
    
    // Irony detection - often indicates opposite sentiment
    if (contextAnalysis.isIrony) {
      adjustedScore *= -0.8; // Reverse sentiment with reduced intensity
    }
    
    // Hyperbole detection - amplify sentiment
    if (contextAnalysis.isHyperbole) {
      adjustedScore *= 1.5;
    }
    
    // Rhetorical questions - often indicate strong sentiment
    if (contextAnalysis.isRhetoricalQuestion) {
      adjustedScore *= 1.2;
    }
    
    // Predictions - amplify sentiment based on direction
    if (contextAnalysis.isPrediction) {
      if (adjustedScore > 0) {
        adjustedScore *= 1.3; // Amplify bullish predictions
      } else if (adjustedScore < 0) {
        adjustedScore *= 1.3; // Amplify bearish predictions
      }
    }
    
    // Superlatives - amplify sentiment
    if (contextAnalysis.isSuperlative) {
      adjustedScore *= 1.4;
    }
    
    // Urgency - amplify sentiment
    if (contextAnalysis.isUrgent) {
      adjustedScore *= 1.3;
    }
    
    // Comparisons - moderate amplification
    if (contextAnalysis.isComparison) {
      adjustedScore *= 1.1;
    }
    
    // Conditional statements - reduce confidence but maintain direction
    if (contextAnalysis.isConditional) {
      adjustedScore *= 0.8;
    }
    
    // Syntactic complexity - more complex sentences often indicate more thoughtful analysis
    if (contextAnalysis.syntacticComplexity > 0.5) {
      adjustedScore *= 1.1;
    }
    
    // Historical context - often indicates experience-based sentiment
    if (contextAnalysis.isHistorical) {
      adjustedScore *= 1.1;
    }
    
    // Future context - often indicates optimism or pessimism
    if (contextAnalysis.isFuture) {
      adjustedScore *= 1.2;
    }
    
    // Ensure score stays within bounds
    return Math.max(-1, Math.min(1, adjustedScore));
  }

  /**
   * Calcule un score d'intensité variable selon le contenu
   */
  private calculateIntensityScore(text: string, sentiment: 'bullish' | 'bearish'): number {
    const lowerText = text.toLowerCase();
    let intensity = 0.5; // Score de base
    
    // Détection d'intensité ULTRA BULLISH
    if (sentiment === 'bullish') {
      // Patterns ultra bullish universels
      const ultraBullishPatterns = [
        /\b([A-Z]{2,5})\s+\1\s+\1/i,  // Répétition de ticker (ex: BYND BYND BYND, GME GME GME)
        /\b([A-Z]{2,5})\s+\1/i,  // Double ticker (ex: BYND BYND, GME GME)
        /🚀🚀🚀/, /🌙🌙🌙/, /💎🙌💎🙌/, /📈📈📈/, /💰💰💰/, /🔥🔥🔥/,
        /to\s+the\s+moon/i, /mooning/i, /pumping/i,
        /diamond\s+hands/i, /hodl\s+gang/i, /strong\s+buy/i,
        /buy\s+the\s+dip/i, /accumulate/i, /yolo/i, /fomo\s+in/i, /ape\s+in/i,
        /\b([A-Z]{2,5})\s+only/i, /only\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+to\s+the\s+moon/i, /\b([A-Z]{2,5})\s+mooning/i,
        /\b([A-Z]{2,5})\s+pump/i, /pump\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+hold/i, /hold\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+buy/i, /buy\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+strong/i, /strong\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+diamond/i, /diamond\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+hodl/i, /hodl\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+yolo/i, /yolo\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+fomo/i, /fomo\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+ape/i, /ape\s+([A-Z]{2,5})/i,
        // NOUVEAUX PATTERNS REDDIT
        /ready\s+to\s+explode/i,
        /about\s+to\s+burst/i,
        /going\s+to\s+explode/i,
        /set\s+to\s+explode/i,
        /poised\s+to/i,
        /ready\s+to/i,
        /exploding/i,
        /bursting/i,
        /everyone\s+get\s+in/i,
        /get\s+in\s+now/i,
        /get\s+in\s+before/i,
        /before\s+it's\s+too\s+late/i,
        /last\s+chance/i,
        /taking\s+off/i,
        /lift\s+off/i,
        /blast\s+off/i,
        /skyrocketing/i,
        /soaring/i,
        /insane\s+volume/i,
        /massive\s+volume/i,
        /volume\s+explosion/i,
        /volume\s+surge/i,
        /volume\s+breakout/i,
        /up\s+today/i,
        /going\s+up/i,
        /moving\s+up/i,
        /news\s+came\s+out/i,
        /news\s+released/i,
        /positive\s+news/i,
        /good\s+news/i,
        /great\s+news/i,
        /easy\s+\d+%\s+gainz?/i,
        /gainz/i,
        /gainzz/i,
        /\b([A-Z]{2,5})\s+(?:is|will|gonna|going to|ready to|about to|set to|poised to)\s+(?:explode|burst|moon|pump|rocket|surge|rally|breakout|soar|skyrocket|take off)/i,
        /\b([A-Z]{2,5})\s+(?:exploding|bursting|mooning|pumping|rocketing|surging|rallying|soaring|taking off)/i,
        /\b([A-Z]{2,5})\s+(?:is|has)\s+ready/i,
        /\b([A-Z]{2,5})\s+(?:is|has)\s+massive\s+volume/i,
        /\b([A-Z]{2,5})\s+(?:is|has)\s+insane\s+volume/i,
        /\b([A-Z]{2,5})\s+(?:easy|free|massive)\s+\d+%\s+gainz?/i,
        /\b([A-Z]{2,5})\s+(?:going to|gonna hit|hitting)\s+\$\d+/i,
        /\b([A-Z]{2,5})\s+(?:to|going to)\s+\d+\s+cents?/i,
        /\b([A-Z]{2,5})\s+(?:to|going to)\s+\d+c/i,
        /\b([A-Z]{2,5})\s+(?:is|was)\s+up\s+today/i,
        /\b([A-Z]{2,5})\s+(?:is|was)\s+going\s+up/i,
        /\b([A-Z]{2,5})\s+(?:is|was)\s+moving\s+up/i
      ];
      
      for (const pattern of ultraBullishPatterns) {
        if (pattern.test(text)) {
          intensity += 0.2; // Bonus d'intensité
        }
      }
      
      // Bonus pour répétitions de caractères
      const repeatedChars = (text.match(/(.)\1{2,}/g) || []).length;
      intensity += Math.min(repeatedChars * 0.1, 0.3);
      
      // Bonus pour majuscules
      const capsWords = (text.match(/\b[A-Z]{2,}\b/g) || []).length;
      intensity += Math.min(capsWords * 0.05, 0.2);
      
      // Bonus pour exclamations
      const exclamations = (text.match(/!/g) || []).length;
      intensity += Math.min(exclamations * 0.05, 0.2);
      
      return Math.min(intensity, 1.0); // Score final entre 0.5 et 1.0
    }
    
    // Détection d'intensité ULTRA BEARISH
    if (sentiment === 'bearish') {
      // Patterns "sévères" (alignés sur critical negative) : bonus d'intensité pour mieux différencier
      const severeBearishPatterns = [
        /sinks\s+\d+%/i, /sank\s+\d+%/i,
        /trial\s+flop/i, /trial\s+fail/i, /trial\s+failure/i,
        /drug\s+fail/i, /drug\s+fails/i, /drug\s+failure/i,
        /primary\s+endpoint\s+not\s+achieved/i, /endpoint\s+not\s+met/i,
        /\bflop\b/i, /\bfailure\b/i, /fails\s+to\s+match/i, /failed\s+to\s+match/i
      ];
      for (const pattern of severeBearishPatterns) {
        if (pattern.test(lowerText)) {
          intensity += 0.2;
          break; // Un seul bonus pour éviter sur-amplification
        }
      }

      // Patterns ultra bearish universels
      const ultraBearishPatterns = [
        /crash/i, /dump/i, /sell\s+off/i, /panic\s+sell/i,
        /liquidated/i, /margin\s+call/i, /rekt/i, /get\s+rekt/i,
        /bear\s+market/i, /crypto\s+winter/i, /flash\s+crash/i,
        /whale\s+dump/i, /institutional\s+sell/i, /forced\s+sell/i,
        /hack/i, /exploit/i, /rug\s+pull/i, /exit\s+scam/i,
        /ban\s+crypto/i, /regulatory\s+crackdown/i, /sec\s+crackdown/i,
        /\b([A-Z]{2,5})\s+crash/i, /crash\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+dump/i, /dump\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+sell/i, /sell\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+panic/i, /panic\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+bear/i, /bear\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+rekt/i, /rekt\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+liquidated/i, /liquidated\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+margin\s+call/i, /margin\s+call\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+forced\s+sell/i, /forced\s+sell\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+whale\s+dump/i, /whale\s+dump\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+institutional\s+sell/i, /institutional\s+sell\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+hack/i, /hack\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+exploit/i, /exploit\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+rug\s+pull/i, /rug\s+pull\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+exit\s+scam/i, /exit\s+scam\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+ban/i, /ban\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+regulatory/i, /regulatory\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+sec/i, /sec\s+([A-Z]{2,5})/i,
        /\b([A-Z]{2,5})\s+government/i, /government\s+([A-Z]{2,5})/i
      ];

      for (const pattern of ultraBearishPatterns) {
        if (pattern.test(text)) {
          intensity += 0.2; // Bonus d'intensité
        }
      }
      
      // Bonus pour répétitions de caractères négatifs
      const repeatedChars = (text.match(/(.)\1{2,}/g) || []).length;
      intensity += Math.min(repeatedChars * 0.1, 0.3);
      
      // Bearish = score NÉGATIF (sinon l'API compte ces posts comme bullish)
      return -Math.min(intensity, 1.0); // Score final entre -1.0 et -0.5
    }
    
    return intensity;
  }

  /**
   * Détecte une négation immédiate devant un mot positif (don't buy, never pump, etc.).
   * Utilisé pour éviter de classer en bullish des phrases comme "don't buy", "never pump", "no reason to buy".
   * Limité à des regex sur l'entrée (pas d'évaluation dynamique) pour la sécurité.
   */
  private hasNegationBeforePositive(text: string): boolean {
    return /(?:don't|dont|never|not|avoid|shouldn't|wouldn't|won't|can't|cannot|no\s+reason\s+to)\s+(?:buy|pump|hold|moon|yolo|fomo|ape|accumulate)/i.test(text);
  }

  /**
   * Détermine le sentiment du marché avec logique financière stricte.
   * Ordre d'évaluation : 1) factuel négatif (price drop, trial failure, sinks), 2) positif (hype), 3) négatif critique, 4) price drop (redondant), 5) seuils.
   */
  private determineMarketSentiment(score: number, text: string): 'bullish' | 'bearish' | 'neutral' {
    const lowerText = text.toLowerCase();

    // 1) FACTUEL NÉGATIF EN PREMIER (évite "buy the dip" + "sinks 15%" → bullish)
    const factualNegativeFirst = [
      /down\s+\d+%/i, /dropped\s+\d+%/i, /fell\s+\d+%/i, /-\d+%/i,
      /sinks\s+\d+%/i, /sank\s+\d+%/i, /plummeted\s+\d+%/i, /tanked\s+\d+%/i, /crashed\s+\d+%/i,
      /trial\s+flop/i, /trial\s+fail/i, /trial\s+failure/i,
      /drug\s+fail/i, /drug\s+fails/i, /drug\s+failure/i,
      /primary\s+endpoint\s+not\s+achieved/i, /endpoint\s+not\s+met/i,
      /\bflop\b/i, /\bfailure\b/i, /fails\s+to\s+match/i, /failed\s+to\s+match/i,
      /premarket\s+-\d+%/i, /pre-?market\s+-\d+%/i
    ];
    for (const pattern of factualNegativeFirst) {
      if (pattern.test(lowerText)) {
        if (DEBUG_SENTIMENT) {
          console.log(`📉 FACTUAL NEGATIVE (first): "${text.substring(0, 100)}..."`);
        }
        return 'bearish';
      }
    }

    // DÉTECTION PRIORITAIRE DES ÉVÉNEMENTS POSITIFS MAJEURS
    const criticalPositivePatterns = [
      // Posts de hype simples
      /(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)/i,
      /(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)/i,
      // Patterns spécifiques pour posts de hype
      /(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+no{3,}/i,
      /(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+and\s+(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)\s+only/i,
      /just\s+buy{3,}/i,
      /buy{3,}/i,
      /🚀🚀🚀/,
      /🌙🌙🌙/,
      /💎🙌💎🙌/,
      /📈📈📈/,
      /💰💰💰/,
      /🔥🔥🔥/,
      /to\s+the\s+moon/i,
      /mooning/i,
      /pumping/i,
      /let's\s+go/i,
      /lfg/i,
      /this\s+is\s+the\s+way/i,
      /diamond\s+hands/i,
      /hodl\s+gang/i,
      /buy\s+(?:bynd|btc|eth|gme|amc|tsla|aapl|msft|googl|amzn|nvda|meta|nflx|spy|qqq)/i,
      /strong\s+buy/i,
      /buy\s+the\s+dip/i,
      /accumulate/i,
      /yolo/i,
      /fomo\s+in/i,
      /ape\s+in/i,
      
      // Patterns spécifiques pour tous les tickers - ULTRA BULLISH
      /\b([A-Z]{2,5})\s+\1\s+\1/i,  // Répétition de ticker (ex: BYND BYND BYND)
      /\b([A-Z]{2,5})\s+only/i, /only\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+and\s+\1\s+only/i,
      /\b([A-Z]{2,5})\s+no{3,}/i, /\b([A-Z]{2,5})\s+nooooo/i,
      /\b([A-Z]{2,5})\s+to\s+the\s+moon/i, /\b([A-Z]{2,5})\s+mooning/i,
      /\b([A-Z]{2,5})\s+pump/i, /pump\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+hold/i, /hold\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+buy/i, /buy\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+strong/i, /strong\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+diamond/i, /diamond\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+hodl/i, /hodl\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+yolo/i, /yolo\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+fomo/i, /fomo\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+ape/i, /ape\s+([A-Z]{2,5})/i,
      
      // NOUVEAUX PATTERNS REDDIT - Explode, burst, ready to, etc.
      /\b([A-Z]{2,5})\s+(?:is|will|gonna|going to|ready to|about to|set to|poised to)\s+(?:explode|burst|moon|pump|rocket|surge|rally|breakout|soar|skyrocket|take off)/i,
      /\b([A-Z]{2,5})\s+(?:exploding|bursting|mooning|pumping|rocketing|surging|rallying|soaring|taking off)/i,
      /\b([A-Z]{2,5})\s+(?:is|has)\s+ready/i,
      /\b([A-Z]{2,5})\s+(?:is|has)\s+massive\s+volume/i,
      /\b([A-Z]{2,5})\s+(?:is|has)\s+insane\s+volume/i,
      /\b([A-Z]{2,5})\s+(?:easy|free|massive)\s+\d+%\s+gainz?/i,
      /\b([A-Z]{2,5})\s+(?:going to|gonna hit|hitting)\s+\$\d+/i,
      /\b([A-Z]{2,5})\s+(?:to|going to)\s+\d+\s+cents?/i,
      /\b([A-Z]{2,5})\s+(?:to|going to)\s+\d+c/i,
      /\b([A-Z]{2,5})\s+(?:is|was)\s+up\s+today/i,
      /\b([A-Z]{2,5})\s+(?:is|was)\s+going\s+up/i,
      /\b([A-Z]{2,5})\s+(?:is|was)\s+moving\s+up/i,
      /ready\s+to\s+explode/i,
      /about\s+to\s+burst/i,
      /going\s+to\s+explode/i,
      /set\s+to\s+explode/i,
      /poised\s+to/i,
      /ready\s+to/i,
      /everyone\s+get\s+in/i,
      /get\s+in\s+now/i,
      /get\s+in\s+before/i,
      /before\s+it's\s+too\s+late/i,
      /last\s+chance/i,
      /taking\s+off/i,
      /lift\s+off/i,
      /blast\s+off/i,
      /skyrocketing/i,
      /soaring/i,
      /insane\s+volume/i,
      /massive\s+volume/i,
      /volume\s+explosion/i,
      /volume\s+surge/i,
      /volume\s+breakout/i,
      /up\s+today/i,
      /going\s+up/i,
      /moving\s+up/i,
      /news\s+came\s+out/i,
      /news\s+released/i,
      /positive\s+news/i,
      /good\s+news/i,
      /great\s+news/i,
      /easy\s+\d+%\s+gainz?/i,
      /going\s+to\s+\$\d+/i,
      /gonna\s+hit\s+\$\d+/i,
      /to\s+\$\d+/i,
      /to\s+\d+\s+cents?/i,
      /to\s+\d+c/i,
      /is\s+ready/i,
      /rn\s+exploding/i,
      /right\s+now/i,
      
      // Patterns de volume et hype
      /volume\s+explosion/i, /volume\s+surge/i, /massive\s+volume/i,
      /volume\s+breakout/i, /volume\s+pump/i, /volume\s+moon/i,
      /volume\s+🚀/i, /volume\s+🌙/i, /volume\s+💎/i,
      
      // Patterns de prix
      /price\s+target/i, /price\s+prediction/i, /price\s+forecast/i,
      /price\s+🚀/i, /price\s+🌙/i, /price\s+💎/i,
      /price\s+to\s+moon/i, /price\s+mooning/i, /price\s+pumping/i,
      
      // Patterns de squeeze
      /short\s+squeeze/i, /squeeze\s+play/i, /squeeze\s+potential/i,
      /squeeze\s+🚀/i, /squeeze\s+🌙/i, /squeeze\s+💎/i,
      /squeeze\s+to\s+moon/i, /squeeze\s+mooning/i, /squeeze\s+pumping/i
    ];
    
    // Vérifier les patterns positifs (avec garde anti-négation pour éviter "don't buy" → bullish)
    for (const pattern of criticalPositivePatterns) {
      if (pattern.test(text)) {
        if (this.hasNegationBeforePositive(text)) {
          continue; // Ne pas classer bullish si négation devant buy/pump/moon/etc.
        }
        return 'bullish';
      }
    }
    
    // DÉTECTION PRIORITAIRE DES ÉVÉNEMENTS NÉGATIFS MAJEURS
    const criticalNegativePatterns = [
      // Liquidations massives
      /\$[\d,]+(?:\.\d+)?[bmkt]?\s+(?:were\s+)?liquidated/i,
      /over\s+\$[\d,]+(?:\.\d+)?[bmkt]?\s+(?:were\s+)?liquidated/i,
      /massive\s+liquidations/i,
      /billions?\s+(?:were\s+)?liquidated/i,
      /millions?\s+(?:were\s+)?liquidated/i,
      /trillions?\s+(?:were\s+)?liquidated/i,
      /cascade\s+liquidation/i,
      /liquidation\s+cascade/i,
      /forced\s+liquidation/i,
      /liquidation\s+storm/i,
      
      // Crashs et effondrements
      /market\s+crash/i,
      /flash\s+crash/i,
      /crypto\s+winter/i,
      /bear\s+market/i,
      /massive\s+selloff/i,
      /panic\s+sell/i,
      /whale\s+dump/i,
      /institutional\s+sell/i,
      /margin\s+call/i,
      /forced\s+sell/i,
      
      // Hack et exploits
      /\$[\d,]+(?:\.\d+)?[bmkt]?\s+hack/i,
      /exploit/i,
      /security\s+breach/i,
      /rug\s+pull/i,
      /exit\s+scam/i,
      
      // Régulation négative
      /ban\s+crypto/i,
      /crypto\s+ban/i,
      /illegal\s+crypto/i,
      /regulatory\s+crackdown/i,
      /sec\s+crackdown/i,
      /government\s+ban/i,
      
      // Patterns spécifiques pour tous les tickers - ULTRA BEARISH
      /\b([A-Z]{2,5})\s+crash/i, /crash\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+dump/i, /dump\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+sell/i, /sell\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+panic/i, /panic\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+bear/i, /bear\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+rekt/i, /rekt\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+liquidated/i, /liquidated\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+margin\s+call/i, /margin\s+call\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+forced\s+sell/i, /forced\s+sell\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+whale\s+dump/i, /whale\s+dump\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+institutional\s+sell/i, /institutional\s+sell\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+hack/i, /hack\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+exploit/i, /exploit\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+rug\s+pull/i, /rug\s+pull\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+exit\s+scam/i, /exit\s+scam\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+ban/i, /ban\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+regulatory/i, /regulatory\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+sec/i, /sec\s+([A-Z]{2,5})/i,
      /\b([A-Z]{2,5})\s+government/i, /government\s+([A-Z]{2,5})/i,
      
      // Patterns de volume et hype négatifs
      /volume\s+crash/i, /volume\s+dump/i, /volume\s+selloff/i,
      /volume\s+panic/i, /volume\s+bear/i, /volume\s+rekt/i,
      /volume\s+🚨/i, /volume\s+💀/i, /volume\s+☠️/i,
      
      // Patterns de prix négatifs
      /price\s+crash/i, /price\s+dump/i, /price\s+selloff/i,
      /price\s+panic/i, /price\s+bear/i, /price\s+rekt/i,
      /price\s+🚨/i, /price\s+💀/i, /price\s+☠️/i,
      /price\s+to\s+zero/i, /price\s+zero/i, /price\s+crash/i,
      
      // Patterns de squeeze négatifs
      /squeeze\s+crash/i, /squeeze\s+dump/i, /squeeze\s+selloff/i,
      /squeeze\s+panic/i, /squeeze\s+bear/i, /squeeze\s+rekt/i,
      /squeeze\s+🚨/i, /squeeze\s+💀/i, /squeeze\s+☠️/i,

      // Essais cliniques / pharma / titres négatifs (ex. NVO CagriSema)
      /trial\s+flop/i, /trial\s+fail/i, /trial\s+failure/i,
      /drug\s+fail/i, /drug\s+fails/i, /drug\s+failure/i,
      /fails\s+to\s+match/i, /failed\s+to\s+match/i,
      /primary\s+endpoint\s+not\s+achieved/i, /endpoint\s+not\s+met/i,
      /\bflop\b/i, /\bflops\b/i,
      /\bfailure\b/i, /\bfailures\b/i,
      /sinks\s+\d+%/i, /sank\s+\d+%/i,
      /premarket\s+-\d+%/i, /pre-?market\s+-\d+%/i
    ];
    
    // Si on détecte un événement critique négatif, c'est automatiquement BEARISH
    for (const pattern of criticalNegativePatterns) {
      if (pattern.test(lowerText)) {
        if (DEBUG_SENTIMENT) {
          console.log(`🚨 CRITICAL NEGATIVE EVENT DETECTED: "${text.substring(0, 100)}..."`);
        }
        return 'bearish';
      }
    }
    
    // DÉTECTION DES VARIATIONS DE PRIX NÉGATIVES
    const priceDropPatterns = [
      /down\s+\d+%/i,
      /dropped\s+\d+%/i,
      /fell\s+\d+%/i,
      /declined\s+\d+%/i,
      /plummeted\s+\d+%/i,
      /tanked\s+\d+%/i,
      /crashed\s+\d+%/i,
      /sinks\s+\d+%/i,
      /sank\s+\d+%/i,
      /-\d+%/i,
      /red\s+day/i,
      /red\s+week/i,
      /bleeding/i,
      /dumping/i
    ];
    
    // Si on détecte une baisse de prix significative, c'est BEARISH
    for (const pattern of priceDropPatterns) {
      if (pattern.test(lowerText)) {
        if (DEBUG_SENTIMENT) {
          console.log(`📉 PRICE DROP DETECTED: "${text.substring(0, 100)}..."`);
        }
        return 'bearish';
      }
    }
    
    
    // LOGIQUE TRADITIONNELLE AVEC SEUILS PLUS STRICTS
    if (score > 0.4) return 'bullish';  // Seuil plus élevé
    if (score < -0.4) return 'bearish'; // Seuil plus élevé
    return 'neutral';
  }
  
  /**
   * Détermine l'intensité
   */
  private determineIntensity(score: number, emotionalIntensity: number): 'low' | 'medium' | 'high' | 'extreme' {
    const absScore = Math.abs(score);
    const combinedIntensity = (absScore + emotionalIntensity) / 2;
    
    if (combinedIntensity > 0.8) return 'extreme';
    if (combinedIntensity > 0.5) return 'high';
    if (combinedIntensity > 0.2) return 'medium';
    return 'low';
  }
  
  /**
   * Génère un résumé
   */
  private generateSummary(score: number, marketSentiment: string, intensity: string, mentions: any[]): string {
    const tickers = mentions.map(m => m.ticker).join(', ');
    const tickerText = tickers ? ` pour ${tickers}` : '';
    
    if (intensity === 'extreme') {
      return `Sentiment ${marketSentiment} extrême${tickerText} (${score.toFixed(2)})`;
    } else if (intensity === 'high') {
      return `Sentiment ${marketSentiment} fort${tickerText} (${score.toFixed(2)})`;
    } else if (intensity === 'medium') {
      return `Sentiment ${marketSentiment} modéré${tickerText} (${score.toFixed(2)})`;
    } else {
      return `Sentiment neutre${tickerText} (${score.toFixed(2)})`;
    }
  }
  
  /**
   * Stocke les données d'apprentissage
   */
  private storeLearningData(data: any): void {
    this.learningData.push(data);
    
    // Garder seulement les 1000 dernières entrées
    if (this.learningData.length > 1000) {
      this.learningData = this.learningData.slice(-1000);
    }
  }
  
  /**
   * Obtient les données d'apprentissage
   */
  getLearningData(): any[] {
    return [...this.learningData];
  }
  
  /**
   * Obtient les tickers dynamiques
   */
  getDynamicTickers(): DynamicTicker[] {
    return [...this.dynamicTickers];
  }
}

// Instance singleton
export const intelligentSentimentAnalyzer = new IntelligentSentimentAnalyzer();
