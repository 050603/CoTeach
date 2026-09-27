import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);

/** Private clocked output for a browser shard. Native media still decodes and
 * renders PCM; only its output device is isolated from the host desktop sink.
 * No system configuration or default sink is changed.
 */
export async function createCapacityAudioSink() {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpbl-capacity-audio-'));
  const socket = path.join(directory, 'native');
  const server = `unix:${socket}`;
  const child = spawn('pulseaudio', ['--daemonize=no', '--use-pid-file=no', '--exit-idle-time=-1', '--realtime=no', '--high-priority=no', '--log-level=error', '--log-target=stderr', '-n',
    `--load=module-native-protocol-unix socket=${socket} auth-anonymous=1`, '--load=module-null-sink sink_name=capacity rate=48000 channels=2'],
  { env: { ...process.env, PULSE_RUNTIME_PATH: directory, PULSE_STATE_PATH: directory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(directory, 'no-desktop-dbus')}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
  child.on('error', error => { diagnostic = error.message; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(2000)]); }
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Private audio output exited: ${diagnostic}`);
      try { await execute('pactl', ['--server', server, 'info'], { timeout: 1000 }); return { env: { PULSE_SERVER: server, PULSE_SINK: 'capacity' }, stop }; }
      catch { await delay(100); }
    }
    throw new Error(`Private audio output did not become ready: ${diagnostic}`);
  } catch (error) { await stop(); throw error; }
}
