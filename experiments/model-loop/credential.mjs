/** Read a credential without echoing it or writing it to a file. */
export async function readCredential({ envName = 'CQFORGE_MODEL_API_KEY', prompt = 'Model credential' } = {}) {
  if (process.env[envName]) return process.env[envName];
  if (!process.stdin.isTTY) throw Error('Set ' + envName + ' or use an interactive terminal');
  process.stdout.write(prompt + ' (hidden, not saved): ');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume();
    const done = error => {
      process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = bytes => {
      for (const char of bytes.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') { done(Error('Credential input cancelled')); return; }
        if (char === '\r' || char === '\n') { done(value ? null : Error('Empty credential')); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
