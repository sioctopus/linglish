const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

async function loadTranscription(env = {}, spawn = () => { throw new Error('Unexpected Python process'); }) {
  const filename = path.resolve(__dirname, '../services/video-transcription.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    require(name) {
      if (name === 'child_process') return { spawn };
      if (name === '../config/ai-config') return { openai: {}, speechToText: {} };
      if (name === '../data-store') return {};
      return localRequire(name);
    },
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env }, console: { log() {}, warn() {} }, Buffer, setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}

function pythonProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill() { this.emit('close', null); },
  });
}

test('local Whisper requires an explicit opt-in before exposing free transcription', async () => {
  for (const enabled of [undefined, '', '0', 'false', 'true']) {
    const service = await loadTranscription({ LOCAL_WHISPER_ENABLED: enabled });
    assert.equal(await service.hasLocalWhisper(), false);
    await assert.rejects(service.transcribeWithLocalWhisper('/unused.wav'), /未启用|disabled/i);
  }
});

test('local Whisper is unavailable when the configured Python runtime lacks its dependencies', async () => {
  const service = await loadTranscription({ LOCAL_WHISPER_ENABLED: '1' }, (binary, args) => {
    assert.equal(binary, 'python3');
    assert.ok(args.includes('--check'));
    const child = pythonProcess();
    process.nextTick(() => child.emit('close', 1));
    return child;
  });
  assert.equal(await service.hasLocalWhisper(), false);
});

test('local Whisper admits one transcription at a time and releases its slot after exit', { timeout: 1500 }, async t => {
  const jobs = [];
  t.after(() => jobs.forEach(child => child.emit('close', 1)));
  const service = await loadTranscription({ LOCAL_WHISPER_ENABLED: '1' }, (_binary, args) => {
    const child = pythonProcess();
    if (args.includes('--check')) process.nextTick(() => child.emit('close', 0));
    else jobs.push(child);
    return child;
  });
  assert.equal(await service.hasLocalWhisper(), true);
  const first = service.transcribeWithLocalWhisper('/first.wav');
  while (!jobs.length) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.transcribeWithLocalWhisper('/second.wav'), error => error.code === 'LOCAL_WHISPER_BUSY' && error.status === 503);
  jobs[0].stdout.end(JSON.stringify({ ok: true, text: 'First.', segments: [], duration: 1 }));
  jobs[0].emit('close', 0);
  assert.equal((await first).text, 'First.');
  const second = service.transcribeWithLocalWhisper('/second.wav');
  while (jobs.length < 2) await new Promise(resolve => setImmediate(resolve));
  jobs[1].stdout.end(JSON.stringify({ ok: true, text: 'Second.', segments: [], duration: 1 }));
  jobs[1].emit('close', 0);
  assert.equal((await second).text, 'Second.');
});

test('timed-out local Whisper keeps its slot until the killed process actually exits', { timeout: 1500 }, async () => {
  let job;
  let killed;
  const killRequested = new Promise(resolve => { killed = resolve; });
  const service = await loadTranscription({ LOCAL_WHISPER_ENABLED: '1', LOCAL_WHISPER_TIMEOUT_MS: '10' }, (_binary, args) => {
    const child = pythonProcess();
    if (args.includes('--check')) process.nextTick(() => child.emit('close', 0));
    else {
      job = child;
      child.kill = signal => { killed(signal); return true; };
    }
    return child;
  });
  const first = service.transcribeWithLocalWhisper('/first.wav');
  const rejection = assert.rejects(first, /超时/);
  assert.equal(await killRequested, 'SIGKILL');
  await assert.rejects(service.transcribeWithLocalWhisper('/second.wav'), error => error.code === 'LOCAL_WHISPER_BUSY');
  job.emit('close', null);
  await rejection;
});

test('decoded Whisper audio accepts ten minutes but rejects excess frames and file bytes before reading samples', async t => {
  if (spawnSync('python3', ['-c', 'import numpy']).status !== 0) return t.skip('Python/numpy is unavailable');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linglish-whisper-limits-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const script = [
    'import importlib.util, os, sys, wave',
    'spec = importlib.util.spec_from_file_location("local_whisper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'filename = os.path.join(sys.argv[2], "audio.wav")',
    'with wave.open(filename, "wb") as wf:',
    '    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)',
    '    wf.writeframes(bytes(600 * 16000 * 2))',
    'assert len(module.load_wav_f32(filename)) == 9600000',
    'with wave.open(filename, "wb") as wf:',
    '    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)',
    '    wf.writeframes(bytes(600 * 16000 * 2 + 2))',
    'wave.Wave_read.readframes = lambda *args: (_ for _ in ()).throw(AssertionError("samples read before validation"))',
    'try: module.load_wav_f32(filename)',
    'except RuntimeError as err: assert "duration" in str(err).lower()',
    'else: raise AssertionError("overlong audio accepted")',
    'with open(filename, "ab") as stream: stream.truncate(32 * 1024 * 1024)',
    'try: module.load_wav_f32(filename)',
    'except RuntimeError as err: assert "size" in str(err).lower()',
    'else: raise AssertionError("oversized audio accepted")',
    'print("bounded")',
  ].join('\n');
  const result = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), temp], { timeout: 10000 });
  assert.equal(result.stdout.trim(), 'bounded');
});

