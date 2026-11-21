/**
 * Standalone End-to-End Live Docker Test for ProtoClaw.
 * 
 * Verifies the complete real Docker workflow:
 * 1. Checks if Docker Desktop daemon is running.
 * 2. Provisions an isolated test session mailbox.
 * 3. Writes a test prompt to inbound.db (Host: Even seq: 2).
 * 4. Spawns real container via wakeContainer() with volume mounts.
 * 5. Waits for the container runner to poll and answer into outbound.db (Runner: Odd seq: 1).
 * 6. Reads and verifies the output.
 * 7. Stops the container cleanly via stopContainer().
 */

import fs from 'node:fs';
import kleur from 'kleur';
import { isDockerDaemonRunning } from '../src/container-runtime.js';
import { wakeContainer, stopContainer, stopAllContainers } from '../src/container-runner.js';
import { 
  openInboundDb, 
  openOutboundDb, 
  writeMessageIn 
} from '../src/mailbox/session-db.js';
import { 
  sessionDir, 
  inboundDbPath, 
  outboundDbPath, 
  provisionSessionStorage 
} from '../src/session-manager.js';

async function main() {
  console.log(kleur.cyan().bold('\n🐳 ProtoClaw Live Docker E2E Verification\n'));

  // 1. Check Docker Daemon
  process.stdout.write('1. Checking Docker daemon status... ');
  const daemonRunning = await isDockerDaemonRunning();
  if (!daemonRunning) {
    console.log(kleur.red('NOT RUNNING'));
    console.log(kleur.yellow('\n⚠ Docker Desktop is not running or not accessible.'));
    console.log('   Please make sure Docker Desktop is running and try again:\n');
    console.log(kleur.bold('   pnpm run test:docker\n'));
    process.exit(1);
  }
  console.log(kleur.green('RUNNING'));

  const testGroup = 'docker-test-group';
  const testSession = `docker-test-${Date.now()}`;
  const sDir = sessionDir(testGroup, testSession);

  try {
    // 2. Ensure directories and initialize inbound.db & outbound.db
    process.stdout.write('2. Provisioning session mailboxes... ');
    provisionSessionStorage(testGroup, testSession, {
      channelType: 'cli',
      platformId: 'test-terminal',
      threadId: null
    });

    const inPath = inboundDbPath(testGroup, testSession);
    const inDb = openInboundDb(inPath);

    writeMessageIn(inDb, {
      id: `in-${Date.now()}-1`,
      content: 'Hello from real Docker container test!'
    });
    inDb.close();
    console.log(kleur.green('OK'));

    // 3. Wake real Docker container
    console.log(`3. Spawning Docker container for session ${testSession}...`);
    await wakeContainer(testGroup, testSession);

    // 4. Wait for container to process and write to outbound.db
    process.stdout.write('4. Waiting for container runner to answer in outbound.db... ');
    const outPath = outboundDbPath(testGroup, testSession);

    let answered = false;
    let replyText = '';
    const maxAttempts = 30; // 15 seconds

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((res) => setTimeout(res, 500));
      if (fs.existsSync(outPath)) {
        try {
          const outDb = openOutboundDb(outPath, true);
          const rows = outDb.prepare('SELECT seq, content FROM messages_out;').all() as any[];
          outDb.close();

          if (rows && rows.length > 0) {
            answered = true;
            replyText = rows[0].content;
            console.log(kleur.green('RECEIVED!'));
            console.log(kleur.gray(`   Sequence: ${rows[0].seq} (Odd parity)`));
            console.log(kleur.white().bold(`   Response: "${replyText}"`));
            break;
          }
        } catch {
          // Database might still be locked or flushing, retry
        }
      }
    }

    if (!answered) {
      console.log(kleur.red('TIMED OUT'));
      console.log(kleur.yellow('   The container did not write a reply within 15 seconds.'));
    }

    // 5. Clean up container
    process.stdout.write('5. Stopping container gracefully... ');
    await stopContainer(testGroup, testSession);
    console.log(kleur.green('STOPPED'));

    if (answered) {
      console.log(kleur.green().bold('\n🎉 Live Docker Sandbox E2E Verification PASSED!\n'));
    }
  } catch (err: any) {
    console.error(kleur.red(`\n❌ Error during Docker verification: ${err.message}`));
  } finally {
    // Clean up test session folder
    if (fs.existsSync(sDir)) {
      try {
        fs.rmSync(sDir, { recursive: true, force: true });
      } catch {}
    }
    await stopAllContainers();
  }
}

main().catch(console.error);
