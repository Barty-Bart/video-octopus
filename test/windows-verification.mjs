// Disposable Windows runner follow-up. Uses tools installed by fresh-install.mjs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
  throw new Error('This follow-up runs only on a disposable Windows Actions runner.');
}
process.env.STUDIO_LOCAL_DIR = join(process.cwd(), 'local');
const { studioTool } = await import('../server/util.mjs');
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY|^ACTIONS_|^GITHUB_/i.test(key)));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/windows-export.test.mjs'], {
  stdio: 'inherit', timeout: 240000,
  env: { ...childEnv, TEST_FFMPEG: studioTool('ffmpeg'), TEST_FFPROBE: studioTool('ffprobe') },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