test('Whisper decoding stops at a bounded sentinel duration and rejects longer media', async t => {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
  if (spawnSync(ffmpeg, ['-version']).status !== 0 || spawnSync('python3', ['-c', 'import numpy']).status !== 0) return t.skip('ffmpeg/Python/numpy is unavailable');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linglish-whisper-decode-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const script = [
    'import importlib.util, os, sys, wave',
    'spec = importlib.util.spec_from_file_location("local_whisper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'src = os.path.join(sys.argv[2], "long.wav"); dst = os.path.join(sys.argv[2], "decoded.wav")',
    'with wave.open(src, "wb") as wf:',
    '    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(bytes(620 * 16000 * 2))',
    'module.to_wav_16k_mono(src, dst)',
    'with wave.open(dst, "rb") as wf: assert wf.getnframes() <= 601 * 16000',
    'try: module.load_wav_f32(dst)',
    'except RuntimeError as err: assert "duration" in str(err).lower()',
    'else: raise AssertionError("truncated overlong audio accepted")',
    'print("rejected")',
  ].join('\n');
  const result = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), temp], { env: { ...process.env, FFMPEG_PATH: ffmpeg }, timeout: 10000 });
  assert.equal(result.stdout.trim(), 'rejected');
});

test('Whisper decoding discards untrusted media metadata instead of expanding the temporary WAV', async t => {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
  if (spawnSync(ffmpeg, ['-version']).status !== 0 || spawnSync('python3', ['--version']).status !== 0) return t.skip('ffmpeg/Python is unavailable');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linglish-whisper-metadata-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const script = [
    'import importlib.util, os, struct, sys, wave',
    'spec = importlib.util.spec_from_file_location("local_whisper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'src = os.path.join(sys.argv[2], "tagged.wav"); dst = os.path.join(sys.argv[2], "decoded.wav")',
    'with wave.open(src, "wb") as wf:',
    '    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(bytes(32000))',
    'tag = b"x" * (1024 * 1024 - 1) + b"\\0"',
    'info = b"INFOICMT" + struct.pack("<I", len(tag)) + tag',
    'with open(src, "r+b") as stream:',
    '    stream.seek(0, 2); stream.write(b"LIST" + struct.pack("<I", len(info)) + info)',
    '    size = stream.tell(); stream.seek(4); stream.write(struct.pack("<I", size - 8))',
    'module.to_wav_16k_mono(src, dst)',
    'assert os.path.getsize(dst) < 65536, "metadata copied into decoded WAV"',
    'print("bounded")',
  ].join('\n');
  const result = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), temp], { env: { ...process.env, FFMPEG_PATH: ffmpeg }, timeout: 10000 });
  assert.equal(result.stdout.trim(), 'bounded');
});

test('Whisper command rejects invalid decoded audio before loading transcription dependencies', async t => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('Python is unavailable');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linglish-whisper-command-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const script = [
    'import builtins, importlib.util, json, os, shutil, sys, wave',
    'spec = importlib.util.spec_from_file_location("local_whisper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'src = os.path.join(sys.argv[2], "long.wav")',
    'with wave.open(src, "wb") as wf:',
    '    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000); wf.writeframes(bytes(600 * 16000 * 2 + 2))',
    'module.to_wav_16k_mono = shutil.copyfile',
    'original_import = builtins.__import__',
    'def guarded_import(name, *args, **kwargs):',
    '    if name in ("numpy", "faster_whisper"): raise AssertionError("dependencies loaded before validation")',
    '    return original_import(name, *args, **kwargs)',
    'builtins.__import__ = guarded_import',
    'sys.argv = [sys.argv[1], "--file", src]',
    'assert module.main() == 1',
  ].join('\n');
  const result = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), temp], { timeout: 5000 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /duration/);
});

test('local Whisper rejects playlist uploads that reference another local file', async t => {
  const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
  if (spawnSync(ffmpeg, ['-version']).status !== 0) return t.skip('ffmpeg is unavailable');
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('Python is unavailable');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'linglish-whisper-security-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'uploaded.mp3');
  const privateAudio = Buffer.alloc(44 + 16000);
  privateAudio.write('RIFF'); privateAudio.writeUInt32LE(privateAudio.length - 8, 4);
  privateAudio.write('WAVEfmt ', 8); privateAudio.writeUInt32LE(16, 16);
  privateAudio.writeUInt16LE(1, 20); privateAudio.writeUInt16LE(1, 22);
  privateAudio.writeUInt32LE(8000, 24); privateAudio.writeUInt32LE(16000, 28);
  privateAudio.writeUInt16LE(2, 32); privateAudio.writeUInt16LE(16, 34);
  privateAudio.write('data', 36); privateAudio.writeUInt32LE(16000, 40);
  await fs.writeFile(path.join(temp, 'private.wav'), privateAudio);
  await fs.writeFile(source, "ffconcat version 1.0\nfile 'private.wav'\n");
  const script = [
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("local_whisper", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'try:',
    '    module.to_wav_16k_mono(sys.argv[2], sys.argv[3])',
    '    print("accepted")',
    'except RuntimeError:',
    '    print("rejected")',
  ].join('\n');
  const result = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), source, path.join(temp, 'out.wav')], {
    env: { ...process.env, FFMPEG_PATH: ffmpeg }, timeout: 5000,
  });
  assert.equal(result.stdout.trim(), 'rejected');
  const valid = await promisify(execFile)('python3', ['-c', script, path.resolve(__dirname, '../scripts/local-whisper-transcribe.py'), path.join(temp, 'private.wav'), path.join(temp, 'valid.wav')], {
    env: { ...process.env, FFMPEG_PATH: ffmpeg }, timeout: 5000,
  });
  assert.equal(valid.stdout.trim(), 'accepted', 'ordinary audio remains usable');
});
