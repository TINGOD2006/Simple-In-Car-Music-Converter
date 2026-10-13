/**
 * Minimal in-process test harness.
 *
 * Node's built-in `node --test` spawns a child process per file, which is not
 * available in every environment this project runs in. This runner executes all
 * suites in one process and reports a single summary, so tests always run.
 */

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const cases: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export function assertEq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

export function assertClose(actual: number, expected: number, tol: number, msg: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg}\n  expected: ${expected} +/- ${tol}\n  actual:   ${actual}`);
  }
}

export function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`Expected a throw: ${msg}`);
}

/** Register a whole module's cases by importing it. */
export async function load(mod: Promise<unknown>): Promise<void> {
  await mod;
}

export async function runAll(): Promise<number> {
  let passed = 0;
  const failures: { name: string; error: string }[] = [];

  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      process.stdout.write(`  ok   ${c.name}\n`);
    } catch (err) {
      failures.push({ name: c.name, error: (err as Error).message });
      process.stdout.write(`  FAIL ${c.name}\n`);
    }
  }

  process.stdout.write(`\n${passed}/${cases.length} passed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) {
      process.stdout.write(`\n* ${f.name}\n${f.error.split('\n').map((l) => '    ' + l).join('\n')}\n`);
    }
  }
  return failures.length === 0 ? 0 : 1;
}
