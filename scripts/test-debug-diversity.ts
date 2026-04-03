import { initStore, searchMemoryTool } from '../src/memory/engine.js';
import { cosineSimilarity } from '../src/memory/engine.js';

async function main() {
  await initStore();
  const results = await searchMemoryTool('Nomi 是什么', undefined, 'main', 10);
  console.log('Total results:', results.length);
  const nomi = results.filter(r => r.content.includes('Nomi') && r.content.startsWith('用户'));
  console.log('Nomi Chinese results:', nomi.length);
  for (let i = 0; i < nomi.length; i++) {
    for (let j = i + 1; j < nomi.length; j++) {
      const a = (nomi[i] as any).vector;
      const b = (nomi[j] as any).vector;
      const sim = cosineSimilarity(a, b);
      console.log(`sim(${i},${j})=${sim.toFixed(4)} lenA=${a?.length} lenB=${b?.length}`);
    }
  }
}
main().catch(console.error);
