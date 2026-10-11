'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Puts a file on the Windows clipboard as a real file drop (CF_HDROP / FileDropList), exactly
// like Ctrl+C on a file in Explorer. The script is a constant; the path travels through an
// environment variable, so it is never interpolated into code. The script reads the clipboard
// back and exits non-zero unless the file drop list really contains the file.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$target = $env:DOCK_CLIP_FILE',
  '$done = $false',
  'for ($i = 0; $i -lt 6 -and -not $done; $i++) {',
  '  try {',
  '    $list = New-Object System.Collections.Specialized.StringCollection',
  '    [void]$list.Add($target)',
  '    [System.Windows.Forms.Clipboard]::SetFileDropList($list)',
  '    $back = [System.Windows.Forms.Clipboard]::GetFileDropList()',
  '    if ($back.Count -eq 1 -and $back[0] -ieq $target) { $done = $true }',
  '  } catch { Start-Sleep -Milliseconds 150 }',
  '}',
  'if (-not $done) { [Console]::Error.WriteLine("clipboard verification failed"); exit 3 }'
].join('\n');

function powershellPath(env = process.env) {
  const root = env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function copyFileToClipboard(filePath, { timeoutMs = 20_000, env = process.env } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Clipboard de arquivos so e suportado no Windows.' });
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return resolve({ ok: false, error: 'Caminho invalido para o clipboard.' });
    const child = spawn(powershellPath(env), ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], {
      env: { ...env, DOCK_CLIP_FILE: filePath }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill(); finish({ ok: false, error: 'Tempo limite ao copiar o arquivo para o clipboard.' }); }, timeoutMs);
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, error: `Falha ao iniciar o PowerShell: ${error.message}` }));
    child.on('close', (code) => finish(code === 0
      ? { ok: true }
      : { ok: false, error: `Clipboard de arquivo nao confirmado (codigo ${code}). ${stderr.trim().split(/\r?\n/)[0] || ''}`.trim() }));
  });
}

module.exports = { copyFileToClipboard, SCRIPT };
