// Pull the live corpus again so the build can be checked against the source
// rather than against the copy it was built from.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'verify';
mkdirSync(OUT, { recursive: true });

const langs = (await (await fetch('https://songbase.life/api/v2/languages', {
  headers: { Accept: 'application/json' },
})).json()).languages;

writeFileSync(join(OUT, 'languages.json'), JSON.stringify({ languages: langs }));
console.log(`${langs.length} languages`);

let total = 0;
for (const lang of langs) {
  const q = new URLSearchParams({ updated_at: 0, language: lang });
  const res = await fetch(`https://songbase.life/api/v2/app_data?${q}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} for ${lang}`);
  const raw = await res.text();
  writeFileSync(join(OUT, `lang_${encodeURIComponent(lang)}.json`), raw);
  const d = JSON.parse(raw);
  total += d.songs.length;
  console.log(`  ${lang.padEnd(18)} ${String(d.songs.length).padStart(5)} songs`);
}
console.log(`\ntotal from live API: ${total}`);
