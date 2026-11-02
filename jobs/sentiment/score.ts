/**
 * Scores headlines with the HySense analyzer.
 * stdin:  {"tickers": [{"symbol","name","type"}], "items": [{"id","text"}]}
 * stdout: [{"id","score","confidence","marketSentiment"}]
 */
import { IntelligentSentimentAnalyzer, type DynamicTicker } from './analyzer';

interface Input {
  tickers: { symbol: string; name: string; type: 'crypto' | 'stock' }[];
  items: { id: string; text: string }[];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin()) as Input;
  const analyzer = new IntelligentSentimentAnalyzer();
  analyzer.setDynamicTickers(
    input.tickers.map<DynamicTicker>((t, i) => ({
      symbol: t.symbol,
      name: t.name,
      type: t.type,
      keywords: [t.symbol.toLowerCase(), t.name.toLowerCase()].filter(Boolean),
      priority: i + 1,
    }))
  );

  const results = [];
  for (const item of input.items) {
    const r = await analyzer.analyzeSentiment(item.text);
    results.push({
      id: item.id,
      score: Math.round(r.score * 1000) / 1000,
      confidence: Math.round(r.confidence * 1000) / 1000,
      marketSentiment: r.marketSentiment,
    });
  }
  process.stdout.write(JSON.stringify(results));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
