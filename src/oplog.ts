// Showing jj's recorded command lines in the operation log.

/** Global flags that say how jj ran, not what it did (Jig passes several). */
const NOISE_FLAGS = new Set(["--no-pager", "--quiet", "--ignore-working-copy", "--no-integrate-operation"]);
const NOISE_WITH_VALUE = new Set(["--color", "-R", "--repository", "--config", "--config-file", "--at-op", "--at-operation"]);

/**
 * A command line as it reads best in the log: first line only (commit
 * messages can be long), without global flags like `--no-pager -R <path>`.
 */
export function displayCommand(args: string): string {
  const firstLine = args.split("\n")[0];
  const more = args.includes("\n") ? " …" : "";
  const words = shellWords(firstLine);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const { raw, value } = words[i];
    const flag = value.split("=")[0];
    if (NOISE_FLAGS.has(value)) continue;
    if (NOISE_WITH_VALUE.has(flag)) {
      // Skip the value too, unless it was attached with "=".
      if (!value.includes("=")) i++;
      continue;
    }
    kept.push(raw);
  }
  return kept.join(" ") + more;
}

/**
 * Splits a shell-quoted command line (jj records `--config 'user.name=A B'`)
 * into words, keeping each word's original text for display.
 */
function shellWords(line: string): { raw: string; value: string }[] {
  const words: { raw: string; value: string }[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " ") i++;
    if (i >= line.length) break;
    const start = i;
    let value = "";
    while (i < line.length && line[i] !== " ") {
      const c = line[i];
      if (c === "'" || c === '"') {
        const end = line.indexOf(c, i + 1);
        const close = end < 0 ? line.length : end;
        value += line.slice(i + 1, close);
        i = close + 1;
      } else if (c === "\\" && i + 1 < line.length) {
        value += line[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    words.push({ raw: line.slice(start, i), value });
  }
  return words;
}
