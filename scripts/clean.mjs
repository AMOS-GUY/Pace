import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

for (const group of ['packages', 'apps']) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    for (const target of ['dist', 'tsconfig.tsbuildinfo', 'coverage']) {
      rmSync(join(group, name, target), { recursive: true, force: true });
    }
  }
}
