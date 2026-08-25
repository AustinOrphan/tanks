import { createProducerRegistry } from '../producers.mjs';
import { createRegistry } from '../registry.mjs';
import { runProcess } from '../process.mjs';
import { runCaptureCli } from '../run.mjs';
import { CAPTURE_RECIPES } from '../registry.mjs';

const [root, pidFile] = process.argv.slice(2);
if (!root || !pidFile) throw new Error('usage: signal-cli.mjs <root> <pid-file>');

const recipe = structuredClone(CAPTURE_RECIPES[1].recipe);
recipe.id = 'test.screen.slow';
recipe.producer = { kind: 'screen', scenarioId: 'slow-screen' };
recipe.fixture = { id: 'slow-screen', seed: 1 };
recipe.variant = {};
recipe.schedule = { kind: 'frames', frameCount: 2 };
const [entry] = createRegistry([recipe]);

const workerSource = `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.argv[1], JSON.stringify({
    groupLeaderPid: process.pid,
    descendantPid: descendant.pid,
  }));
  setInterval(() => {}, 1000);
`;

async function slowProducer(context) {
  await runProcess(process.execPath, ['-e', workerSource, pidFile], {
    cwd: root,
    env: context.env,
    timeoutMs: 120_000,
    signal: context.signal,
  });
  throw new Error('slow producer unexpectedly completed');
}

const producerRegistry = createProducerRegistry([['screen', slowProducer]]);
const code = await runCaptureCli({
  argv: ['--recipe', recipe.id, '--out', 'artifacts/capture/signal-test'],
  root,
  entries: [entry],
  lookupRecipe: (id) => id === recipe.id ? entry : null,
  captureDeps: {
    producerRegistry,
    inspectSourceState: async () => ({ requestedRef: null, commitSha: 'a'.repeat(40), dirty: false }),
    inspectPrerequisites: async () => ({
      playwright: { moduleSpecifier: 'fake', version: '1.62.0', executablePath: 'fake' },
      ffmpeg: 'ffmpeg fake',
      ffprobe: 'ffprobe fake',
    }),
  },
});
process.exitCode = code;
