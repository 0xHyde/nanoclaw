import { initStore, storeMemory, recallDetails, boostMemories, cleanupMemories, searchMemoryTool } from '../dist/memory/engine.js';

async function main() {
  console.log('--- Init store ---');
  await initStore();

  console.log('--- Store test memories ---');
  const id1 = await storeMemory('User prefers dark mode in all apps.', 'group:main', 'main', 0.6, 'preferences');
  const id2 = await storeMemory('User has a cat named Nomi.', 'group:main', 'main', 0.7, 'entities');
  console.log({ id1, id2 });

  console.log('--- Recall (preferences query) ---');
  const rec1 = await recallDetails('What are my preferences?', 'main');
  console.log('Recalled text length:', rec1.text?.length ?? 0, 'ids:', rec1.ids);

  console.log('--- Recall (entity query) ---');
  const rec2 = await recallDetails('Tell me about my pet.', 'main');
  console.log('Recalled text length:', rec2.text?.length ?? 0, 'ids:', rec2.ids);

  console.log('--- Boost memories ---');
  if (rec1.ids.length > 0) {
    await boostMemories(rec1.ids);
    console.log('Boosted', rec1.ids.length, 'memories');
  }

  console.log('--- Search memory tool ---');
  const toolResults = await searchMemoryTool('dark mode', undefined, 'main', 3);
  console.log('Tool results:', toolResults.map(r => ({ content: r.content.slice(0, 40), kind: r.kind })));

  console.log('--- Cleanup + consolidation ---');
  await cleanupMemories();
  console.log('Done');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
