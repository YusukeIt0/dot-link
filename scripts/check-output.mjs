// Interpret only recognized gh pr checks failures; undefined means a real error.
export function checksFailureOutput(error) {
  const stdout = String(error.stdout || '').trim();
  const stderr = String(error.stderr || '').trim();
  if ([1, 8].includes(error.status) && stdout.startsWith('[')) return stdout;
  if (error.status === 1 && !stdout &&
      /^no (?:required )?checks reported(?: on the '[^\r\n]+' branch)?$/.test(stderr)) return '[]';
  return undefined;
}
